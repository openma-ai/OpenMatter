import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  JsonValueSchema,
  type AgentSession,
  type ContextProjection,
  type EffectDeliveryReceipt,
  type PermissionDecision,
  type Reaction,
  type ThreadGoal,
  type Turn,
  type TurnCancellationRequest,
  type WorkEvent,
} from "@openmatter/core";
import type { OpenMAEvent } from "@openmatter/agent";
import {
  StoreError,
  type AccountThreadGoalInput,
  type OpenMatterStore,
  type StoreSnapshot,
  type LeaseRequest,
  type WorkLease,
  type PendingEffectClaim,
} from "@openmatter/store";
import { ThreadGoalStatusSchema } from "@openmatter/core";
import { Effect, Schema } from "effect";

export interface SqliteStore extends OpenMatterStore {
  readonly close: Effect.Effect<void, StoreError>;
  readonly inspect: Effect.Effect<StoreSnapshot, StoreError>;
  /** A read model of existing facts; business IDs belong in Scope/WorkThread. */
  readonly inspectScope: (
    scopeId: string,
  ) => Effect.Effect<StoreSnapshot, StoreError>;
}
export type SqliteStoreOptions =
  { readonly filename: string } | { readonly database: DatabaseSync };
type Row = { data: string };
type LeaseRow = {
  token: string;
  owner_id: string;
  expires_ms: number;
  revision: number;
};

/** SQLite persistence only. Scheduling, association and turn execution stay in runtime. */
export const makeSqliteStore = (options: SqliteStoreOptions): SqliteStore => {
  const owned = "filename" in options;
  const db =
    "database" in options
      ? options.database
      : new DatabaseSync(options.filename);
  db.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS openmatter_store_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT, parent_id TEXT,
      unique_key TEXT, data TEXT NOT NULL, PRIMARY KEY(kind, id), UNIQUE(kind, unique_key)
    );
    CREATE INDEX IF NOT EXISTS openmatter_store_scope ON openmatter_store_records(kind, scope_id);
    CREATE INDEX IF NOT EXISTS openmatter_store_parent ON openmatter_store_records(kind, parent_id);
    CREATE TABLE IF NOT EXISTS openmatter_store_leases (
      kind TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, owner_id TEXT NOT NULL,
      expires_ms INTEGER NOT NULL, revision INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(kind, id)
    );
    CREATE TABLE IF NOT EXISTS openmatter_store_bindings (binding_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
  `);
  let closed = false;
  const fail = (message: string): never => {
    throw new StoreError({ message });
  };
  const encode = (value: unknown): string => {
    if (!Schema.is(JsonValueSchema)(value))
      return fail("Store facts must be portable JSON");
    return JSON.stringify(value);
  };
  const read = <T>(sql: string, ...params: SQLInputValue[]): T | undefined => {
    const row = db.prepare(sql).get(...params) as Row | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  };
  const get = <T>(kind: string, id: string) =>
    read<T>(
      "SELECT data FROM openmatter_store_records WHERE kind=? AND id=?",
      kind,
      id,
    );
  const rows = <T>(
    kind: string,
    clause = "",
    params: SQLInputValue[] = [],
  ): T[] =>
    (
      db
        .prepare(
          `SELECT data FROM openmatter_store_records WHERE kind=? ${clause} ORDER BY rowid`,
        )
        .all(kind, ...params) as Row[]
    ).map((row) => JSON.parse(row.data) as T);
  const put = (
    kind: string,
    id: string,
    value: unknown,
    scope: string | null = null,
    parent: string | null = null,
    key: string | null = null,
  ) => {
    db.prepare(
      `INSERT INTO openmatter_store_records(kind,id,scope_id,parent_id,unique_key,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, scope_id=excluded.scope_id, parent_id=excluded.parent_id, unique_key=excluded.unique_key`,
    ).run(kind, id, scope, parent, key, encode(value));
  };
  const remove = (kind: string, id: string) =>
    db
      .prepare("DELETE FROM openmatter_store_records WHERE kind=? AND id=?")
      .run(kind, id);
  const op = <T>(body: () => T, write = false): Effect.Effect<T, StoreError> =>
    Effect.try({
      try: () => {
        if (closed) return fail("SQLite store is closed");
        db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
          const result = body();
          db.exec("COMMIT");
          return result;
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof StoreError
          ? cause
          : new StoreError({ message: "SQLite store operation failed", cause }),
    });
  const clock = () =>
    Number(
      (
        db
          .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now")
          .get() as { now: number }
      ).now,
    );
  const leaseRow = (kind: string, id: string) =>
    db
      .prepare("SELECT * FROM openmatter_store_leases WHERE kind=? AND id=?")
      .get(kind, id) as LeaseRow | undefined;
  const asLease = (row: LeaseRow): WorkLease => ({
    token: row.token,
    ownerId: row.owner_id,
    expiresAt: new Date(row.expires_ms).toISOString(),
    revision: row.revision,
  });
  const duration = (ms: number) => {
    if (!Number.isSafeInteger(ms) || ms <= 0)
      fail("Lease duration must be a positive integer");
    return ms;
  };
  const acquire = (
    kind: string,
    id: string,
    request: LeaseRequest,
    attempt = 0,
  ): WorkLease => {
    const row = leaseRow(kind, id);
    const next: LeaseRow = {
      token: randomUUID(),
      owner_id: request.ownerId,
      expires_ms: clock() + duration(request.durationMs),
      revision: (row?.revision ?? 0) + 1,
    };
    db.prepare(
      `INSERT INTO openmatter_store_leases VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
      token=excluded.token,owner_id=excluded.owner_id,expires_ms=excluded.expires_ms,revision=excluded.revision,attempt=excluded.attempt`,
    ).run(
      kind,
      id,
      next.token,
      next.owner_id,
      next.expires_ms,
      next.revision,
      attempt,
    );
    return asLease(next);
  };
  const fence = (kind: string, id: string, token: string) => {
    const row = leaseRow(kind, id);
    if (!row || row.token !== token || row.expires_ms <= clock())
      return fail(`Invalid, expired or stale ${kind} lease: ${id}`);
    return row;
  };
  const renew = (kind: string, id: string, token: string, ms: number) =>
    op(() => {
      fence(kind, id, token);
      db.prepare(
        "UPDATE openmatter_store_leases SET expires_ms=? WHERE kind=? AND id=?",
      ).run(clock() + duration(ms), kind, id);
    }, true);
  const release = (kind: string, id: string) => {
    db.prepare(
      "UPDATE openmatter_store_leases SET expires_ms=0 WHERE kind=? AND id=?",
    ).run(kind, id);
  };
  const activeSession = (key: string): AgentSession | undefined => {
    const row = db
      .prepare(
        "SELECT session_id FROM openmatter_store_bindings WHERE binding_key=?",
      )
      .get(key) as { session_id: string } | undefined;
    return row ? get<AgentSession>("session", row.session_id) : undefined;
  };
  const receipt = (eventId: string) => {
    const reaction = get<Reaction>("reaction", eventId);
    return reaction
      ? {
          reaction,
          deliveries: reaction.effects.flatMap((effect) => {
            const result = get<EffectDeliveryReceipt>("delivery", effect.id);
            return result ? [result] : [];
          }),
          duplicate: false,
        }
      : undefined;
  };
  const goalByThread = (workThreadId: string): ThreadGoal | undefined =>
    read<ThreadGoal>(
      "SELECT data FROM openmatter_store_records WHERE kind='goal' AND unique_key=?",
      workThreadId,
    );
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
    const goal = goalByThread(workThreadId);
    if (!goal) return fail(`No goal for WorkThread ${workThreadId}`);
    if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
      fail("Stale goal identity");
    return goal;
  };
  const goalUsageId = (goalId: string, turnId: string) => `${goalId}:${turnId}`;
  const removeGoalUsage = (goalId: string) =>
    db
      .prepare(
        "DELETE FROM openmatter_store_records WHERE kind='goalUsage' AND parent_id=?",
      )
      .run(goalId);
  const snapshot = (scopeId?: string): StoreSnapshot => {
    const scopeClause = scopeId === undefined ? "" : "AND scope_id=?";
    const params = scopeId === undefined ? [] : [scopeId];
    const contexts = rows<ContextProjection>("context", scopeClause, params);
    const sessions = rows<AgentSession>("session", scopeClause, params);
    const sessionIds = new Set(sessions.map((s) => s.id));
    const turns = rows<Turn>("turn").filter(
      (t) => scopeId === undefined || sessionIds.has(t.sessionId),
    );
    const turnIds = new Set(turns.map((t) => t.id));
    const eventIds = new Set([
      ...contexts.map((c) => c.triggerEventId),
      ...turns.map((t) => t.triggerEventId),
    ]);
    const events = rows<WorkEvent>("event").filter(
      (e) =>
        scopeId === undefined ||
        eventIds.has(e.id) ||
        e.source.conversationId === scopeId,
    );
    for (const e of events) eventIds.add(e.id);
    const reactions = rows<Reaction>("reaction").filter(
      (r) => scopeId === undefined || eventIds.has(r.eventId),
    );
    const effectIds = new Set(
      reactions.flatMap((r) => r.effects.map((e) => e.id)),
    );
    return {
      goals: rows<ThreadGoal>("goal", scopeClause, params),
      contexts,
      sessions,
      turns,
      events,
      reactions,
      deliveries: rows<EffectDeliveryReceipt>("delivery").filter(
        (d) => scopeId === undefined || effectIds.has(d.effectId),
      ),
      agentEvents: rows<OpenMAEvent>("agentEvent").filter(
        (e) => scopeId === undefined || turnIds.has(e.turn_id ?? ""),
      ),
      permissionDecisions: rows<PermissionDecision>("permission").filter(
        (d) => scopeId === undefined || turnIds.has(d.turnId),
      ),
      turnCancellationRequests: rows<TurnCancellationRequest>(
        "cancellation",
      ).filter((c) => scopeId === undefined || turnIds.has(c.turnId)),
    };
  };
  const store: SqliteStore = {
    close: Effect.try({
      try: () => {
        if (!closed) {
          if (owned) db.close();
          closed = true;
        }
      },
      catch: (cause) =>
        new StoreError({ message: "Unable to close SQLite store", cause }),
    }),
    inspect: op(() => snapshot()),
    inspectScope: (scope) => op(() => snapshot(scope)),
    createThreadGoal: (input) =>
      op(() => {
        if (!input.scopeId.trim() || !input.workThreadId.trim())
          fail("Goal scope and WorkThread identities must not be blank");
        const objective = goalObjective(input.objective);
        goalBudget(input.tokenBudget);
        const existing = goalByThread(input.workThreadId);
        if (existing && existing.scopeId !== input.scopeId)
          fail("Goal WorkThread belongs to another scope");
        if (existing && existing.status !== "complete")
          fail("WorkThread already has an unfinished goal");
        const now = new Date(clock()).toISOString();
        const goal: ThreadGoal = {
          id: randomUUID(),
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
          removeGoalUsage(existing.id);
          remove("goal", existing.id);
        }
        put(
          "goal",
          goal.id,
          goal,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return goal;
      }, true),
    getThreadGoal: (workThreadId) => op(() => goalByThread(workThreadId)),
    listThreadGoals: (scopeId) =>
      op(() =>
        scopeId === undefined
          ? rows<ThreadGoal>("goal")
          : rows<ThreadGoal>("goal", "AND scope_id=?", [scopeId]),
      ),
    updateThreadGoal: (workThreadId, input) =>
      op(() => {
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
          return goal;
        const { tokenBudget: _budget, reason: _reason, ...base } = goal;
        const updated: ThreadGoal = {
          ...base,
          objective,
          status,
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
          ...(reason === undefined ? {} : { reason }),
          updatedAt: new Date(clock()).toISOString(),
          revision: goal.revision + 1,
        };
        put(
          "goal",
          goal.id,
          updated,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return updated;
      }, true),
    accountThreadGoal: (workThreadId, input: AccountThreadGoalInput) =>
      op(() => {
        const goal = requireGoal(workThreadId, input.goalId);
        if (!input.turnId.trim()) fail("Goal usage requires a Turn identity");
        for (const value of [input.tokensUsed, input.timeUsedSeconds]) {
          if (!Number.isSafeInteger(value) || value < 0)
            fail("Goal usage must be nonnegative safe integers");
        }
        const id = goalUsageId(goal.id, input.turnId);
        const existing = get<AccountThreadGoalInput>("goalUsage", id);
        if (existing) {
          if (
            existing.tokensUsed !== input.tokensUsed ||
            existing.timeUsedSeconds !== input.timeUsedSeconds
          )
            fail("Conflicting goal usage for Turn");
          return goal;
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
          updatedAt: new Date(clock()).toISOString(),
          revision: goal.revision + 1,
        };
        put("goalUsage", id, input, goal.scopeId, goal.id, id);
        put(
          "goal",
          goal.id,
          updated,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return updated;
      }, true),
    clearThreadGoal: (workThreadId, expectedGoalId) =>
      op(() => {
        const goal = goalByThread(workThreadId);
        if (!goal) return false;
        if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
          fail("Stale goal identity");
        removeGoalUsage(goal.id);
        remove("goal", goal.id);
        return true;
      }, true),
    claimEvent: (event, request) =>
      op(() => {
        const existing = read<WorkEvent>(
          "SELECT data FROM openmatter_store_records WHERE kind='event' AND unique_key=?",
          event.idempotencyKey,
        );
        const fact = existing ?? event;
        const terminal = receipt(fact.id);
        if (terminal) return { _tag: "Terminal", receipt: terminal } as const;
        const current = leaseRow("event", fact.id);
        if (current && current.expires_ms > clock())
          return { _tag: "Busy", lease: asLease(current) } as const;
        if (!existing) {
          if (get("event", fact.id))
            return fail(
              "Event ID already belongs to a different idempotency key",
            );
          put(
            "event",
            fact.id,
            fact,
            fact.source.conversationId ?? null,
            null,
            fact.idempotencyKey,
          );
        }
        return {
          _tag: "Acquired",
          event: fact,
          lease: acquire("event", fact.id, request),
        } as const;
      }, true),
    commitTerminalReaction: (reaction, token) =>
      op(() => {
        fence("event", reaction.eventId, token);
        const existing = get<Reaction>("reaction", reaction.eventId);
        if (existing) return { _tag: "Existing", reaction: existing } as const;
        put("reaction", reaction.eventId, reaction);
        return {
          _tag: "Committed",
          reaction: get<Reaction>("reaction", reaction.eventId)!,
        } as const;
      }, true),
    renewEventLease: (id, token, request) =>
      renew("event", id, token, request.durationMs),
    getReceipt: (id) => op(() => receipt(id)),
    claimPendingEffects: (request) =>
      op(() => {
        if (!Number.isSafeInteger(request.limit) || request.limit < 0)
          return fail("Invalid effect claim limit");
        const effects = rows<Reaction>("reaction")
          .filter(
            (r) =>
              request.eventId === undefined || r.eventId === request.eventId,
          )
          .flatMap((r) => r.effects)
          .sort((a, b) => a.id.localeCompare(b.id));
        const pending: PendingEffectClaim[] = [];
        for (const effect of effects) {
          if (pending.length >= request.limit) break;
          const delivered = get<EffectDeliveryReceipt>("delivery", effect.id);
          if (
            delivered &&
            (delivered.status !== "retryable-failed" ||
              (delivered.nextRetryAt !== undefined &&
                Date.parse(delivered.nextRetryAt) > clock()))
          )
            continue;
          const current = leaseRow("effect", effect.id);
          if (current && current.expires_ms > clock()) continue;
          const previous = db
            .prepare(
              "SELECT attempt FROM openmatter_store_leases WHERE kind='effect' AND id=?",
            )
            .get(effect.id) as { attempt: number } | undefined;
          const attempt =
            Math.max(previous?.attempt ?? 0, delivered?.attempt ?? 0) + 1;
          pending.push({
            effect,
            attempt,
            lease: acquire("effect", effect.id, request, attempt),
          });
        }
        return pending;
      }, true),
    recordDelivery: (value, token) =>
      op(() => {
        fence("effect", value.effectId, token);
        put("delivery", value.effectId, value);
        release("effect", value.effectId);
      }, true),
    renewEffectLease: (id, token, request) =>
      renew("effect", id, token, request.durationMs),
    claimSession: (key, request) =>
      op(() => {
        const current = leaseRow("session", key);
        if (current && current.expires_ms > clock())
          return { _tag: "Busy", lease: asLease(current) } as const;
        const session = activeSession(key);
        return {
          _tag: "Acquired",
          lease: acquire("session", key, request),
          ...(session ? { session } : {}),
        } as const;
      }, true),
    saveSession: (session, token) =>
      op(() => {
        fence("session", session.bindingKey, token);
        const previous = activeSession(session.bindingKey);
        if (
          previous &&
          previous.id !== session.id &&
          ["open", "creating"].includes(previous.state)
        )
          put(
            "session",
            previous.id,
            { ...previous, state: "closed" },
            previous.scopeId,
            previous.bindingKey,
          );
        put(
          "session",
          session.id,
          session,
          session.scopeId,
          session.bindingKey,
        );
        db.prepare(
          "INSERT INTO openmatter_store_bindings VALUES(?,?) ON CONFLICT(binding_key) DO UPDATE SET session_id=excluded.session_id",
        ).run(session.bindingKey, session.id);
      }, true),
    getSession: (id) => op(() => get<AgentSession>("session", id)),
    renewSessionLease: (key, token, request) =>
      renew("session", key, token, request.durationMs),
    releaseSession: (key, token) =>
      op(() => {
        fence("session", key, token);
        release("session", key);
      }, true),
    saveTurn: (turn, key, token) =>
      op(() => {
        fence("session", key, token);
        if (get<AgentSession>("session", turn.sessionId)?.bindingKey !== key)
          return fail("Turn belongs to another session binding");
        const terminal = rows<OpenMAEvent>("agentEvent", "AND parent_id=?", [
          turn.id,
        ]).find((e) =>
          [
            "turn.completed",
            "turn.failed",
            "turn.cancelled",
            "turn.interrupted",
          ].includes(e.type),
        );
        if (
          terminal &&
          turn.state !==
            (terminal.type === "turn.interrupted"
              ? "cancelled"
              : terminal.type.slice(5))
        )
          return;
        put("turn", turn.id, turn, null, turn.sessionId);
      }, true),
    getTurn: (id) => op(() => get<Turn>("turn", id)),
    requestTurnCancellation: (key, eventId, at) =>
      op(() => {
        const session = activeSession(key);
        if (!session) return undefined;
        const turn = rows<Turn>("turn", "AND parent_id=?", [session.id])
          .filter((t) => ["queued", "running"].includes(t.state))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!turn) return undefined;
        const existing = get<TurnCancellationRequest>("cancellation", turn.id);
        if (existing) return existing;
        const value = {
          turnId: turn.id,
          sessionId: session.id,
          bindingKey: key,
          requestedByEventId: eventId,
          requestedAt: at,
        };
        put("cancellation", turn.id, value);
        return value;
      }, true),
    getTurnCancellation: (id) =>
      op(() => get<TurnCancellationRequest>("cancellation", id)),
    getAgentEvents: (id) =>
      op(() =>
        rows<OpenMAEvent>("agentEvent", "AND parent_id=?", [id]).sort(
          (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
        ),
      ),
    getPermissionDecision: (turnId, requestId) =>
      op(() =>
        get<PermissionDecision>(
          "permission",
          JSON.stringify([turnId, requestId]),
        ),
      ),
    commitPermissionDecision: (decision, key, token) =>
      op(() => {
        fence("session", key, token);
        const turn = get<Turn>("turn", decision.turnId);
        if (
          !turn ||
          get<AgentSession>("session", turn.sessionId)?.bindingKey !== key
        )
          return fail("Permission belongs to another session binding");
        const id = JSON.stringify([decision.turnId, decision.requestId]);
        const existing = get<PermissionDecision>("permission", id);
        if (existing) return existing;
        put("permission", id, decision);
        return get<PermissionDecision>("permission", id)!;
      }, true),
    appendAgentEvent: (event, key, token) =>
      op(() => {
        fence("session", key, token);
        if (!event.turn_id || event.seq === undefined)
          return fail("Agent event requires turn identity and sequence");
        if (
          get<AgentSession>("session", event.session_id)?.bindingKey !== key ||
          get<Turn>("turn", event.turn_id)?.sessionId !== event.session_id
        )
          return fail("Agent event belongs to another session binding");
        const id = JSON.stringify([event.turn_id, event.seq]);
        const existing = get<OpenMAEvent>("agentEvent", id);
        if (existing) {
          if (encode(existing) !== encode(event))
            fail("Conflicting Agent event sequence");
          return;
        }
        put("agentEvent", id, event, null, event.turn_id, event.event_id);
      }, true),
    saveContext: (context) =>
      op(() => {
        put(
          "context",
          context.id,
          context,
          context.scopeId,
          context.workThreadId,
        );
      }, true),
    getContext: (id) => op(() => get<ContextProjection>("context", id)),
  };
  return store;
};
