import type {
  AgentSession,
  ContextProjection,
  EffectDeliveryReceipt,
  PermissionDecision,
  Reaction,
  ReactionReceipt,
  Turn,
  WorkEvent,
} from "@openmatter/core";
import type { OpenMAEvent } from "@openmatter/agent";
import { Context, Data, Layer, type Effect } from "effect";

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LeaseRequest {
  readonly ownerId: string;
  /** The Store computes expiry from its own authoritative clock. */
  readonly durationMs: number;
}

export interface LeaseRenewal {
  /** The Store computes expiry from its own authoritative clock. */
  readonly durationMs: number;
}

export interface WorkLease {
  readonly token: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly revision: number;
}

export type EventClaim =
  | {
      readonly _tag: "Acquired";
      readonly lease: WorkLease;
      readonly event: WorkEvent;
    }
  | { readonly _tag: "Terminal"; readonly receipt: ReactionReceipt }
  | { readonly _tag: "Busy"; readonly lease: WorkLease };

export interface PendingEffectClaim {
  readonly effect: import("@openmatter/core").WorkEffect;
  readonly attempt: number;
  readonly lease: WorkLease;
}

export type SessionClaim =
  | {
      readonly _tag: "Acquired";
      readonly lease: WorkLease;
      readonly session?: AgentSession;
    }
  | { readonly _tag: "Busy"; readonly lease: WorkLease };

export type TerminalReactionCommit =
  | { readonly _tag: "Committed"; readonly reaction: Reaction }
  | { readonly _tag: "Existing"; readonly reaction: Reaction };

export interface StoreSnapshot {
  readonly events: readonly WorkEvent[];
  readonly reactions: readonly Reaction[];
  readonly deliveries: readonly EffectDeliveryReceipt[];
  readonly sessions: readonly AgentSession[];
  readonly turns: readonly Turn[];
  readonly contexts: readonly ContextProjection[];
  readonly agentEvents: readonly OpenMAEvent[];
  readonly permissionDecisions: readonly PermissionDecision[];
}

export interface OpenMatterStore {
  readonly claimEvent: (
    event: WorkEvent,
    lease: LeaseRequest,
  ) => Effect.Effect<EventClaim, StoreError>;
  /** Atomically inserts the event's terminal reaction. Existing terminal
   * state wins, including against a late interruption finalizer. */
  readonly commitTerminalReaction: (
    reaction: Reaction,
    leaseToken: string,
  ) => Effect.Effect<TerminalReactionCommit, StoreError>;
  readonly renewEventLease: (
    eventId: string,
    leaseToken: string,
    renewal: LeaseRenewal,
  ) => Effect.Effect<void, StoreError>;
  readonly claimPendingEffects: (
    input: LeaseRequest & { readonly limit: number; readonly eventId?: string },
  ) => Effect.Effect<readonly PendingEffectClaim[], StoreError>;
  readonly recordDelivery: (
    receipt: EffectDeliveryReceipt,
    leaseToken: string,
  ) => Effect.Effect<void, StoreError>;
  readonly renewEffectLease: (
    effectId: string,
    leaseToken: string,
    renewal: LeaseRenewal,
  ) => Effect.Effect<void, StoreError>;
  readonly getReceipt: (
    eventId: string,
  ) => Effect.Effect<ReactionReceipt | undefined, StoreError>;
  readonly claimSession: (
    bindingKey: string,
    lease: LeaseRequest,
  ) => Effect.Effect<SessionClaim, StoreError>;
  readonly saveSession: (
    session: AgentSession,
    leaseToken: string,
  ) => Effect.Effect<void, StoreError>;
  readonly getSession: (
    sessionId: string,
  ) => Effect.Effect<AgentSession | undefined, StoreError>;
  readonly renewSessionLease: (
    bindingKey: string,
    leaseToken: string,
    renewal: LeaseRenewal,
  ) => Effect.Effect<void, StoreError>;
  readonly releaseSession: (
    bindingKey: string,
    leaseToken: string,
  ) => Effect.Effect<void, StoreError>;
  /** Fenced upsert. A persisted terminal Agent event is authoritative and
   * cannot be overwritten by a late local failure/cancellation state. */
  readonly saveTurn: (
    turn: Turn,
    sessionBindingKey: string,
    sessionLeaseToken: string,
  ) => Effect.Effect<void, StoreError>;
  readonly getTurn: (
    turnId: string,
  ) => Effect.Effect<Turn | undefined, StoreError>;
  readonly getAgentEvents: (
    turnId: string,
  ) => Effect.Effect<readonly OpenMAEvent[], StoreError>;
  readonly getPermissionDecision: (
    turnId: string,
    requestId: string,
  ) => Effect.Effect<PermissionDecision | undefined, StoreError>;
  /** Atomically inserts one decision per Turn/request under the Session fence. */
  readonly commitPermissionDecision: (
    decision: PermissionDecision,
    sessionBindingKey: string,
    sessionLeaseToken: string,
  ) => Effect.Effect<PermissionDecision, StoreError>;
  /** Idempotent for the same Turn sequence/event identity. */
  readonly appendAgentEvent: (
    event: OpenMAEvent,
    sessionBindingKey: string,
    sessionLeaseToken: string,
  ) => Effect.Effect<void, StoreError>;
  readonly saveContext: (
    context: ContextProjection,
  ) => Effect.Effect<void, StoreError>;
  readonly getContext: (
    contextId: string,
  ) => Effect.Effect<ContextProjection | undefined, StoreError>;
}

export const StoreService = Context.GenericTag<OpenMatterStore>(
  "@openmatter/store/OpenMatterStore",
);

export const storeLayer = (store: OpenMatterStore) =>
  Layer.succeed(StoreService, store);
