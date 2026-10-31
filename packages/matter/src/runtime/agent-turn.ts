import {
  AgentDrivers,
  AgentDriverError,
  AgentSessionHandleSchema,
  OpenMAEventSchema,
  createOpenMAEvent,
  immutableJson,
  isCallbackRequestEvent,
  isPermissionRequestEvent,
  isTurnTerminalEvent,
  OPERATION_CALL_METHOD,
  turnTerminalStatus,
  type AgentDriver,
  type AgentDriverRegistry,
  type AgentSessionHandle,
  type AgentTool,
  type OpenMAEvent,
} from "../agent/index.js";
import {
  IntegrationError,
  ProviderDeliveryResultSchema,
  WorkIntegrations,
  type WorkIntegration,
  type WorkIntegrationRegistry,
} from "../integration/index.js";
import {
  DEFAULT_FRESHNESS,
  JsonValueSchema,
  WorkEffectSchema,
  type AgentSession,
  type ConversationEntry,
  type ConversationMessage,
  type FreshnessPolicy,
  type JsonValue,
  type OperationCall,
  type OperationCallResult,
  type Turn,
  type WorkEffect,
  type WorkEvent,
} from "../index.js";
import {
  ConversationChangedError,
  StoreError,
  StoreService,
  type OpenMatterStore,
} from "../store/index.js";
import { Cause, Effect, Schema, Stream } from "effect";
import {
  AgentAccessError,
  AuthorizationError,
  ContextProjectionError,
  SessionBusyError,
  type AgentPermissionPolicy,
  type AgentPermissionRequest,
  type AgentCancellationResult,
  type AgentSteerOptions,
  type AgentSteerResult,
  type AgentTurnOptions,
  type AgentTurnResult,
} from "./contracts.js";
import type { LeaseRuntime } from "./lease.js";
import { outputFrom, sessionHandleFrom } from "./portable-json.js";

export interface AgentTurnRuntime {
  readonly cancel: (
    event: WorkEvent,
    agentId: string,
    authority: string,
    scopeId: string,
    workThreadId: string,
    privacyPartition: string,
  ) => Effect.Effect<
    AgentCancellationResult,
    AgentAccessError | AgentDriverError | StoreError,
    OpenMatterStore | AgentDriverRegistry
  >;
  readonly steer: (
    event: WorkEvent,
    agentId: string,
    authority: string,
    scopeId: string,
    workThreadId: string,
    privacyPartition: string,
    input: AgentSteerOptions,
  ) => Effect.Effect<AgentSteerResult>;
  readonly run: (
    event: WorkEvent,
    agentId: string,
    authority: string,
    scopeId: string,
    workThreadId: string,
    privacyPartition: string,
    turnId: string,
    input: AgentTurnOptions,
  ) => Effect.Effect<
    AgentTurnResult,
    | AgentAccessError
    | AgentDriverError
    | AuthorizationError
    | ContextProjectionError
    | SessionBusyError
    | StoreError,
    OpenMatterStore | AgentDriverRegistry | WorkIntegrationRegistry
  >;
}

export const makeAgentTurnRuntime = (options: {
  readonly clock: () => string;
  readonly makeId: () => string;
  readonly lease: LeaseRuntime;
  readonly sessionLeaseMs: number;
  readonly permissionPolicy?: AgentPermissionPolicy;
}): AgentTurnRuntime => {
  const bindingKeyFor = (
    agentId: string,
    authority: string,
    scopeId: string,
    workThreadId: string,
    privacyPartition: string,
  ) =>
    JSON.stringify([
      agentId,
      authority,
      scopeId,
      workThreadId,
      privacyPartition,
    ]);

  // Turns this process is streaming right now, by Session binding. A live
  // steer can only reach a Turn whose driver stream this process owns; the
  // Session lease guarantees at most one such Turn per binding.
  const liveTurns = new Map<
    string,
    {
      readonly turnId: string;
      readonly sessionId: string;
      readonly handle: AgentSessionHandle;
      readonly driver: AgentDriver;
      readonly steering: boolean;
    }
  >();
  // Steer outcomes by steerId, so a retried steer Event (for example after
  // its follow-up work failed) answers the same way instead of injecting the
  // instruction twice. Bounded; outlives the Turn it reached.
  const steerOutcomes = new Map<string, AgentSteerResult>();
  const rememberSteer = (steerId: string, result: AgentSteerResult) => {
    steerOutcomes.set(steerId, result);
    if (steerOutcomes.size > 1024) {
      steerOutcomes.delete(steerOutcomes.keys().next().value!);
    }
    return result;
  };

  const decidePermission = (
    request: AgentPermissionRequest,
  ): Effect.Effect<boolean, AgentDriverError> =>
    Effect.suspend(() => {
      if (options.permissionPolicy === undefined) return Effect.succeed(false);
      try {
        const decision = options.permissionPolicy(request);
        if (Effect.isEffect(decision)) {
          return (decision as Effect.Effect<boolean, unknown>).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDriverError({
                  message: "Permission policy failed",
                  cause,
                }),
            ),
          );
        }
        if (decision instanceof Promise) {
          return Effect.tryPromise({
            try: () => decision,
            catch: (cause) =>
              new AgentDriverError({
                message: "Permission policy failed",
                cause,
              }),
          });
        }
        return Effect.succeed(decision);
      } catch (cause) {
        return Effect.fail(
          new AgentDriverError({
            message: "Permission policy failed",
            cause,
          }),
        );
      }
    }).pipe(
      Effect.flatMap((decision) =>
        typeof decision === "boolean"
          ? Effect.succeed(decision)
          : Effect.fail(
              new AgentDriverError({
                message: "Permission policy must return a boolean decision",
              }),
            ),
      ),
    );

  const run: AgentTurnRuntime["run"] = (
    event,
    agentId,
    authority,
    scopeId,
    workThreadId,
    privacyPartition,
    turnId,
    input,
  ) =>
    Effect.suspend(() => {
      let activeSessionLease:
        { readonly bindingKey: string; readonly token: string } | undefined;
      let activeTurn: Turn | undefined;

      return Effect.gen(function* () {
        const store = yield* StoreService;
        const drivers = yield* AgentDrivers;
        const integrations = yield* WorkIntegrations;
        if (
          input.context.scopeId !== scopeId ||
          input.context.workThreadId !== workThreadId
        ) {
          return yield* new ContextProjectionError({
            message:
              "Context projection does not match the agent session binding",
          });
        }
        const bindingKey = bindingKeyFor(
          agentId,
          authority,
          scopeId,
          workThreadId,
          privacyPartition,
        );
        const sessionClaim = yield* store.claimSession(
          bindingKey,
          options.lease.request(options.sessionLeaseMs),
        );
        if (sessionClaim._tag === "Busy") {
          return yield* new SessionBusyError({
            bindingKey,
            retryAt: sessionClaim.lease.expiresAt,
            message: `Agent session is busy: ${bindingKey}`,
          });
        }
        activeSessionLease = {
          bindingKey,
          token: sessionClaim.lease.token,
        };

        const claimedSession = Effect.gen(function* () {
          const storedTurn = yield* store.getTurn(turnId);
          const storedEvents = yield* store.getAgentEvents(turnId);
          const storedTerminal = storedEvents.find(isTurnTerminalEvent);

          // A Turn is a logical invocation, not a process attempt. If the Agent
          // finished before the Event's terminal commit, replay reuses its
          // durable result without asking the Agent to think twice.
          if (storedTerminal !== undefined) {
            if (storedTurn === undefined) {
              return yield* new StoreError({
                message: `Terminal Agent events exist without Turn state: ${turnId}`,
              });
            }
            const storedSession = yield* store.getSession(storedTurn.sessionId);
            if (storedSession === undefined) {
              return yield* new StoreError({
                message: `Turn references an unknown Agent Session: ${turnId}`,
              });
            }
            const outcome = turnTerminalStatus(storedTerminal)!;
            const completedTurn: Turn = {
              ...storedTurn,
              state: outcome === "interrupted" ? "cancelled" : outcome,
              completedAt: storedTurn.completedAt ?? storedTerminal.occurred_at,
            };
            if (
              storedTurn.state !== completedTurn.state ||
              storedTurn.completedAt === undefined
            ) {
              yield* store.saveTurn(
                completedTurn,
                bindingKey,
                sessionClaim.lease.token,
              );
            }
            return {
              session: storedSession,
              turn: completedTurn,
              outcome,
              events: storedEvents,
              output: outputFrom(storedEvents),
            };
          }

          const interruptStoredTurn = (turn: Turn, reason: string) =>
            Effect.gen(function* () {
              const originalSession = yield* store.getSession(turn.sessionId);
              if (originalSession === undefined) {
                return yield* new StoreError({
                  message: `Partial Turn references an unknown Agent Session: ${turn.id}`,
                });
              }
              const sequence = (storedEvents.at(-1)?.seq ?? 0) + 1;
              const interruptedEvent: OpenMAEvent = createOpenMAEvent({
                event_id: `${turn.id}:runtime-interrupted:${sequence}`,
                type: "turn.interrupted",
                session_id: turn.sessionId,
                turn_id: turn.id,
                seq: sequence,
                occurred_at: options.clock(),
                source: { kind: "openma", adapter: "runtime" },
                data: { reason },
              });
              yield* store.appendAgentEvent(
                interruptedEvent,
                bindingKey,
                sessionClaim.lease.token,
              );
              const interruptedTurn: Turn = {
                ...turn,
                state: "cancelled",
                completedAt: interruptedEvent.occurred_at,
              };
              yield* store.saveTurn(
                interruptedTurn,
                bindingKey,
                sessionClaim.lease.token,
              );
              return {
                session: originalSession,
                turn: interruptedTurn,
                outcome: "interrupted" as const,
                events: [...storedEvents, interruptedEvent],
                output: outputFrom(storedEvents),
              };
            });

          // Cancellation is an irreversible logical fact. If its matching
          // Event Reaction was not committed before interruption/crash, replay
          // may repair the missing terminal Agent checkpoint but must never
          // redispatch the cancelled Turn.
          if (storedTurn?.state === "cancelled") {
            return yield* interruptStoredTurn(
              storedTurn,
              "A previously cancelled Agent Turn cannot be resumed",
            );
          }

          const driver = drivers.get(agentId);
          if (driver === undefined) {
            if (storedTurn !== undefined) {
              return yield* interruptStoredTurn(
                storedTurn,
                "The configured Agent Driver is unavailable for this in-flight Turn",
              );
            }
            return yield* new AgentAccessError({
              agentId,
              message: `Unknown agent: ${agentId}`,
            });
          }
          const capabilities = yield* driver.capabilities();

          const turnContext = yield* store.getContext(
            storedTurn?.contextProjectionId ?? input.context.id,
          );
          if (turnContext === undefined) {
            return yield* new StoreError({
              message: `Logical Turn references an unknown ContextProjection: ${turnId}`,
            });
          }
          const expectedContextDigest =
            storedTurn?.contextDigest ?? input.context.digest;
          if (turnContext.digest !== expectedContextDigest) {
            return yield* new StoreError({
              message: `Logical Turn context digest no longer matches: ${turnId}`,
            });
          }
          const turnAllow = storedTurn?.allow ?? input.allow ?? [];
          const turnFreshness = storedTurn?.freshness ?? input.freshness;
          // The latest conversation revision shown to the Agent in this Turn
          // beyond its trigger: conflict results advance it.
          const seen = { revision: 0 };
          const denied = turnAllow.find(
            (operation) => !turnContext.grants.includes(operation),
          );
          if (denied !== undefined) {
            return yield* new AuthorizationError({
              operation: denied,
              message: `Turn operation is not present in the context grants: ${denied}`,
            });
          }

          const turnTools = toolsFor(turnAllow, integrations);

          const portableHandle = (
            handle: AgentSessionHandle,
          ): Effect.Effect<JsonValue, AgentDriverError> => {
            if (!Schema.is(AgentSessionHandleSchema)(handle)) {
              return Effect.fail(
                new AgentDriverError({
                  message: "Agent Session handle must be portable JSON data",
                }),
              );
            }
            const storedHandle: JsonValue = {
              id: handle.id,
              ...(handle.raw === undefined ? {} : { raw: handle.raw }),
            };
            return Effect.succeed(storedHandle);
          };

          const realizePlannedSession = (planned: AgentSession) =>
            Effect.gen(function* () {
              const handle = yield* driver.createSession({
                sessionId: planned.id,
                scopeId: planned.scopeId,
                workThreadId: planned.workThreadId,
                bindingKey,
                generation: planned.generation,
                idempotencyKey: planned.id,
              });
              const externalHandle = yield* portableHandle(handle);
              const session: AgentSession = {
                ...planned,
                externalHandle,
                state: "open",
                lastUsedAt: options.clock(),
              };
              yield* store.saveSession(session, sessionClaim.lease.token);
              return { session, handle };
            });

          const createGeneration = (previous: AgentSession | undefined) =>
            Effect.gen(function* () {
              const now = options.clock();
              const planned: AgentSession = {
                id: options.makeId(),
                bindingKey,
                agentId,
                authority,
                scopeId,
                workThreadId,
                privacyPartition,
                driverId: driver.id,
                generation: (previous?.generation ?? 0) + 1,
                state: "creating",
                createdAt: now,
                lastUsedAt: now,
              };
              // Persist the plan before the remote side effect. A replay invokes
              // createSession with the same idempotency key and generation.
              yield* store.saveSession(planned, sessionClaim.lease.token);
              return yield* realizePlannedSession(planned);
            });

          const existing = sessionClaim.session;
          const existingHandle = sessionHandleFrom(existing?.externalHandle);
          const canResumeExisting =
            existing !== undefined &&
            existing.driverId === driver.id &&
            existing.state === "open" &&
            existingHandle !== undefined &&
            capabilities.resume;
          const hasInFlightTurn = storedTurn !== undefined;

          // A persisted running Turn is bound to the Session generation that
          // dispatched it, even before the first event was durably observed.
          // Joining a new remote Session could repeat an already-started side
          // effect and would manufacture continuity the runtime does not have.
          if (
            hasInFlightTurn &&
            (!canResumeExisting || existing.id !== storedTurn.sessionId)
          ) {
            if (existing?.id === storedTurn.sessionId) {
              yield* store.saveSession(
                {
                  ...existing,
                  state: "interrupted",
                  lastUsedAt: options.clock(),
                },
                sessionClaim.lease.token,
              );
            }
            return yield* interruptStoredTurn(
              storedTurn,
              "The original Agent Session cannot resume this in-flight Turn",
            );
          }

          let prepared: {
            readonly session: AgentSession;
            readonly handle: AgentSessionHandle;
          };
          if (
            existing !== undefined &&
            existing.driverId === driver.id &&
            existing.state === "creating"
          ) {
            prepared = yield* realizePlannedSession(existing);
          } else if (canResumeExisting) {
            const resumed = yield* driver.resumeSession(existingHandle).pipe(
              Effect.map((handle) => ({ _tag: "Resumed" as const, handle })),
              Effect.catchTag("AgentSessionUnavailableError", () =>
                Effect.succeed({ _tag: "Unavailable" as const }),
              ),
            );
            if (resumed._tag === "Unavailable") {
              yield* store.saveSession(
                {
                  ...existing,
                  state: "expired",
                  lastUsedAt: options.clock(),
                },
                sessionClaim.lease.token,
              );
              if (hasInFlightTurn) {
                return yield* interruptStoredTurn(
                  storedTurn,
                  "The remote Agent Session expired during an in-flight Turn",
                );
              }
              prepared = yield* createGeneration(existing);
            } else {
              const externalHandle = yield* portableHandle(resumed.handle);
              const session: AgentSession = {
                ...existing,
                externalHandle,
                state: "open",
                lastUsedAt: options.clock(),
              };
              yield* store.saveSession(session, sessionClaim.lease.token);
              prepared = { session, handle: resumed.handle };
            }
          } else {
            if (
              existing !== undefined &&
              existing.driverId === driver.id &&
              existing.state === "open" &&
              existingHandle !== undefined
            ) {
              yield* driver.closeSession(existingHandle);
            }
            if (existing !== undefined) {
              yield* store.saveSession(
                {
                  ...existing,
                  state: existing.state === "expired" ? "expired" : "closed",
                  lastUsedAt: options.clock(),
                },
                sessionClaim.lease.token,
              );
            }
            prepared = yield* createGeneration(existing);
          }

          const { session, handle } = prepared;
          const now = options.clock();
          const runningTurn: Turn = {
            id: turnId,
            sessionId: session.id,
            triggerEventId: event.id,
            contextProjectionId:
              storedTurn?.contextProjectionId ?? input.context.id,
            contextDigest: storedTurn?.contextDigest ?? input.context.digest,
            allow: turnAllow,
            ...(turnFreshness === undefined
              ? {}
              : { freshness: turnFreshness }),
            state: "running",
            createdAt: storedTurn?.createdAt ?? now,
          };
          yield* store.saveTurn(
            runningTurn,
            bindingKey,
            sessionClaim.lease.token,
          );
          activeTurn = runningTurn;

          const pendingCancellation = yield* store.getTurnCancellation(turnId);
          if (pendingCancellation !== undefined) {
            if (capabilities.cancel) {
              yield* driver.cancel({ session: handle, turnId });
            }
            const sequence = (storedEvents.at(-1)?.seq ?? 0) + 1;
            const cancelledEvent: OpenMAEvent = createOpenMAEvent({
              event_id: `${turnId}:runtime-cancelled:${sequence}`,
              type: "turn.cancelled",
              session_id: session.id,
              turn_id: turnId,
              seq: sequence,
              occurred_at: options.clock(),
              source: { kind: "openma", adapter: "runtime" },
              data: {
                reason: "Cancellation requested by a WorkEvent",
              },
            });
            yield* store.appendAgentEvent(
              cancelledEvent,
              bindingKey,
              sessionClaim.lease.token,
            );
            const cancelledTurn: Turn = {
              ...runningTurn,
              state: "cancelled",
              completedAt: cancelledEvent.occurred_at,
            };
            yield* store.saveTurn(
              cancelledTurn,
              bindingKey,
              sessionClaim.lease.token,
            );
            activeTurn = undefined;
            return {
              session,
              turn: cancelledTurn,
              outcome: "cancelled" as const,
              events: [...storedEvents, cancelledEvent],
              output: outputFrom(storedEvents),
            };
          }

          liveTurns.set(bindingKey, {
            turnId,
            sessionId: session.id,
            handle,
            driver,
            steering:
              capabilities.steering === true && driver.steer !== undefined,
          });
          const lastSequence = storedEvents.at(-1)?.seq ?? 0;
          const interpreted = driver
            .turn({
              session: handle,
              sessionId: session.id,
              turnId,
              afterSequence: lastSequence,
              context: turnContext,
              allow: turnAllow,
              ...(turnTools.length === 0 ? {} : { tools: turnTools }),
            })
            .pipe(
              Stream.runFoldEffect(
                {
                  expectedSequence: lastSequence + 1,
                  events: storedEvents,
                  terminal: undefined as OpenMAEvent | undefined,
                },
                (state, agentEvent) =>
                  Effect.gen(function* () {
                    if (!Schema.is(OpenMAEventSchema)(agentEvent)) {
                      return yield* new AgentDriverError({
                        message: "Agent emitted an invalid OpenMAEvent",
                      });
                    }
                    const durableEvent = yield* Effect.try({
                      try: () => immutableJson(agentEvent) as OpenMAEvent,
                      catch: (cause) =>
                        new AgentDriverError({
                          message:
                            "Agent emitted an OpenMAEvent that is not an immutable JSON fact",
                          cause,
                        }),
                    });
                    if (state.terminal !== undefined) {
                      return yield* new AgentDriverError({
                        message:
                          "Agent emitted an event after its terminal event",
                      });
                    }
                    if (
                      durableEvent.session_id !== session.id ||
                      durableEvent.turn_id !== turnId
                    ) {
                      return yield* new AgentDriverError({
                        message:
                          "Agent event does not match the active session and turn",
                      });
                    }
                    if (
                      !Number.isInteger(durableEvent.seq) ||
                      durableEvent.seq !== state.expectedSequence
                    ) {
                      return yield* new AgentDriverError({
                        message: `Agent event sequence mismatch: expected ${state.expectedSequence}, received ${durableEvent.seq}`,
                      });
                    }

                    if (isPermissionRequestEvent(durableEvent)) {
                      if (!capabilities.permissions) {
                        return yield* new AgentDriverError({
                          message:
                            "Agent requested permission but its driver does not support permission responses",
                        });
                      }
                      const requestId = durableEvent.data.callback_id;
                      const requestFingerprint = durableEvent.data.fingerprint;
                      const storedDecision = yield* store.getPermissionDecision(
                        turnId,
                        requestId,
                      );
                      if (
                        storedDecision !== undefined &&
                        storedDecision.requestFingerprint !== requestFingerprint
                      ) {
                        return yield* new AgentDriverError({
                          message: `Permission request content changed for reused request id: ${requestId}`,
                        });
                      }
                      const decision =
                        storedDecision ??
                        (yield* decidePermission({
                          agentId,
                          requestId,
                          event: durableEvent,
                          context: turnContext,
                        }).pipe(
                          Effect.flatMap((approved) =>
                            store.commitPermissionDecision(
                              {
                                turnId,
                                requestId,
                                requestFingerprint,
                                approved,
                                decidedAt: options.clock(),
                              },
                              bindingKey,
                              sessionClaim.lease.token,
                            ),
                          ),
                        ));
                      // Respond before checkpointing the request. If the process
                      // dies between the two, replay may safely answer the same
                      // stable request id again rather than skipping a waiter.
                      yield* driver.respondToPermission({
                        session: handle,
                        requestId,
                        approved: decision.approved,
                      });
                    }
                    if (
                      isCallbackRequestEvent(durableEvent) &&
                      durableEvent.data.category === "extension" &&
                      durableEvent.data.method === OPERATION_CALL_METHOD
                    ) {
                      if (
                        capabilities.operations !== true ||
                        driver.respondToCallback === undefined
                      ) {
                        return yield* new AgentDriverError({
                          message:
                            "Agent called an operation but its driver does not support operation calls",
                        });
                      }
                      const result = yield* callOperation({
                        store,
                        integrations,
                        clock: options.clock,
                        turnId,
                        trigger: event,
                        allow: turnAllow,
                        freshness: turnFreshness ?? DEFAULT_FRESHNESS,
                        seen,
                        callId: durableEvent.data.callback_id,
                        fingerprint: durableEvent.data.fingerprint,
                        params: durableEvent.data.params,
                        bindingKey,
                        leaseToken: sessionClaim.lease.token,
                      });
                      // As with permissions: respond before checkpointing the
                      // request. Replay answers from the stored call.
                      yield* driver.respondToCallback({
                        session: handle,
                        callbackId: durableEvent.data.callback_id,
                        result: result as unknown as JsonValue,
                      });
                    }
                    const terminal = isTurnTerminalEvent(durableEvent)
                      ? durableEvent
                      : undefined;
                    // A terminal event becomes durable only after the Stream
                    // closes cleanly. Otherwise a later illegal event could
                    // turn a rejected stream into success on crash replay.
                    if (terminal === undefined) {
                      yield* store.appendAgentEvent(
                        durableEvent,
                        bindingKey,
                        sessionClaim.lease.token,
                      );
                    }
                    return {
                      expectedSequence: state.expectedSequence + 1,
                      events:
                        terminal === undefined
                          ? [...state.events, durableEvent]
                          : state.events,
                      terminal,
                    };
                  }),
              ),
              Effect.flatMap((state) => {
                if (state.terminal === undefined) {
                  return Effect.fail(
                    new AgentDriverError({
                      message: "Agent stream ended without a terminal event",
                    }),
                  );
                }
                return Effect.succeed({
                  ...state,
                  terminal: state.terminal,
                });
              }),
              Effect.onExit((exit) =>
                exit._tag === "Failure"
                  ? store
                      .saveTurn(
                        {
                          ...runningTurn,
                          state: Cause.isInterrupted(exit.cause)
                            ? "cancelled"
                            : "failed",
                          completedAt: options.clock(),
                        },
                        bindingKey,
                        sessionClaim.lease.token,
                      )
                      .pipe(Effect.catchAll(() => Effect.void))
                  : Effect.void,
              ),
              Effect.onInterrupt(() =>
                capabilities.cancel
                  ? store.getTurnCancellation(turnId).pipe(
                      Effect.flatMap((requested) =>
                        requested === undefined
                          ? driver.cancel({ session: handle, turnId })
                          : Effect.void,
                      ),
                      Effect.catchAll(() => Effect.void),
                    )
                  : Effect.void,
              ),
            );
          const waitForCancellation = (): Effect.Effect<
            NonNullable<
              Effect.Effect.Success<
                ReturnType<typeof store.getTurnCancellation>
              >
            >,
            StoreError
          > =>
            store
              .getTurnCancellation(turnId)
              .pipe(
                Effect.flatMap((requested) =>
                  requested === undefined
                    ? Effect.sleep("50 millis").pipe(
                        Effect.zipRight(waitForCancellation()),
                      )
                    : Effect.succeed(requested),
                ),
              );
          const cancelled = waitForCancellation().pipe(
            Effect.flatMap(() => store.getAgentEvents(turnId)),
            Effect.map((durableEvents) => {
              const sequence = (durableEvents.at(-1)?.seq ?? 0) + 1;
              const terminal: OpenMAEvent = createOpenMAEvent({
                event_id: `${turnId}:runtime-cancelled:${sequence}`,
                type: "turn.cancelled",
                session_id: session.id,
                turn_id: turnId,
                seq: sequence,
                occurred_at: options.clock(),
                source: { kind: "openma", adapter: "runtime" },
                data: { reason: "Cancellation requested by a WorkEvent" },
              });
              return {
                expectedSequence: sequence + 1,
                events: durableEvents,
                terminal,
              };
            }),
          );
          const streamState = yield* Effect.raceFirst(
            interpreted,
            cancelled,
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (liveTurns.get(bindingKey)?.turnId === turnId) {
                  liveTurns.delete(bindingKey);
                }
              }),
            ),
          );
          yield* store.appendAgentEvent(
            streamState.terminal,
            bindingKey,
            sessionClaim.lease.token,
          );
          const events = [...streamState.events, streamState.terminal];
          const outcome = turnTerminalStatus(streamState.terminal)!;
          const turn: Turn = {
            ...runningTurn,
            state: outcome === "interrupted" ? "cancelled" : outcome,
            completedAt: options.clock(),
          };
          yield* store.saveTurn(turn, bindingKey, sessionClaim.lease.token);
          activeTurn = undefined;

          return {
            session,
            turn,
            outcome,
            events,
            output: outputFrom(events),
          };
        });

        return yield* options.lease.withHeartbeat(
          claimedSession,
          options.sessionLeaseMs,
          (renewal) =>
            store.renewSessionLease(
              bindingKey,
              sessionClaim.lease.token,
              renewal,
            ),
        );
      }).pipe(
        Effect.onInterrupt(() => {
          if (activeSessionLease === undefined || activeTurn === undefined) {
            return Effect.void;
          }
          return StoreService.pipe(
            Effect.flatMap((store) =>
              store.saveTurn(
                {
                  ...activeTurn!,
                  state: "cancelled",
                  completedAt: options.clock(),
                },
                activeSessionLease!.bindingKey,
                activeSessionLease!.token,
              ),
            ),
            Effect.catchAll(() => Effect.void),
          );
        }),
        Effect.ensuring(
          Effect.suspend(() => {
            if (activeSessionLease === undefined) return Effect.void;
            return StoreService.pipe(
              Effect.flatMap((store) =>
                store.releaseSession(
                  activeSessionLease!.bindingKey,
                  activeSessionLease!.token,
                ),
              ),
              Effect.catchAll(() => Effect.void),
            );
          }),
        ),
      );
    });

  const cancel: AgentTurnRuntime["cancel"] = (
    event,
    agentId,
    authority,
    scopeId,
    workThreadId,
    privacyPartition,
  ) =>
    Effect.gen(function* () {
      const store = yield* StoreService;
      const drivers = yield* AgentDrivers;
      const bindingKey = bindingKeyFor(
        agentId,
        authority,
        scopeId,
        workThreadId,
        privacyPartition,
      );
      const cancellation = yield* store.requestTurnCancellation(
        bindingKey,
        event.id,
        options.clock(),
      );
      if (cancellation === undefined) {
        return { status: "idle" as const };
      }
      const session = yield* store.getSession(cancellation.sessionId);
      if (session === undefined) {
        return yield* new StoreError({
          message: `Cancellation references an unknown Agent Session: ${cancellation.sessionId}`,
        });
      }
      const driver = drivers.get(agentId);
      if (driver === undefined || session.driverId !== driver.id) {
        return yield* new AgentAccessError({
          agentId,
          message: `Unable to cancel unavailable agent: ${agentId}`,
        });
      }
      const handle = sessionHandleFrom(session.externalHandle);
      if (handle === undefined) {
        return yield* new AgentDriverError({
          message: "Stored Agent Session has no resumable cancellation handle",
        });
      }
      const capabilities = yield* driver.capabilities();
      if (!capabilities.cancel) {
        return yield* new AgentDriverError({
          message: `Agent Driver does not support cancellation: ${agentId}`,
        });
      }
      yield* driver.cancel({ session: handle, turnId: cancellation.turnId });
      return { status: "requested" as const, turnId: cancellation.turnId };
    });

  const steer: AgentTurnRuntime["steer"] = (
    event,
    agentId,
    authority,
    scopeId,
    workThreadId,
    privacyPartition,
    input,
  ) =>
    Effect.gen(function* () {
      const steerId = event.idempotencyKey;
      const known = steerOutcomes.get(steerId);
      if (known !== undefined) return known;
      const bindingKey = bindingKeyFor(
        agentId,
        authority,
        scopeId,
        workThreadId,
        privacyPartition,
      );
      const live = liveTurns.get(bindingKey);
      if (live === undefined) {
        return { status: "queued" as const, reason: "idle" as const };
      }
      if (!live.steering) {
        return {
          status: "queued" as const,
          reason: "unsupported" as const,
          turnId: live.turnId,
        };
      }
      const ack = yield* live.driver.steer!({
        session: live.handle,
        sessionId: live.sessionId,
        turnId: live.turnId,
        steerId,
        context: input.context,
      }).pipe(
        Effect.map((ack): AgentSteerResult =>
          ack.status === "accepted"
            ? { status: "live", turnId: live.turnId }
            : {
                status: "queued",
                reason: "rejected",
                turnId: live.turnId,
                detail: ack.reason,
              },
        ),
        Effect.catchAll((error) =>
          Effect.succeed<AgentSteerResult>({
            status: "queued",
            reason: "failed",
            turnId: live.turnId,
            detail: error.message,
          }),
        ),
        Effect.catchAllDefect((defect) =>
          Effect.succeed<AgentSteerResult>({
            status: "queued",
            reason: "failed",
            turnId: live.turnId,
            detail: String(defect),
          }),
        ),
      );
      // Only a live outcome is final; a refused steer may be retried as a
      // new Turn, which is idempotent by the Event.
      return ack.status === "live" ? rememberSteer(steerId, ack) : ack;
    });

  return { cancel, run, steer };
};

/** The allowed operations whose integration describes them as tools. */
const toolsFor = (
  allow: readonly string[],
  integrations: WorkIntegrationRegistry,
): readonly AgentTool[] =>
  allow.flatMap((name) => {
    for (const [integrationId, integration] of integrations) {
      if (!name.startsWith(`${integrationId}.`)) continue;
      const operation = name.slice(integrationId.length + 1);
      const descriptor = integration.manifest.tools?.[operation];
      if (
        descriptor === undefined ||
        !declares(integration.manifest.operations, operation)
      ) {
        continue;
      }
      return [
        {
          name,
          integrationId,
          operation,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
        },
      ];
    }
    return [];
  });

/** `"*"` declares every operation, as for Effects. */
const declares = (operations: readonly string[], operation: string) =>
  operations.includes("*") || operations.includes(operation);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Executes one operation an Agent called during its Turn: the grant, one
 * delivery per Turn/call id, and the result the Agent gets back. A call that
 * was started but not completed (a crash mid-delivery) is reported as
 * uncertain rather than delivered again.
 */
const callOperation = (input: {
  readonly store: OpenMatterStore;
  readonly integrations: WorkIntegrationRegistry;
  readonly clock: () => string;
  readonly turnId: string;
  readonly trigger: WorkEvent;
  readonly allow: readonly string[];
  readonly freshness: FreshnessPolicy;
  readonly seen: { revision: number };
  readonly callId: string;
  readonly fingerprint: string;
  readonly params: unknown;
  readonly bindingKey: string;
  readonly leaseToken: string;
}): Effect.Effect<OperationCallResult, AgentDriverError | StoreError> =>
  callOperationOnce(input).pipe(
    Effect.tap((result) => {
      if (result.status === "conflict") {
        input.seen.revision = Math.max(
          input.seen.revision,
          result.seenRevision,
        );
      }
    }),
  );

const bindSafely = (
  integration: WorkIntegration,
  operation: string,
  agentInput: JsonValue,
  trigger: WorkEvent,
): { readonly input: JsonValue } | { readonly refused: string } => {
  try {
    const bound = integration.bindToolInput!(operation, agentInput, trigger);
    if ("refused" in bound) return { refused: String(bound.refused) };
    return Schema.is(JsonValueSchema)(bound.input)
      ? { input: bound.input }
      : { refused: "The integration bound a non-JSON input" };
  } catch {
    return { refused: "The integration could not bind the call's input" };
  }
};

/** Whether a newer entry makes a write to the trigger's conversation stale. */
const counts = (
  entry: ConversationEntry,
  trigger: ConversationEntry,
  policy: FreshnessPolicy,
): boolean => {
  if (entry.eventId === trigger.eventId) return false;
  if (!policy.kinds.includes(entry.kind)) return false;
  if (
    policy.scope === "thread" &&
    (entry.threadId === undefined || entry.threadId !== trigger.threadId)
  ) {
    return false;
  }
  const sender = entry.sender;
  const senders = policy.senders;
  if (senders === "anyone") return true;
  if (sender === undefined) return false;
  if (senders === "humans") return sender.kind === "human";
  if (senders === "requester") return sender.id === trigger.sender?.id;
  return senders.ids.includes(sender.id);
};

const asMessage = (entry: ConversationEntry): ConversationMessage => ({
  kind: entry.kind,
  occurredAt: entry.occurredAt,
  ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
  ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
  ...(entry.sender === undefined ? {} : { sender: entry.sender }),
  ...(entry.text === undefined ? {} : { text: entry.text }),
});

/** How many times a guarded call re-checks a conversation that keeps moving. */
const FRESHNESS_ATTEMPTS = 5;

const callOperationOnce = (input: {
  readonly store: OpenMatterStore;
  readonly integrations: WorkIntegrationRegistry;
  readonly clock: () => string;
  readonly turnId: string;
  readonly trigger: WorkEvent;
  readonly allow: readonly string[];
  readonly freshness: FreshnessPolicy;
  readonly seen: { revision: number };
  readonly callId: string;
  readonly fingerprint: string;
  readonly params: unknown;
  readonly bindingKey: string;
  readonly leaseToken: string;
}): Effect.Effect<OperationCallResult, AgentDriverError | StoreError> =>
  Effect.gen(function* () {
    const { store, turnId, callId, fingerprint, bindingKey, leaseToken } =
      input;
    const complete = (result: OperationCallResult) =>
      store
        .completeOperationCall(
          turnId,
          callId,
          result,
          input.clock(),
          bindingKey,
          leaseToken,
        )
        .pipe(Effect.map((call) => call.result ?? result));

    const stored = yield* store.getOperationCall(turnId, callId);
    if (stored !== undefined && stored.fingerprint !== fingerprint) {
      return yield* new AgentDriverError({
        message: `Operation call content changed for reused callback id: ${callId}`,
      });
    }
    if (stored?.state === "completed" && stored.result !== undefined) {
      return stored.result;
    }
    if (stored?.state === "pending") {
      return yield* complete({
        status: "uncertain",
        reason:
          "The outcome of this call was not recorded before the Turn was interrupted; check before calling again",
      });
    }

    const params = isRecord(input.params) ? input.params : {};
    const integrationId =
      typeof params.integrationId === "string" ? params.integrationId : "";
    const operation =
      typeof params.operation === "string" ? params.operation : "";
    const callInput = params.input;
    const name = `${integrationId}.${operation}`;
    const integration = input.integrations.get(integrationId);
    const unbound =
      integrationId === "" ||
      operation === "" ||
      !Schema.is(JsonValueSchema)(callInput)
        ? "Operation call parameters must name an integration, an operation, and JSON input"
        : !input.allow.includes(name)
          ? `Operation is not allowed for this Turn: ${name}`
          : integration === undefined ||
              !declares(integration.manifest.operations, operation)
            ? `Unknown operation: ${name}`
            : undefined;
    // The host binds what the Agent must not choose, such as the target of a
    // reply. A binding that cannot be made refuses the call.
    const binding =
      unbound === undefined &&
      integration?.bindToolInput !== undefined &&
      integration.manifest.tools?.[operation] !== undefined &&
      Schema.is(JsonValueSchema)(callInput)
        ? bindSafely(integration, operation, callInput, input.trigger)
        : undefined;
    const refusal =
      unbound ??
      (binding !== undefined && "refused" in binding
        ? binding.refused
        : undefined);
    const deliveredInput =
      binding !== undefined && "input" in binding ? binding.input : callInput;

    const startedAt = input.clock();
    const call: OperationCall = {
      turnId,
      callId,
      fingerprint,
      integrationId,
      operation,
      input: Schema.is(JsonValueSchema)(deliveredInput) ? deliveredInput : null,
      state: "pending",
      startedAt,
    };
    const guarded =
      refusal === undefined &&
      integration?.manifest.tools?.[operation]?.freshness !== undefined;
    const trigger = guarded
      ? yield* store.getConversationEntry(input.trigger.id)
      : undefined;

    // A guarded call is inserted only while its conversation is still at the
    // revision it was checked at, so the check and the record are one store
    // transaction. A conversation that moved is checked again.
    let conflict: OperationCallResult | undefined;
    let begun: OperationCall | undefined;
    for (
      let attempt = 0;
      begun === undefined && attempt < FRESHNESS_ATTEMPTS;
      attempt++
    ) {
      if (trigger === undefined) {
        begun = yield* store
          .beginOperationCall(call, bindingKey, leaseToken)
          .pipe(
            Effect.catchTag("ConversationChangedError", (error) =>
              Effect.fail(
                new StoreError({
                  message:
                    "An unguarded operation call reported a conversation change",
                  cause: error,
                }),
              ),
            ),
          );
        break;
      }
      const key = trigger.conversationKey;
      const after = Math.max(trigger.revision, input.seen.revision);
      // One read: the entries after what was seen end at the current
      // revision, and none means the conversation is still at `after`.
      const entries = yield* store.listConversationEntries(key, after);
      const revision = entries.at(-1)?.revision ?? after;
      const newer = entries.filter((entry) =>
        counts(entry, trigger, input.freshness),
      );
      if (newer.length > 0) {
        conflict = {
          status: "conflict",
          effect: "not-applied",
          conflict: {
            reason: "newer_messages",
            messages: newer.map(asMessage),
          },
          seenRevision: revision,
        };
      }
      const guardedCall: OperationCall =
        conflict === undefined
          ? { ...call, conversation: { key, revision } }
          : call;
      begun = yield* store
        .beginOperationCall(guardedCall, bindingKey, leaseToken)
        .pipe(
          Effect.catchIf(
            (error): error is ConversationChangedError =>
              error instanceof ConversationChangedError,
            () => Effect.succeed(undefined),
          ),
        );
    }
    if (begun === undefined) {
      // The conversation kept moving. Record the call so a replay answers the
      // same way, and let the Agent decide.
      begun = yield* store
        .beginOperationCall(call, bindingKey, leaseToken)
        .pipe(
          Effect.catchTag("ConversationChangedError", (error) =>
            Effect.fail(
              new StoreError({
                message:
                  "An unguarded operation call reported a conversation change",
                cause: error,
              }),
            ),
          ),
        );
      conflict ??= {
        status: "failed",
        reason: "The conversation is changing too quickly; try again",
        retryable: true,
      };
    }
    if (begun.fingerprint !== fingerprint) {
      return yield* new AgentDriverError({
        message: `Operation call content changed for reused callback id: ${callId}`,
      });
    }
    if (begun.state === "completed" && begun.result !== undefined) {
      return begun.result;
    }
    if (begun.startedAt !== startedAt) {
      return yield* complete({
        status: "uncertain",
        reason: "Another attempt of this call is already in progress",
      });
    }
    if (refusal !== undefined || integration === undefined) {
      return yield* complete({
        status: "refused",
        reason: refusal ?? `Unknown operation: ${name}`,
      });
    }
    if (conflict !== undefined) return yield* complete(conflict);

    const effectId = `${turnId}:call:${callId}`;
    const effect: WorkEffect = {
      schemaVersion: "0.1",
      id: effectId,
      eventId: input.trigger.id,
      integrationId,
      operation,
      idempotencyKey: effectId,
      input: call.input,
    };
    if (!Schema.is(WorkEffectSchema)(effect)) {
      return yield* complete({
        status: "refused",
        reason: "Operation call could not be expressed as a WorkEffect",
      });
    }
    const result: OperationCallResult = yield* integration.deliver(effect).pipe(
      Effect.flatMap((delivered) =>
        Schema.is(ProviderDeliveryResultSchema)(delivered)
          ? Effect.succeed<OperationCallResult>({
              status: "delivered",
              ...(delivered.providerReceipt === undefined
                ? {}
                : { receipt: delivered.providerReceipt }),
            })
          : Effect.fail(
              new IntegrationError({
                message:
                  "Provider delivery result must contain only portable JSON data",
                retryable: false,
              }),
            ),
      ),
      Effect.catchAll((error: IntegrationError) =>
        Effect.succeed<OperationCallResult>(
          error.effectState === "not-applied"
            ? {
                status: "failed",
                reason: error.message,
                retryable: error.retryable,
              }
            : { status: "uncertain", reason: error.message },
        ),
      ),
      Effect.catchAllDefect(() =>
        Effect.succeed<OperationCallResult>({
          status: "uncertain",
          reason: "The integration failed while delivering the call",
        }),
      ),
    );
    return yield* complete(result);
  });
