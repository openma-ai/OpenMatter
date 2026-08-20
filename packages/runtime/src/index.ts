import type {
  AcceptReceipt,
  EventIngestReceipt,
  EventProcessReceipt,
  OpenMatterStore,
  OperationDeliveryReceipt,
  OperationExecutor,
  OperationIntent,
  ReactionDecision,
  ReactionPlan,
  WorkEvent,
} from "@openmatter/core";
import { Effect, pipe } from "effect";

export interface OpenMatterRuntimeOptions {
  readonly store: OpenMatterStore;
  readonly operations?: OperationExecutor;
  readonly ownerId: string;
  readonly leaseMs?: number;
  readonly now?: () => string;
  readonly decide: (event: WorkEvent) => Promise<ReactionPlan>;
}

export interface OpenMatterRuntime {
  ingest(event: WorkEvent): Promise<EventIngestReceipt>;
  process(event: { readonly source: string; readonly id: string }): Promise<EventProcessReceipt>;
  deliver(callId: string): Promise<OperationDeliveryReceipt>;
  accept(event: WorkEvent): Promise<AcceptReceipt>;
}

export function createOpenMatterRuntime(
  options: OpenMatterRuntimeOptions,
): OpenMatterRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.leaseMs ?? 30_000;
  const inFlight = new Map<string, Promise<AcceptReceipt>>();
  const eventKey = (event: WorkEvent) => JSON.stringify([event.source, event.id]);
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

  const processEvent = async (
    eventRef: { readonly source: string; readonly id: string },
  ): Promise<EventProcessReceipt> => {
    const event = await options.store.getEvent(eventRef);
    if (!event) return { status: "missing", event: eventRef };

    const program = pipe(
      Effect.tryPromise({
        try: () =>
          options.store.claimEvent({
            event,
            ownerId: options.ownerId,
            now: now(),
            leaseMs,
          }),
        catch: asError,
      }),
      Effect.flatMap((claim): Effect.Effect<EventProcessReceipt, Error> => {
        if (claim.status === "completed") {
          const processed: EventProcessReceipt = {
            status: "completed",
            reaction: claim.reaction,
            duplicate: true,
          };
          return Effect.succeed<EventProcessReceipt>(processed);
        }
        if (claim.status === "processing") {
          return Effect.succeed<EventProcessReceipt>({
            status: "processing",
            event: eventRef,
          });
        }

        return pipe(
          Effect.tryPromise({ try: () => options.decide(event), catch: asError }),
          Effect.match({
            onFailure: (error): {
              reaction: ReactionDecision;
              operations: readonly OperationIntent[];
            } => ({
              reaction: {
                openmatter: "0.1",
                id: `${event.source}#${event.id}`,
                event: { source: event.source, id: event.id },
                status: "failed",
                operationCallIds: [],
                reason: error.message,
                decidedAt: now(),
              },
              operations: [],
            }),
            onSuccess: (plan) => {
              const operations = plan.operations ?? [];
              const operationCallIds =
                plan.operationCallIds ?? operations.map(({ callId }) => callId);
              const reaction: ReactionDecision = {
                openmatter: "0.1",
                id: `${event.source}#${event.id}`,
                event: { source: event.source, id: event.id },
                status: "completed",
                operationCallIds,
                ...(plan.reason ? { reason: plan.reason } : {}),
                decidedAt: now(),
              };
              return { reaction, operations };
            },
          }),
          Effect.flatMap(({ reaction, operations }) =>
            pipe(
              Effect.tryPromise({
                try: () =>
                  options.store.commitReactionPlan({
                    event: { source: event.source, id: event.id },
                    claimToken: claim.claimToken,
                    reaction,
                    operations,
                }),
                catch: asError,
              }),
              Effect.as<EventProcessReceipt>({
                status: "completed",
                reaction,
                duplicate: false,
              }),
            ),
          ),
        );
      }),
    );

    return Effect.runPromise(program);
  };

  const ingestEvent = async (event: WorkEvent): Promise<EventIngestReceipt> => {
    const result = await options.store.ingestEvent(event);
    return {
      event: { source: event.source, id: event.id },
      duplicate: result.duplicate,
      ...(result.reaction ? { reaction: result.reaction } : {}),
    };
  };

  const deliverOperation = (
    callId: string,
  ): Promise<OperationDeliveryReceipt> => {
    if (!options.operations) {
      return Promise.reject(
        new Error("Operation delivery requires an OperationExecutor"),
      );
    }

    const executor = options.operations;
    const program = pipe(
      Effect.tryPromise({
        try: () =>
          options.store.claimOperation({
            callId,
            ownerId: options.ownerId,
            now: now(),
            leaseMs,
          }),
        catch: asError,
      }),
      Effect.flatMap((claim): Effect.Effect<OperationDeliveryReceipt, Error> => {
        if (claim.status === "missing") {
          return Effect.succeed({ status: "missing", callId });
        }
        if (claim.status === "processing") {
          return Effect.succeed({ status: "processing", callId });
        }
        if (claim.status === "completed") {
          return Effect.succeed({
            status: "completed",
            result: claim.result,
            duplicate: true,
          });
        }

        return pipe(
          Effect.tryPromise({
            try: () =>
              executor.invoke({
                id: claim.intent.callId,
                operation: claim.intent.operation,
                input: claim.intent.input,
                requestedAt: now(),
                ...(claim.intent.idempotencyKey
                  ? { idempotencyKey: claim.intent.idempotencyKey }
                  : {}),
              }),
            catch: asError,
          }),
          Effect.flatMap((result) =>
            Effect.tryPromise({
              try: () =>
                options.store.completeOperation({
                  callId,
                  claimToken: claim.claimToken,
                  result,
                }),
              catch: asError,
            }).pipe(Effect.as(result)),
          ),
          Effect.map((result) => ({
            status: "completed" as const,
            result,
            duplicate: false,
          })),
        );
      }),
    );

    return Effect.runPromise(program);
  };

  return {
    ingest: ingestEvent,
    process: processEvent,
    deliver: deliverOperation,
    accept: async (event): Promise<AcceptReceipt> => {
      const key = eventKey(event);
      const existing = inFlight.get(key);
      if (existing) {
        const accepted = await existing;
        return { ...accepted, duplicate: true };
      }

      const processing = (async (): Promise<AcceptReceipt> => {
        await ingestEvent(event);
        const result = await processEvent({ source: event.source, id: event.id });
        if (result.status !== "completed") {
          throw new Error(`Event processing ${result.status}`);
        }
        const deliveries = options.operations
          ? await Promise.all(
              result.reaction.operationCallIds.map(deliverOperation),
            )
          : [];
        return {
          reaction: result.reaction,
          duplicate: result.duplicate,
          deliveries,
        };
      })();
      inFlight.set(key, processing);
      try {
        return await processing;
      } finally {
        if (inFlight.get(key) === processing) inFlight.delete(key);
      }
    },
  };
}
