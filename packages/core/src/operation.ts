import type { JsonValue } from "./json.js";
import type { OperationRef } from "./profile.js";

export interface OperationCall {
  readonly id: string;
  readonly operation: OperationRef;
  readonly input: JsonValue;
  readonly requestedAt: string;
  readonly idempotencyKey?: string;
}

export type OperationStatus =
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown";

export interface OperationResult {
  readonly callId: string;
  readonly status: OperationStatus;
  readonly output?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly details?: JsonValue;
  };
}

export interface OperationIntent {
  readonly callId: string;
  readonly operation: OperationRef;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
}

export interface OperationExecutor {
  invoke(call: OperationCall, signal?: AbortSignal): Promise<OperationResult>;
}

export interface OperationGateway extends OperationExecutor {}

export type OperationDeliveryReceipt =
  | {
      readonly status: "completed";
      readonly result: OperationResult;
      readonly duplicate: boolean;
    }
  | {
      readonly status: "processing";
      readonly callId: string;
    }
  | {
      readonly status: "missing";
      readonly callId: string;
    };
