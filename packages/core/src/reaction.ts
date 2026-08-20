import type {
  OperationDeliveryReceipt,
  OperationIntent,
} from "./operation.js";

export interface WorkEventRef {
  readonly source: string;
  readonly id: string;
}

export type ReactionStatus = "completed" | "failed" | "cancelled";

export interface ReactionDecision {
  readonly openmatter: "0.1";
  readonly id: string;
  readonly event: WorkEventRef;
  readonly status: ReactionStatus;
  readonly operationCallIds: readonly string[];
  readonly reason?: string;
  readonly decidedAt: string;
}

export interface ReactionPlan {
  readonly operations?: readonly OperationIntent[];
  readonly operationCallIds?: readonly string[];
  readonly reason?: string;
}

export interface ReactionReceipt {
  readonly reaction: ReactionDecision;
  readonly duplicate: boolean;
}

export interface AcceptReceipt extends ReactionReceipt {
  readonly deliveries: readonly OperationDeliveryReceipt[];
}

export interface EventIngestReceipt {
  readonly event: WorkEventRef;
  readonly duplicate: boolean;
  readonly reaction?: ReactionDecision;
}

export type EventProcessReceipt =
  | {
      readonly status: "completed";
      readonly reaction: ReactionDecision;
      readonly duplicate: boolean;
    }
  | {
      readonly status: "processing";
      readonly event: WorkEventRef;
    }
  | {
      readonly status: "missing";
      readonly event: WorkEventRef;
    };
