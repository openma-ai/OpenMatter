import { Context, Effect, Layer } from "effect";
import { AgentSession, ContextProjection, EffectDeliveryReceipt, PermissionDecision, Reaction, ReactionReceipt, ThreadGoal, ThreadGoalStatus, Turn, TurnCancellationRequest, WorkEvent } from "@openmatter/core";
import { OpenMAEvent } from "@openmatter/agent";
//#region src/index.d.ts
declare const StoreError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "StoreError";
} & Readonly<A>;
declare class StoreError extends StoreError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
interface LeaseRequest {
  readonly ownerId: string;
  /** The Store computes expiry from its own authoritative clock. */
  readonly durationMs: number;
}
interface LeaseRenewal {
  /** The Store computes expiry from its own authoritative clock. */
  readonly durationMs: number;
}
interface WorkLease {
  readonly token: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly revision: number;
}
type EventClaim = {
  readonly _tag: "Acquired";
  readonly lease: WorkLease;
  readonly event: WorkEvent;
} | {
  readonly _tag: "Terminal";
  readonly receipt: ReactionReceipt;
} | {
  readonly _tag: "Busy";
  readonly lease: WorkLease;
};
interface PendingEffectClaim {
  readonly effect: import("@openmatter/core").WorkEffect;
  readonly attempt: number;
  readonly lease: WorkLease;
}
type SessionClaim = {
  readonly _tag: "Acquired";
  readonly lease: WorkLease;
  readonly session?: AgentSession;
} | {
  readonly _tag: "Busy";
  readonly lease: WorkLease;
};
type TerminalReactionCommit = {
  readonly _tag: "Committed";
  readonly reaction: Reaction;
} | {
  readonly _tag: "Existing";
  readonly reaction: Reaction;
};
interface CreateThreadGoalInput {
  readonly scopeId: string;
  readonly workThreadId: string;
  readonly objective: string;
  readonly tokenBudget?: number;
}
interface UpdateThreadGoalInput {
  readonly expectedGoalId?: string;
  readonly expectedRevision?: number;
  readonly objective?: string;
  readonly status?: ThreadGoalStatus;
  /** null removes the budget; omitting it preserves the current budget. */
  readonly tokenBudget?: number | null;
  /** An empty string clears a previous reason. */
  readonly reason?: string;
}
interface AccountThreadGoalInput {
  readonly goalId: string;
  readonly turnId: string;
  /** Final nonnegative usage deltas for this Turn, applied exactly once. */
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
}
interface StoreSnapshot {
  readonly goals: readonly ThreadGoal[];
  readonly events: readonly WorkEvent[];
  readonly reactions: readonly Reaction[];
  readonly deliveries: readonly EffectDeliveryReceipt[];
  readonly sessions: readonly AgentSession[];
  readonly turns: readonly Turn[];
  readonly turnCancellationRequests: readonly TurnCancellationRequest[];
  readonly contexts: readonly ContextProjection[];
  readonly agentEvents: readonly OpenMAEvent[];
  readonly permissionDecisions: readonly PermissionDecision[];
}
interface OpenMatterStore {
  /** Only an absent or completed goal may be replaced. */
  readonly createThreadGoal: (input: CreateThreadGoalInput) => Effect.Effect<ThreadGoal, StoreError>;
  readonly getThreadGoal: (workThreadId: string) => Effect.Effect<ThreadGoal | undefined, StoreError>;
  readonly listThreadGoals: (scopeId?: string) => Effect.Effect<readonly ThreadGoal[], StoreError>;
  /** Stale goal IDs or revisions fail without changing the current goal. */
  readonly updateThreadGoal: (workThreadId: string, input: UpdateThreadGoalInput) => Effect.Effect<ThreadGoal, StoreError>;
  /** Idempotent by goal/Turn. Conflicting receipts and stale goal IDs fail. */
  readonly accountThreadGoal: (workThreadId: string, input: AccountThreadGoalInput) => Effect.Effect<ThreadGoal, StoreError>;
  readonly clearThreadGoal: (workThreadId: string, expectedGoalId?: string) => Effect.Effect<boolean, StoreError>;
  readonly claimEvent: (event: WorkEvent, lease: LeaseRequest) => Effect.Effect<EventClaim, StoreError>;
  /** Atomically inserts the event's terminal reaction. Existing terminal
   * state wins, including against a late interruption finalizer. */
  readonly commitTerminalReaction: (reaction: Reaction, leaseToken: string) => Effect.Effect<TerminalReactionCommit, StoreError>;
  readonly renewEventLease: (eventId: string, leaseToken: string, renewal: LeaseRenewal) => Effect.Effect<void, StoreError>;
  readonly claimPendingEffects: (input: LeaseRequest & {
    readonly limit: number;
    readonly eventId?: string;
  }) => Effect.Effect<readonly PendingEffectClaim[], StoreError>;
  readonly recordDelivery: (receipt: EffectDeliveryReceipt, leaseToken: string) => Effect.Effect<void, StoreError>;
  readonly renewEffectLease: (effectId: string, leaseToken: string, renewal: LeaseRenewal) => Effect.Effect<void, StoreError>;
  readonly getReceipt: (eventId: string) => Effect.Effect<ReactionReceipt | undefined, StoreError>;
  readonly claimSession: (bindingKey: string, lease: LeaseRequest) => Effect.Effect<SessionClaim, StoreError>;
  readonly saveSession: (session: AgentSession, leaseToken: string) => Effect.Effect<void, StoreError>;
  readonly getSession: (sessionId: string) => Effect.Effect<AgentSession | undefined, StoreError>;
  readonly renewSessionLease: (bindingKey: string, leaseToken: string, renewal: LeaseRenewal) => Effect.Effect<void, StoreError>;
  readonly releaseSession: (bindingKey: string, leaseToken: string) => Effect.Effect<void, StoreError>;
  /** Fenced upsert. A persisted terminal Agent event is authoritative and
   * cannot be overwritten by a late local failure/cancellation state. */
  readonly saveTurn: (turn: Turn, sessionBindingKey: string, sessionLeaseToken: string) => Effect.Effect<void, StoreError>;
  readonly getTurn: (turnId: string) => Effect.Effect<Turn | undefined, StoreError>;
  /** Persist one cancellation intent for the currently active Turn bound to
   * this Session. Existing intent wins, making webhook replay idempotent. */
  readonly requestTurnCancellation: (bindingKey: string, requestedByEventId: string, requestedAt: string) => Effect.Effect<TurnCancellationRequest | undefined, StoreError>;
  readonly getTurnCancellation: (turnId: string) => Effect.Effect<TurnCancellationRequest | undefined, StoreError>;
  readonly getAgentEvents: (turnId: string) => Effect.Effect<readonly OpenMAEvent[], StoreError>;
  readonly getPermissionDecision: (turnId: string, requestId: string) => Effect.Effect<PermissionDecision | undefined, StoreError>;
  /** Atomically inserts one decision per Turn/request under the Session fence. */
  readonly commitPermissionDecision: (decision: PermissionDecision, sessionBindingKey: string, sessionLeaseToken: string) => Effect.Effect<PermissionDecision, StoreError>;
  /** Idempotent for the same Turn sequence/event identity. */
  readonly appendAgentEvent: (event: OpenMAEvent, sessionBindingKey: string, sessionLeaseToken: string) => Effect.Effect<void, StoreError>;
  readonly saveContext: (context: ContextProjection) => Effect.Effect<void, StoreError>;
  readonly getContext: (contextId: string) => Effect.Effect<ContextProjection | undefined, StoreError>;
}
declare const StoreService: Context.Tag<OpenMatterStore, OpenMatterStore>;
declare const storeLayer: (store: OpenMatterStore) => Layer.Layer<OpenMatterStore, never, never>;
//#endregion
export { AccountThreadGoalInput, CreateThreadGoalInput, EventClaim, LeaseRenewal, LeaseRequest, OpenMatterStore, PendingEffectClaim, SessionClaim, StoreError, StoreService, StoreSnapshot, TerminalReactionCommit, UpdateThreadGoalInput, WorkLease, storeLayer };
//# sourceMappingURL=index.d.ts.map