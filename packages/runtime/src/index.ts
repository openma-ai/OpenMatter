import {
  AgentDrivers,
  AgentDriverError,
  agentDriverLayer,
  type AgentDriver,
  type AgentDriverRegistry,
} from "@openmatter/agent";
import {
  JsonValueSchema,
  ContextProjectionSchema,
  ReactionSchema,
  WorkEffectSchema,
  WorkEventSchema,
  type ContextProjection,
  type EffectDeliveryReceipt,
  type JsonValue,
  type Reaction,
  type ReactionReceipt,
  type WorkEffect,
  type WorkEvent,
} from "@openmatter/core";
import {
  IntegrationError,
  ProviderDeliveryResultSchema,
  WorkIntegrations,
  integrationLayer,
  type WorkIntegrationRegistry,
} from "@openmatter/integration";
import {
  StoreError,
  StoreService,
  storeLayer,
  type OpenMatterStore,
} from "@openmatter/store";
import { Effect, Layer, Schema, Stream } from "effect";
import { makeAgentTurnRuntime } from "./agent-turn.js";
import {
  AgentAccessError,
  AuthorizationError,
  ContextProjectionError,
  EventBusyError,
  SessionBusyError,
  WorkEventValidationError,
  type ConsumeSummary,
  type OpenMatterApplication,
  type OpenMatterOptions,
  type ReactionDraft,
  type RuntimeInfrastructureError,
  type WorkContext,
  type WorkHandler,
} from "./contracts.js";
import { makeLeaseRuntime } from "./lease.js";
import {
  canonicalJson,
  digest,
  errorMessage,
  isJsonObject,
  outputFrom,
  sessionHandleFrom,
} from "./portable-json.js";

export * from "./contracts.js";

const ReactionDraftSchema = Schema.Struct({
  status: Schema.Literal("completed", "failed", "cancelled"),
  effects: Schema.Array(WorkEffectSchema),
  reason: Schema.optional(Schema.String),
});

const compileHandlerFailure = (
  error: unknown,
): Effect.Effect<ReactionDraft, RuntimeInfrastructureError> => {
  if (
    error instanceof AgentDriverError ||
    error instanceof SessionBusyError ||
    error instanceof StoreError
  ) {
    return Effect.fail(error);
  }
  return Effect.succeed({
    status: "failed",
    effects: [],
    reason: errorMessage(error),
  });
};

export const createOpenMatter = (
  options: OpenMatterOptions,
): OpenMatterApplication => {
  const handlers = new Map<string, WorkHandler>();
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const runtimeId = options.runtimeId ?? makeId();
  const services = Layer.mergeAll(
    storeLayer(options.store),
    integrationLayer(options.integrations),
    agentDriverLayer(options.agents),
  );
  const lease = makeLeaseRuntime({ runtimeId });
  const { request: leaseRequest, withHeartbeat: withLeaseHeartbeat } = lease;
  const runAgentTurn = makeAgentTurnRuntime({
    clock,
    makeId,
    lease,
    sessionLeaseMs: options.sessionLeaseMs ?? 5 * 60_000,
    ...(options.permissionPolicy === undefined
      ? {}
      : { permissionPolicy: options.permissionPolicy }),
  }).run;

  const makeWorkContext = (
    event: WorkEvent,
    store: OpenMatterStore,
    drivers: ReadonlyMap<string, AgentDriver>,
    integrations: WorkIntegrationRegistry,
  ): {
    readonly api: WorkContext;
    readonly authorizeDraft: (
      draft: ReactionDraft,
    ) => Effect.Effect<ReactionDraft, AuthorizationError>;
  } => {
    let effectSequence = 0;
    let agentTurnSequence = 0;
    const projectedContexts = new Map<string, string>();
    const authorizedEffects = new Map<string, string>();

    const authorizeContext = (
      context: ContextProjection,
      operation: string,
    ): Effect.Effect<void, AuthorizationError> => {
      const authorization = projectedContexts.get(context.id);
      return !Schema.is(ContextProjectionSchema)(context) ||
        authorization === undefined ||
        authorization !== canonicalJson(context)
        ? Effect.fail(
            new AuthorizationError({
              operation,
              message: `ContextProjection was not authorized by this work event: ${context.id}`,
            }),
          )
        : Effect.void;
    };

    const api: WorkContext = {
      event,
      context: {
        event: () => ({
          id: event.id,
          kind: "event",
          value: event as unknown as JsonValue,
          provenance: [
            {
              sourceType: "work-event",
              sourceId: event.id,
              integrationId: event.source.provider,
            },
          ],
        }),
        value: (input) => ({
          id: input.id ?? makeId(),
          kind: input.kind,
          value: input.value,
          provenance: input.provenance,
        }),
        project: (input) => {
          const snapshot = structuredClone({
            scopeId: input.scopeId,
            workThreadId: input.workThreadId,
            items: input.items,
            grants: input.grants ?? [],
          });
          return Effect.gen(function* () {
            const contextDigest = yield* digest({
              scopeId: snapshot.scopeId,
              workThreadId: snapshot.workThreadId,
              triggerEventId: event.id,
              items: snapshot.items,
              grants: snapshot.grants,
            });
            const projection: ContextProjection = {
              schemaVersion: "0.1",
              id: makeId(),
              scopeId: snapshot.scopeId,
              workThreadId: snapshot.workThreadId,
              triggerEventId: event.id,
              items: snapshot.items,
              grants: snapshot.grants,
              digest: contextDigest,
              createdAt: clock(),
            };
            yield* store.saveContext(projection);
            projectedContexts.set(projection.id, canonicalJson(projection));
            return projection;
          });
        },
      },
      effect: (context, input) => {
        const contextSnapshot = structuredClone(context);
        const effectInput = structuredClone(input);
        return Effect.gen(function* () {
          yield* authorizeContext(contextSnapshot, effectInput.operation);
          const durableContext = yield* store.getContext(contextSnapshot.id);
          if (durableContext === undefined) {
            return yield* new AuthorizationError({
              operation: effectInput.operation,
              message: `ContextProjection is not durable: ${contextSnapshot.id}`,
            });
          }
          if (!Schema.is(JsonValueSchema)(effectInput.input)) {
            return yield* new AuthorizationError({
              operation: effectInput.operation,
              message: "WorkEffect input must be portable JSON data",
            });
          }
          const capability = `${effectInput.integrationId}.${effectInput.operation}`;
          if (!durableContext.grants.includes(capability)) {
            return yield* new AuthorizationError({
              operation: capability,
              message: `Effect operation is not authorized by context grants: ${capability}`,
            });
          }
          const integration = integrations.get(effectInput.integrationId);
          if (integration === undefined) {
            return yield* new AuthorizationError({
              operation: effectInput.operation,
              message: `Effect targets an unknown integration: ${effectInput.integrationId}`,
            });
          }
          if (
            !integration.manifest.operations.includes("*") &&
            !integration.manifest.operations.includes(effectInput.operation)
          ) {
            return yield* new AuthorizationError({
              operation: effectInput.operation,
              message: `Integration does not declare operation: ${effectInput.operation}`,
            });
          }

          effectSequence += 1;
          const effect: WorkEffect = {
            schemaVersion: "0.1",
            id: makeId(),
            eventId: event.id,
            integrationId: effectInput.integrationId,
            operation: effectInput.operation,
            idempotencyKey:
              effectInput.idempotencyKey ??
              `${event.idempotencyKey}:effect:${effectSequence}`,
            input: effectInput.input,
          };
          // Capture value identity, not JS object identity: user code receives
          // the object and may mutate it despite TypeScript's readonly types.
          authorizedEffects.set(effect.id, canonicalJson(effect));
          return effect;
        });
      },
      react: {
        none: (reason) => ({
          status: "completed",
          effects: [],
          ...(reason === undefined ? {} : { reason }),
        }),
        effects: (effects, reason) => ({
          status: "completed",
          effects,
          ...(reason === undefined ? {} : { reason }),
        }),
      },
      agent: (agentId) => ({
        session: ({
          scopeId,
          workThreadId,
          authority = event.source.authority,
          privacyPartition,
        }) => ({
          turn: (input) => {
            const invocation = ++agentTurnSequence;
            const sealedInput = structuredClone({
              context: input.context,
              allow: input.allow ?? [],
            });
            return authorizeContext(sealedInput.context, "agent.turn").pipe(
              Effect.zipRight(
                digest({
                  eventIdempotencyKey: event.idempotencyKey,
                  agentId,
                  authority,
                  scopeId,
                  workThreadId,
                  privacyPartition,
                  invocation,
                }),
              ),
              Effect.flatMap((turnDigest) =>
                runAgentTurn(
                  event,
                  agentId,
                  authority,
                  scopeId,
                  workThreadId,
                  privacyPartition,
                  `turn:${turnDigest}`,
                  sealedInput,
                ),
              ),
              Effect.provideService(StoreService, store),
              Effect.provideService(AgentDrivers, drivers),
            );
          },
        }),
      }),
    };

    return {
      api,
      authorizeDraft: (draft) => {
        if (!Schema.is(ReactionDraftSchema)(draft)) {
          return Effect.fail(
            new AuthorizationError({
              operation: "reaction.commit",
              message: "ReactionDraft must be a portable terminal value",
            }),
          );
        }
        return Effect.forEach(draft.effects, (effect) => {
          const authorization = authorizedEffects.get(effect.id);
          if (
            !Schema.is(WorkEffectSchema)(effect) ||
            authorization === undefined ||
            authorization !== canonicalJson(effect)
          ) {
            return Effect.fail(
              new AuthorizationError({
                operation: effect.operation,
                message: `WorkEffect was not authorized by this runtime: ${effect.id}`,
              }),
            );
          }
          return Effect.void;
        }).pipe(Effect.as(structuredClone(draft)));
      },
    };
  };

  const normalizeHandler = (
    handler: WorkHandler,
    work: WorkContext,
  ): Effect.Effect<ReactionDraft, unknown> =>
    Effect.suspend(() => {
      try {
        const result = handler(work);
        if (Effect.isEffect(result)) {
          return result as Effect.Effect<ReactionDraft, unknown>;
        }
        if (result instanceof Promise) {
          return Effect.tryPromise({
            try: () => result,
            catch: (cause) => cause,
          });
        }
        return Effect.succeed(result);
      } catch (cause) {
        return Effect.fail(cause);
      }
    });

  const reactionFrom = (event: WorkEvent, draft: ReactionDraft): Reaction => ({
    schemaVersion: "0.1",
    id: makeId(),
    eventId: event.id,
    status: draft.status,
    effects: draft.effects,
    ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    createdAt: clock(),
  });

  const terminalReactionFrom = (
    event: WorkEvent,
    draft: ReactionDraft,
  ): Reaction => {
    const candidate = reactionFrom(event, draft);
    return Schema.is(ReactionSchema)(candidate)
      ? candidate
      : reactionFrom(event, {
          status: "failed",
          effects: [],
          reason: "ReactionDraft must produce a portable terminal Reaction",
        });
  };

  const deliverPending = (input: {
    readonly eventId?: string;
    readonly limit: number;
  }): Effect.Effect<
    readonly EffectDeliveryReceipt[],
    StoreError,
    OpenMatterStore | WorkIntegrationRegistry
  > =>
    Effect.gen(function* () {
      const store = yield* StoreService;
      const integrations = yield* WorkIntegrations;
      const pending = yield* store.claimPendingEffects({
        ...leaseRequest(options.effectLeaseMs ?? 60_000),
        limit: input.limit,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      });

      return yield* Effect.forEach(
        pending,
        ({ effect, lease, attempt }) => {
          const integration = integrations.get(effect.integrationId);
          const delivery =
            integration === undefined
              ? Effect.succeed<EffectDeliveryReceipt>({
                  effectId: effect.id,
                  integrationId: effect.integrationId,
                  operation: effect.operation,
                  status: "terminal-failed",
                  attempt,
                  attemptedAt: clock(),
                  error: `Unknown integration: ${effect.integrationId}`,
                })
              : integration.deliver(effect).pipe(
                  Effect.flatMap((result) => {
                    if (!Schema.is(ProviderDeliveryResultSchema)(result)) {
                      return Effect.fail(
                        new IntegrationError({
                          message:
                            "Provider delivery result must contain only portable JSON data",
                          retryable: false,
                        }),
                      );
                    }
                    return Effect.succeed<EffectDeliveryReceipt>({
                      effectId: effect.id,
                      integrationId: effect.integrationId,
                      operation: effect.operation,
                      status: "delivered",
                      attempt,
                      attemptedAt: clock(),
                      ...(result.providerReceipt === undefined
                        ? {}
                        : { providerReceipt: result.providerReceipt }),
                    });
                  }),
                  Effect.catchAll((error: IntegrationError) => {
                    const attemptedAt = clock();
                    return Effect.succeed<EffectDeliveryReceipt>({
                      effectId: effect.id,
                      integrationId: effect.integrationId,
                      operation: effect.operation,
                      status: error.retryable
                        ? "retryable-failed"
                        : "terminal-failed",
                      attempt,
                      attemptedAt,
                      ...(error.retryable
                        ? {
                            nextRetryAt: new Date(
                              Date.parse(attemptedAt) +
                                (options.effectRetryDelayMs ?? 1_000),
                            ).toISOString(),
                          }
                        : {}),
                      error: error.message,
                    });
                  }),
                );
          return withLeaseHeartbeat(
            delivery.pipe(
              Effect.flatMap((receipt) =>
                store
                  .recordDelivery(receipt, lease.token)
                  .pipe(Effect.as(receipt)),
              ),
            ),
            options.effectLeaseMs ?? 60_000,
            (renewal) =>
              store.renewEffectLease(effect.id, lease.token, renewal),
          );
        },
        { concurrency: options.effectConcurrency ?? "unbounded" },
      );
    });

  const acceptProgram = (
    event: WorkEvent,
  ): Effect.Effect<
    ReactionReceipt,
    EventBusyError | RuntimeInfrastructureError | WorkEventValidationError,
    OpenMatterStore | WorkIntegrationRegistry | AgentDriverRegistry
  > =>
    Effect.gen(function* () {
      const eventId =
        typeof event === "object" &&
        event !== null &&
        "id" in event &&
        typeof event.id === "string"
          ? event.id
          : undefined;
      if (!Schema.is(WorkEventSchema)(event)) {
        return yield* new WorkEventValidationError({
          ...(eventId === undefined ? {} : { eventId }),
          message: "WorkEvent must be portable JSON data",
        });
      }
      const store = yield* StoreService;
      const integrations = yield* WorkIntegrations;
      const drivers = yield* AgentDrivers;
      const claim = yield* store.claimEvent(
        event,
        leaseRequest(options.eventLeaseMs ?? 60_000),
      );

      if (claim._tag === "Busy") {
        return yield* new EventBusyError({
          eventId: event.id,
          retryAt: claim.lease.expiresAt,
          message: `Event is already being processed: ${event.id}`,
        });
      }

      if (claim._tag === "Terminal") {
        yield* deliverPending({
          eventId: claim.receipt.reaction.eventId,
          limit: 100,
        }).pipe(
          Effect.provideService(StoreService, store),
          Effect.provideService(WorkIntegrations, integrations),
        );
        const refreshed = yield* store.getReceipt(
          claim.receipt.reaction.eventId,
        );
        return {
          reaction: claim.receipt.reaction,
          deliveries: refreshed?.deliveries ?? claim.receipt.deliveries,
          duplicate: true,
        };
      }

      const workEvent = claim.event;
      const handler = handlers.get(workEvent.type) ?? handlers.get("*");
      const work = makeWorkContext(workEvent, store, drivers, integrations);
      const handlerProgram =
        handler === undefined
          ? Effect.succeed<ReactionDraft>({
              status: "failed",
              effects: [],
              reason: `No handler registered for ${workEvent.type}`,
            })
          : normalizeHandler(handler, work.api).pipe(
              Effect.flatMap(work.authorizeDraft),
              Effect.catchAll(compileHandlerFailure),
            );
      const eventLeaseMs = options.eventLeaseMs ?? 60_000;
      const reaction = yield* withLeaseHeartbeat(
        handlerProgram.pipe(
          Effect.flatMap((draft) => {
            const reaction = terminalReactionFrom(workEvent, draft);
            // Durable outbox boundary: Reaction and effect intents commit
            // under the same live event lease, before provider delivery.
            return store
              .commitTerminalReaction(reaction, claim.lease.token)
              .pipe(Effect.map((commit) => commit.reaction));
          }),
          Effect.onInterrupt(() =>
            store
              .commitTerminalReaction(
                terminalReactionFrom(workEvent, {
                  status: "cancelled",
                  effects: [],
                  reason: "Execution interrupted",
                }),
                claim.lease.token,
              )
              .pipe(Effect.catchAll(() => Effect.void)),
          ),
        ),
        eventLeaseMs,
        (renewal) =>
          store.renewEventLease(workEvent.id, claim.lease.token, renewal),
      );
      yield* deliverPending({ eventId: reaction.eventId, limit: 100 }).pipe(
        Effect.provideService(StoreService, store),
        Effect.provideService(WorkIntegrations, integrations),
      );
      const refreshed = yield* store.getReceipt(reaction.eventId);

      return {
        reaction,
        deliveries: refreshed?.deliveries ?? [],
        duplicate: false,
      };
    });

  const acceptEffect = (event: WorkEvent) =>
    acceptProgram(event).pipe(Effect.provide(services));

  const recoverEffectsEffect = (recoverOptions?: { readonly limit?: number }) =>
    deliverPending({ limit: recoverOptions?.limit ?? 100 }).pipe(
      Effect.provide(services),
    );

  const acceptFromProgram = (
    integrationId: string,
    input: unknown,
  ): Effect.Effect<
    readonly ReactionReceipt[],
    | EventBusyError
    | AgentDriverError
    | IntegrationError
    | SessionBusyError
    | StoreError
    | WorkEventValidationError,
    OpenMatterStore | WorkIntegrationRegistry | AgentDriverRegistry
  > =>
    Effect.gen(function* () {
      const integrations = yield* WorkIntegrations;
      const integration = integrations.get(integrationId);
      if (integration === undefined) {
        return yield* new IntegrationError({
          message: `Unknown integration: ${integrationId}`,
          retryable: false,
        });
      }
      const events = yield* integration.ingest(input);
      return yield* Effect.forEach(events, acceptProgram, { concurrency: 1 });
    });

  const acceptFromEffect = (integrationId: string, input: unknown) =>
    acceptFromProgram(integrationId, input).pipe(Effect.provide(services));

  const app: OpenMatterApplication = {
    on: (eventTypes, handler) => {
      const types = typeof eventTypes === "string" ? [eventTypes] : eventTypes;
      for (const type of types) handlers.set(type, handler);
      return app;
    },
    acceptEffect,
    accept: (event) => Effect.runPromise(acceptEffect(event)),
    recoverEffectsEffect,
    recoverEffects: (recoverOptions) =>
      Effect.runPromise(recoverEffectsEffect(recoverOptions)),
    acceptFromEffect,
    acceptFrom: (integrationId, input) =>
      Effect.runPromise(acceptFromEffect(integrationId, input)),
    consume: (events, consumeOptions) =>
      Effect.runPromise(
        Stream.fromAsyncIterable(events, (cause) => cause).pipe(
          Stream.mapEffect(acceptEffect, {
            concurrency: consumeOptions?.concurrency ?? 1,
          }),
          Stream.runFold(
            { processed: 0, failed: 0, duplicates: 0 } satisfies ConsumeSummary,
            (summary, receipt) => ({
              processed: summary.processed + 1,
              failed:
                summary.failed + (receipt.reaction.status === "failed" ? 1 : 0),
              duplicates: summary.duplicates + (receipt.duplicate ? 1 : 0),
            }),
          ),
        ),
      ),
  };

  return app;
};
