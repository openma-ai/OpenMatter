import type {
  OperationIntent,
  OperationResult,
} from "./operation.js";
import type { AgentSessionStore, CheckpointStore } from "./continuity.js";
import type { ReactionDecision, WorkEventRef } from "./reaction.js";
import type { WorkEvent } from "./work-event.js";

export interface EventIngestResult {
  readonly duplicate: boolean;
  readonly reaction?: ReactionDecision;
}

export interface ClaimEventInput {
  readonly event: WorkEvent;
  readonly ownerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export type EventClaim =
  | {
      readonly status: "claimed";
      readonly claimToken: string;
      readonly expiresAt: string;
    }
  | { readonly status: "processing" }
  | { readonly status: "completed"; readonly reaction: ReactionDecision };

export interface CommitReactionPlanInput {
  readonly event: WorkEventRef;
  readonly claimToken: string;
  readonly reaction: ReactionDecision;
  readonly operations: readonly OperationIntent[];
}

export interface ClaimOperationInput {
  readonly callId: string;
  readonly ownerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export interface OperationDeliveryClaim {
  readonly intent: OperationIntent;
  readonly claimToken: string;
  readonly expiresAt: string;
}

export type OperationClaim =
  | ({ readonly status: "claimed" } & OperationDeliveryClaim)
  | { readonly status: "processing" }
  | { readonly status: "completed"; readonly result: OperationResult }
  | { readonly status: "missing" };

export interface CompleteOperationInput {
  readonly callId: string;
  readonly claimToken: string;
  readonly result: OperationResult;
}

export interface OpenMatterStore {
  readonly sessions: AgentSessionStore;
  readonly checkpoints: CheckpointStore;
  ingestEvent(event: WorkEvent): Promise<EventIngestResult>;
  getEvent(event: WorkEventRef): Promise<WorkEvent | undefined>;
  claimEvent(input: ClaimEventInput): Promise<EventClaim>;
  commitReactionPlan(input: CommitReactionPlanInput): Promise<void>;
  claimOperation(input: ClaimOperationInput): Promise<OperationClaim>;
  completeOperation(input: CompleteOperationInput): Promise<void>;
  getOperationResult(callId: string): Promise<OperationResult | undefined>;
}
