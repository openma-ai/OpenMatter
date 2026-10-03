import type {
  AgentSession,
  ContextProjection,
  EffectDeliveryReceipt,
  PermissionDecision,
  Reaction,
  ReactionReceipt,
  ThreadGoal,
  Turn,
  TurnCancellationRequest,
  WorkEvent,
} from "@openmatter/core";
import { ThreadGoalStatusSchema } from "@openmatter/core";
import type { OpenMAEvent } from "@openmatter/agent";
import {
  StoreError,
  type AccountThreadGoalInput,
  type CreateThreadGoalInput,
  type LeaseRequest,
  type LeaseRenewal,
  type OpenMatterStore,
  type StoreSnapshot,
  type UpdateThreadGoalInput,
  type WorkLease,
} from "@openmatter/store";
import { Effect, Schema } from "effect";

export interface MemoryStoreOptions {
  readonly makeLeaseToken?: () => string;
  /** Test/embedded clock. Production adapters must use their storage engine's
   * authoritative time inside the claim/renew transaction. */
  readonly clock?: () => string;
}

export interface MemoryStore extends OpenMatterStore {
  readonly inspect: Effect.Effect<StoreSnapshot>;
}

export const makeMemoryStore = (
  options: MemoryStoreOptions = {},
): MemoryStore => {
  const events = new Map<string, WorkEvent>();
  const claims = new Map<
    string,
    { readonly eventId: string; readonly lease: WorkLease }
  >();
  const claimKeyByEvent = new Map<string, string>();
  const reactions = new Map<string, Reaction>();
  const deliveries = new Map<string, EffectDeliveryReceipt>();
  const effectClaims = new Map<
    string,
    { readonly lease: WorkLease; readonly attempt: number }
  >();
  const sessions = new Map<string, AgentSession>();
  const activeSessionByBinding = new Map<string, string>();
  const sessionClaims = new Map<string, WorkLease>();
  const turns = new Map<string, Turn>();
  const contexts = new Map<string, ContextProjection>();
  const agentEvents: OpenMAEvent[] = [];
  const permissionDecisions = new Map<string, PermissionDecision>();
  const goals = new Map<string, ThreadGoal>();
  const goalUsage = new Map<string, AccountThreadGoalInput>();
  const cancellations = new Map<string, TurnCancellationRequest>();
  let leaseSequence = 0;
  const clock = options.clock ?? (() => new Date().toISOString());

  // A durable adapter serializes values. Copying at this reference boundary
  // prevents JavaScript object identity from becoming an accidental write API.
  const copy = <A>(value: A): A => structuredClone(value);

  const makeLease = (
    request: LeaseRequest,
    revision: number,
    now: string,
  ): WorkLease => ({
    token: options.makeLeaseToken?.() ?? `memory-lease-${++leaseSequence}`,
    ownerId: request.ownerId,
    expiresAt: new Date(Date.parse(now) + request.durationMs).toISOString(),
    revision,
  });

  const expired = (lease: WorkLease, now: string) =>
    Date.parse(lease.expiresAt) <= Date.parse(now);

  const renewLease = (
    lease: WorkLease | undefined,
    leaseToken: string,
    renewal: LeaseRenewal,
    label: string,
    now: string,
  ): WorkLease => {
    if (lease?.token !== leaseToken || expired(lease, now)) {
      throw new StoreError({ message: `Invalid or expired ${label} lease` });
    }
    return {
      ...lease,
      expiresAt: new Date(Date.parse(now) + renewal.durationMs).toISOString(),
    };
  };

  const storeTry = <A>(operation: () => A) =>
    Effect.try({
      try: operation,
      catch: (cause) =>
        cause instanceof StoreError
          ? cause
          : new StoreError({ message: "Memory store operation failed", cause }),
    });

  const assertSessionLease = (bindingKey: string, leaseToken: string) => {
    if (sessionClaims.get(bindingKey)?.token !== leaseToken) {
      throw new StoreError({
        message: `Invalid or stale session lease for ${bindingKey}`,
      });
    }
  };

  const fail = (message: string): never => {
    throw new StoreError({ message });
  };
  const goalObjective = (objective: string) => {
    const normalized = objective.trim();
    if (!normalized) fail("Goal objective must not be blank");
    return normalized;
  };
  const goalBudget = (budget: number | undefined) => {
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0))
      fail("Goal token budget must be a positive safe integer");
  };
  const requireGoal = (
    workThreadId: string,
    expectedGoalId?: string,
  ): ThreadGoal => {
    const goal = goals.get(workThreadId);
    if (!goal) return fail(`No goal for WorkThread ${workThreadId}`);
    if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
      fail("Stale goal identity");
    return goal;
  };
  const activeTurnsFor = (sessionId: string) =>
    [...turns.values()]
      .filter(
        (turn) =>
          turn.sessionId === sessionId &&
          (turn.state === "queued" || turn.state === "running"),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const receiptFor = (eventId: string): ReactionReceipt | undefined => {
    const reaction = reactions.get(eventId);
    if (reaction === undefined) return undefined;

    return {
      reaction: copy(reaction),
      deliveries: reaction.effects.flatMap((effect) => {
        const receipt = deliveries.get(effect.id);
        return receipt === undefined ? [] : [copy(receipt)];
      }),
      duplicate: false,
    };
  };

  return {
    claimEvent: (event, request) =>
      storeTry(() => {
        const now = clock();
        const current = claims.get(event.idempotencyKey);
        if (current !== undefined) {
          const receipt = receiptFor(current.eventId);
          if (receipt !== undefined) {
            return { _tag: "Terminal", receipt } as const;
          }
          if (!expired(current.lease, now)) {
            return { _tag: "Busy", lease: current.lease } as const;
          }

          const lease = makeLease(request, current.lease.revision + 1, now);
          claims.set(event.idempotencyKey, {
            eventId: current.eventId,
            lease,
          });
          return {
            _tag: "Acquired",
            lease,
            event: copy(events.get(current.eventId) ?? event),
          } as const;
        }

        const lease = makeLease(request, 1, now);
        claims.set(event.idempotencyKey, { eventId: event.id, lease });
        claimKeyByEvent.set(event.id, event.idempotencyKey);
        const durableEvent = copy(event);
        events.set(event.id, durableEvent);
        return { _tag: "Acquired", lease, event: copy(durableEvent) } as const;
      }),

    commitTerminalReaction: (reaction, leaseToken) =>
      storeTry(() => {
        const claimKey = claimKeyByEvent.get(reaction.eventId);
        const claim = claimKey === undefined ? undefined : claims.get(claimKey);
        if (claim?.lease.token !== leaseToken) {
          throw new StoreError({
            message: `Invalid or stale event lease for ${reaction.eventId}`,
          });
        }
        const existing = reactions.get(reaction.eventId);
        if (existing !== undefined) {
          return { _tag: "Existing", reaction: copy(existing) } as const;
        }
        const durableReaction = copy(reaction);
        reactions.set(reaction.eventId, durableReaction);
        return {
          _tag: "Committed",
          reaction: copy(durableReaction),
        } as const;
      }),

    renewEventLease: (eventId, leaseToken, renewal) =>
      storeTry(() => {
        const now = clock();
        const claimKey = claimKeyByEvent.get(eventId);
        const claim = claimKey === undefined ? undefined : claims.get(claimKey);
        if (claimKey === undefined || claim === undefined) {
          throw new StoreError({ message: `Unknown event claim: ${eventId}` });
        }
        claims.set(claimKey, {
          ...claim,
          lease: renewLease(claim.lease, leaseToken, renewal, "event", now),
        });
      }),

    claimPendingEffects: (request) =>
      storeTry(() => {
        const now = clock();
        const pending = [...reactions.values()]
          .filter(
            (reaction) =>
              request.eventId === undefined ||
              reaction.eventId === request.eventId,
          )
          .flatMap((reaction) => reaction.effects)
          .filter((effect) => {
            const receipt = deliveries.get(effect.id);
            if (receipt === undefined) return true;
            if (
              receipt.status === "delivered" ||
              receipt.status === "terminal-failed"
            ) {
              return false;
            }
            return (
              receipt.nextRetryAt === undefined ||
              Date.parse(receipt.nextRetryAt) <= Date.parse(now)
            );
          })
          .sort((left, right) =>
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
          );
        const claimed = [];

        for (const effect of pending) {
          if (claimed.length >= request.limit) break;
          const current = effectClaims.get(effect.id);
          if (current !== undefined && !expired(current.lease, now)) {
            continue;
          }
          const attempt =
            Math.max(
              current?.attempt ?? 0,
              deliveries.get(effect.id)?.attempt ?? 0,
            ) + 1;
          const lease = makeLease(
            request,
            (current?.lease.revision ?? 0) + 1,
            now,
          );
          effectClaims.set(effect.id, { lease, attempt });
          claimed.push({ effect: copy(effect), attempt, lease });
        }
        return claimed;
      }),

    recordDelivery: (receipt, leaseToken) =>
      storeTry(() => {
        const claim = effectClaims.get(receipt.effectId);
        if (claim?.lease.token !== leaseToken) {
          throw new StoreError({
            message: `Invalid or stale effect lease for ${receipt.effectId}`,
          });
        }
        deliveries.set(receipt.effectId, copy(receipt));
        effectClaims.delete(receipt.effectId);
      }),

    renewEffectLease: (effectId, leaseToken, renewal) =>
      storeTry(() => {
        const now = clock();
        const claim = effectClaims.get(effectId);
        if (claim === undefined) {
          throw new StoreError({
            message: `Unknown effect claim: ${effectId}`,
          });
        }
        effectClaims.set(effectId, {
          ...claim,
          lease: renewLease(claim.lease, leaseToken, renewal, "effect", now),
        });
      }),

    getReceipt: (eventId) => Effect.sync(() => receiptFor(eventId)),

    claimSession: (bindingKey, request) =>
      storeTry(() => {
        const now = clock();
        const current = sessionClaims.get(bindingKey);
        if (current !== undefined && !expired(current, now)) {
          return { _tag: "Busy", lease: current } as const;
        }
        const lease = makeLease(request, (current?.revision ?? 0) + 1, now);
        sessionClaims.set(bindingKey, lease);
        const sessionId = activeSessionByBinding.get(bindingKey);
        const session =
          sessionId === undefined ? undefined : sessions.get(sessionId);
        return {
          _tag: "Acquired",
          lease,
          ...(session === undefined ? {} : { session: copy(session) }),
        } as const;
      }),

    saveSession: (session, leaseToken) =>
      storeTry(() => {
        if (sessionClaims.get(session.bindingKey)?.token !== leaseToken) {
          throw new StoreError({
            message: `Invalid or stale session lease for ${session.bindingKey}`,
          });
        }
        const previousId = activeSessionByBinding.get(session.bindingKey);
        if (previousId !== undefined && previousId !== session.id) {
          const previous = sessions.get(previousId);
          if (previous !== undefined) {
            sessions.set(previousId, {
              ...previous,
              state: ["open", "creating"].includes(previous.state)
                ? "closed"
                : previous.state,
            });
          }
        }
        sessions.set(session.id, copy(session));
        activeSessionByBinding.set(session.bindingKey, session.id);
      }),

    getSession: (sessionId) =>
      Effect.sync(() => {
        const session = sessions.get(sessionId);
        return session === undefined ? undefined : copy(session);
      }),

    renewSessionLease: (bindingKey, leaseToken, renewal) =>
      storeTry(() => {
        const now = clock();
        const lease = sessionClaims.get(bindingKey);
        sessionClaims.set(
          bindingKey,
          renewLease(lease, leaseToken, renewal, "session", now),
        );
      }),

    releaseSession: (bindingKey, leaseToken) =>
      storeTry(() => {
        if (sessionClaims.get(bindingKey)?.token !== leaseToken) {
          throw new StoreError({
            message: `Invalid or stale session lease for ${bindingKey}`,
          });
        }
        sessionClaims.delete(bindingKey);
      }),

    saveTurn: (turn, bindingKey, leaseToken) =>
      storeTry(() => {
        assertSessionLease(bindingKey, leaseToken);
        const terminalEvent = agentEvents.find(
          (event) =>
            event.turn_id === turn.id &&
            [
              "turn.completed",
              "turn.failed",
              "turn.cancelled",
              "turn.interrupted",
            ].includes(event.type),
        );
        if (terminalEvent !== undefined) {
          const terminalState =
            terminalEvent.type === "turn.interrupted"
              ? "cancelled"
              : terminalEvent.type.slice("turn.".length);
          if (turn.state !== terminalState) return;
        }
        turns.set(turn.id, copy(turn));
      }),

    getTurn: (turnId) =>
      Effect.sync(() => {
        const turn = turns.get(turnId);
        return turn === undefined ? undefined : copy(turn);
      }),

    getAgentEvents: (turnId) =>
      Effect.sync(() =>
        agentEvents
          .filter((event) => event.turn_id === turnId)
          .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
          .map(copy),
      ),

    getPermissionDecision: (turnId, requestId) =>
      Effect.sync(() => {
        const decision = permissionDecisions.get(
          JSON.stringify([turnId, requestId]),
        );
        return decision === undefined ? undefined : copy(decision);
      }),

    commitPermissionDecision: (decision, bindingKey, leaseToken) =>
      storeTry(() => {
        assertSessionLease(bindingKey, leaseToken);
        const key = JSON.stringify([decision.turnId, decision.requestId]);
        const existing = permissionDecisions.get(key);
        if (existing !== undefined) return copy(existing);
        const durableDecision = copy(decision);
        permissionDecisions.set(key, durableDecision);
        return copy(durableDecision);
      }),

    appendAgentEvent: (event, bindingKey, leaseToken) =>
      storeTry(() => {
        assertSessionLease(bindingKey, leaseToken);
        const existing = agentEvents.find(
          (candidate) =>
            candidate.turn_id === event.turn_id && candidate.seq === event.seq,
        );
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new StoreError({
              message: `Conflicting Agent event for ${event.turn_id} sequence ${event.seq}`,
            });
          }
          return;
        }
        agentEvents.push(copy(event));
      }),

    createThreadGoal: (input: CreateThreadGoalInput) =>
      storeTry(() => {
        if (!input.scopeId.trim() || !input.workThreadId.trim())
          fail("Goal scope and WorkThread identities must not be blank");
        const objective = goalObjective(input.objective);
        goalBudget(input.tokenBudget);
        const existing = goals.get(input.workThreadId);
        if (existing && existing.scopeId !== input.scopeId)
          fail("Goal WorkThread belongs to another scope");
        if (existing && existing.status !== "complete")
          fail("WorkThread already has an unfinished goal");
        const now = clock();
        const goal: ThreadGoal = {
          id: globalThis.crypto.randomUUID(),
          scopeId: input.scopeId,
          workThreadId: input.workThreadId,
          objective,
          status: "active",
          ...(input.tokenBudget === undefined
            ? {}
            : { tokenBudget: input.tokenBudget }),
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        if (existing) {
          for (const key of [...goalUsage.keys()]) {
            if (key.startsWith(`${existing.id}:`)) goalUsage.delete(key);
          }
          goals.delete(input.workThreadId);
        }
        goals.set(input.workThreadId, goal);
        return copy(goal);
      }),

    getThreadGoal: (workThreadId) =>
      Effect.sync(() => {
        const goal = goals.get(workThreadId);
        return goal === undefined ? undefined : copy(goal);
      }),

    listThreadGoals: (scopeId) =>
      Effect.sync(() =>
        [...goals.values()]
          .filter((goal) => scopeId === undefined || goal.scopeId === scopeId)
          .map(copy),
      ),

    updateThreadGoal: (workThreadId, input: UpdateThreadGoalInput) =>
      storeTry(() => {
        const goal = requireGoal(workThreadId, input.expectedGoalId);
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== goal.revision
        )
          fail("Stale goal revision");
        const objective =
          input.objective === undefined
            ? goal.objective
            : goalObjective(input.objective);
        const tokenBudget =
          input.tokenBudget === undefined
            ? goal.tokenBudget
            : (input.tokenBudget ?? undefined);
        goalBudget(tokenBudget);
        let status = input.status ?? goal.status;
        if (!Schema.is(ThreadGoalStatusSchema)(status))
          fail("Invalid goal status");
        if (
          status === "active" &&
          tokenBudget !== undefined &&
          goal.tokensUsed >= tokenBudget
        )
          status = "budget_limited";
        const reason =
          input.reason === undefined
            ? input.status === "active" || input.status === "complete"
              ? undefined
              : goal.reason
            : input.reason.trim() || undefined;
        if (
          objective === goal.objective &&
          tokenBudget === goal.tokenBudget &&
          status === goal.status &&
          reason === goal.reason
        )
          return copy(goal);
        const { tokenBudget: _budget, reason: _reason, ...base } = goal;
        const updated: ThreadGoal = {
          ...base,
          objective,
          status,
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
          ...(reason === undefined ? {} : { reason }),
          updatedAt: clock(),
          revision: goal.revision + 1,
        };
        goals.set(workThreadId, updated);
        return copy(updated);
      }),

    accountThreadGoal: (workThreadId, input) =>
      storeTry(() => {
        const goal = requireGoal(workThreadId, input.goalId);
        if (!input.turnId.trim()) fail("Goal usage requires a Turn identity");
        for (const value of [input.tokensUsed, input.timeUsedSeconds]) {
          if (!Number.isSafeInteger(value) || value < 0)
            fail("Goal usage must be nonnegative safe integers");
        }
        const id = `${goal.id}:${input.turnId}`;
        const existing = goalUsage.get(id);
        if (existing) {
          if (
            existing.tokensUsed !== input.tokensUsed ||
            existing.timeUsedSeconds !== input.timeUsedSeconds
          )
            fail("Conflicting goal usage for Turn");
          return copy(goal);
        }
        const tokensUsed = goal.tokensUsed + input.tokensUsed;
        const timeUsedSeconds = goal.timeUsedSeconds + input.timeUsedSeconds;
        if (
          !Number.isSafeInteger(tokensUsed) ||
          !Number.isSafeInteger(timeUsedSeconds)
        )
          fail("Goal usage exceeds safe integer range");
        const updated: ThreadGoal = {
          ...goal,
          tokensUsed,
          timeUsedSeconds,
          status:
            goal.status === "active" &&
            goal.tokenBudget !== undefined &&
            tokensUsed >= goal.tokenBudget
              ? "budget_limited"
              : goal.status,
          updatedAt: clock(),
          revision: goal.revision + 1,
        };
        goalUsage.set(id, copy(input));
        goals.set(workThreadId, updated);
        return copy(updated);
      }),

    clearThreadGoal: (workThreadId, expectedGoalId) =>
      storeTry(() => {
        const goal = goals.get(workThreadId);
        if (!goal) return false;
        if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
          fail("Stale goal identity");
        for (const key of [...goalUsage.keys()]) {
          if (key.startsWith(`${goal.id}:`)) goalUsage.delete(key);
        }
        goals.delete(workThreadId);
        return true;
      }),

    requestTurnCancellation: (bindingKey, requestedByEventId, requestedAt) =>
      storeTry(() => {
        const sessionId = activeSessionByBinding.get(bindingKey);
        if (sessionId === undefined) return undefined;
        const turn = activeTurnsFor(sessionId)[0];
        if (turn === undefined) return undefined;
        const existing = cancellations.get(turn.id);
        if (existing !== undefined) return copy(existing);
        const value: TurnCancellationRequest = {
          turnId: turn.id,
          sessionId,
          bindingKey,
          requestedByEventId,
          requestedAt,
        };
        cancellations.set(turn.id, value);
        return copy(value);
      }),

    getTurnCancellation: (turnId) =>
      Effect.sync(() => {
        const value = cancellations.get(turnId);
        return value === undefined ? undefined : copy(value);
      }),

    saveContext: (context) =>
      Effect.sync(() => {
        contexts.set(context.id, copy(context));
      }),

    getContext: (contextId) =>
      Effect.sync(() => {
        const context = contexts.get(contextId);
        return context === undefined ? undefined : copy(context);
      }),

    inspect: Effect.sync(() => ({
      goals: [...goals.values()].map(copy),
      events: [...events.values()].map(copy),
      reactions: [...reactions.values()].map(copy),
      deliveries: [...deliveries.values()].map(copy),
      sessions: [...sessions.values()].map(copy),
      turns: [...turns.values()].map(copy),
      turnCancellationRequests: [...cancellations.values()].map(copy),
      contexts: [...contexts.values()].map(copy),
      agentEvents: agentEvents.map(copy),
      permissionDecisions: [...permissionDecisions.values()].map(copy),
    })),
  };
};
