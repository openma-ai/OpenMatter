import type { OperationExecutor } from "./operation.js";
import type { WorkEvent } from "./work-event.js";

export interface WorkEventSource {
  start(
    emit: (event: WorkEvent) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WorkEventDecoder<TInput = unknown> {
  decode(input: TInput): Promise<readonly WorkEvent[]>;
}

export interface WorkAdapter {
  readonly id: string;
  readonly operations: OperationExecutor;
}
