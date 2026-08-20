import type {
  AgentSessionRecord,
  CheckpointRecord,
  CommitReactionPlanInput,
  EventClaim,
  OpenMatterStore,
  OperationClaim,
  OperationCall,
  OperationIntent,
  OperationResult,
  TimerAdapter,
  WorkAdapter,
  WorkEvent,
  WorkEventSource,
} from "@openmatter/core";

export interface MockWorkAdapter extends WorkAdapter {
  operationCalls(): readonly OperationCall[];
}

export interface MockWorkEventSource extends WorkEventSource {
  emit(event: WorkEvent): Promise<void>;
}

export interface MockWorkAdapterOptions {
  readonly id: string;
  readonly operations?: Readonly<
    Record<string, Omit<OperationResult, "callId">>
  >;
}

export interface MockTimerAdapterOptions<TOccurrence> {
  readonly id: string;
  readonly decode: (
    occurrence: TOccurrence,
  ) => Promise<readonly WorkEvent[]>;
}

export function createMockTimerAdapter<TOccurrence>(
  options: MockTimerAdapterOptions<TOccurrence>,
): TimerAdapter<TOccurrence> {
  return {
    id: options.id,
    decode: options.decode,
  };
}

export function createMemoryStore(): OpenMatterStore {
  type ProcessingRecord = {
    readonly status: "processing";
    readonly event: WorkEvent;
    readonly claimToken: string;
    readonly expiresAt: string;
    readonly expiresAtMs: number;
  };
  type ReceivedRecord = {
    readonly status: "received";
    readonly event: WorkEvent;
  };
  type CompletedRecord = {
    readonly status: "completed";
    readonly event: WorkEvent;
    readonly reaction: CommitReactionPlanInput["reaction"];
  };
  type PendingOperation = {
    readonly status: "pending";
    readonly intent: OperationIntent;
  };
  type ProcessingOperation = {
    readonly status: "processing";
    readonly intent: OperationIntent;
    readonly claimToken: string;
    readonly expiresAtMs: number;
  };
  type CompletedOperation = {
    readonly status: "completed";
    readonly intent: OperationIntent;
    readonly result: OperationResult;
  };

  const records = new Map<
    string,
    ReceivedRecord | ProcessingRecord | CompletedRecord
  >();
  const operations = new Map<
    string,
    PendingOperation | ProcessingOperation | CompletedOperation
  >();
  const sessions = new Map<string, AgentSessionRecord>();
  const checkpoints = new Map<string, CheckpointRecord>();
  let claimSequence = 0;
  let operationClaimSequence = 0;
  const keyOf = (source: string, id: string) => JSON.stringify([source, id]);
  const checkpointKeyOf = (namespace: string, key: string) =>
    JSON.stringify([namespace, key]);
  const claimOperationById = (
    callId: string,
    input: { readonly now: string; readonly leaseMs: number },
  ): OperationClaim => {
    const operation = operations.get(callId);
    if (!operation) return { status: "missing" };
    if (operation.status === "completed") {
      return { status: "completed", result: operation.result };
    }

    const nowMs = Date.parse(input.now);
    if (operation.status === "processing" && nowMs < operation.expiresAtMs) {
      return { status: "processing" };
    }

    const claimToken = `operation-claim-${++operationClaimSequence}`;
    const expiresAtMs = nowMs + input.leaseMs;
    operations.set(callId, {
      status: "processing",
      intent: operation.intent,
      claimToken,
      expiresAtMs,
    });
    return {
      status: "claimed",
      intent: operation.intent,
      claimToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  };

  return {
    sessions: {
      get: async (key) => sessions.get(key),
      save: async ({ expectedRevision, session }) => {
        const existing = sessions.get(session.key);
        if ((existing?.revision ?? null) !== expectedRevision) {
          throw new Error("Agent session revision conflict");
        }
        const saved: AgentSessionRecord = {
          key: session.key,
          agentId: session.agentId,
          scopeId: session.scopeId,
          threadId: session.threadId,
          ...(session.privacyPartition
            ? { privacyPartition: session.privacyPartition }
            : {}),
          state: session.state,
          handle: session.handle,
          updatedAt: session.updatedAt,
          revision: (existing?.revision ?? 0) + 1,
        };
        sessions.set(saved.key, saved);
        return saved;
      },
    },
    checkpoints: {
      get: async (namespace, key) =>
        checkpoints.get(checkpointKeyOf(namespace, key)),
      save: async ({ expectedRevision, checkpoint }) => {
        const storageKey = checkpointKeyOf(
          checkpoint.namespace,
          checkpoint.key,
        );
        const existing = checkpoints.get(storageKey);
        if ((existing?.revision ?? null) !== expectedRevision) {
          throw new Error("Checkpoint revision conflict");
        }
        const saved: CheckpointRecord = {
          namespace: checkpoint.namespace,
          key: checkpoint.key,
          value: checkpoint.value,
          updatedAt: checkpoint.updatedAt,
          revision: (existing?.revision ?? 0) + 1,
        };
        checkpoints.set(storageKey, saved);
        return saved;
      },
    },
    ingestEvent: async (event) => {
      const key = keyOf(event.source, event.id);
      const existing = records.get(key);
      if (existing) {
        return {
          duplicate: true,
          ...(existing.status === "completed"
            ? { reaction: existing.reaction }
            : {}),
        };
      }

      records.set(key, { status: "received", event });
      return { duplicate: false };
    },
    getEvent: async (event) => records.get(keyOf(event.source, event.id))?.event,
    claimEvent: async (input): Promise<EventClaim> => {
      const key = keyOf(input.event.source, input.event.id);
      const existing = records.get(key);
      if (existing?.status === "completed") {
        return { status: "completed", reaction: existing.reaction };
      }

      const nowMs = Date.parse(input.now);
      if (existing?.status === "processing" && nowMs < existing.expiresAtMs) {
        return { status: "processing" };
      }

      const expiresAtMs = nowMs + input.leaseMs;
      const claimed: ProcessingRecord = {
        status: "processing",
        event: input.event,
        claimToken: `claim-${++claimSequence}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      records.set(key, claimed);
      return {
        status: "claimed",
        claimToken: claimed.claimToken,
        expiresAt: claimed.expiresAt,
      };
    },
    commitReactionPlan: async (input): Promise<void> => {
      const key = keyOf(input.event.source, input.event.id);
      const existing = records.get(key);
      if (
        existing?.status !== "processing"
        || existing.claimToken !== input.claimToken
      ) {
        throw new Error("Event claim is no longer current");
      }

      records.set(key, {
        status: "completed",
        event: existing.event,
        reaction: input.reaction,
      });
      for (const intent of input.operations) {
        operations.set(intent.callId, { status: "pending", intent });
      }
    },
    claimOperation: async (input) =>
      claimOperationById(input.callId, input),
    completeOperation: async (input) => {
      const operation = operations.get(input.callId);
      if (
        operation?.status !== "processing"
        || operation.claimToken !== input.claimToken
      ) {
        throw new Error("Operation claim is no longer current");
      }
      operations.set(input.callId, {
        status: "completed",
        intent: operation.intent,
        result: input.result,
      });
    },
    getOperationResult: async (callId) => {
      const operation = operations.get(callId);
      return operation?.status === "completed" ? operation.result : undefined;
    },
  };
}

export function createMockWorkAdapter(
  options: MockWorkAdapterOptions,
): MockWorkAdapter {
  const calls: OperationCall[] = [];

  return {
    id: options.id,
    operations: {
      invoke: async (call): Promise<OperationResult> => {
        calls.push(call);
        const configured = options.operations?.[call.operation.operationId];
        if (!configured) {
          return {
            callId: call.id,
            status: "failed",
            error: {
              code: "mock.operation_unconfigured",
              message: `No mock result for ${call.operation.operationId}`,
            },
          };
        }
        return { callId: call.id, ...configured };
      },
    },
    operationCalls: () => calls.slice(),
  };
}

export function createMockWorkEventSource(): MockWorkEventSource {
  const eventQueue: WorkEvent[] = [];
  const wakeups: Array<() => void> = [];
  const waitForEvent = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const wake = () => {
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      wakeups.push(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });

  return {
    start: async (emit, signal): Promise<void> => {
      while (!signal?.aborted) {
        const event = eventQueue.shift();
        if (event) {
          await emit(event);
          continue;
        }
        await waitForEvent(signal);
      }
    },
    emit: async (event): Promise<void> => {
      eventQueue.push(event);
      wakeups.shift()?.();
    },
  };
}
