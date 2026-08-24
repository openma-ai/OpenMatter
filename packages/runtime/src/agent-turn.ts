import {
  AgentDrivers,
  AgentDriverError,
  AgentSessionHandleSchema,
  OpenMAEventSchema,
  createOpenMAEvent,
  immutableJson,
  isPermissionRequestEvent,
  isTurnTerminalEvent,
  turnTerminalStatus,
  type AgentDriverRegistry,
  type AgentSessionHandle,
  type OpenMAEvent,
} from "@openmatter/agent";
import {
  type AgentSession,
  type JsonValue,
  type Turn,
  type WorkEvent,
} from "@openmatter/core";
import {
  StoreError,
  StoreService,
  type OpenMatterStore,
} from "@openmatter/store";
import { Cause, Effect, Schema, Stream } from "effect";
import {
  AgentAccessError,
  AuthorizationError,
  ContextProjectionError,
  SessionBusyError,
  type AgentPermissionPolicy,
  type AgentPermissionRequest,
  type AgentTurnOptions,
  type AgentTurnResult,
} from "./contracts.js";
import type { LeaseRuntime } from "./lease.js";
import { outputFrom, sessionHandleFrom } from "./portable-json.js";

export interface AgentTurnRuntime {
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
    OpenMatterStore | AgentDriverRegistry
  >;
}

export const makeAgentTurnRuntime = (options: {
  readonly clock: () => string;
  readonly makeId: () => string;
  readonly lease: LeaseRuntime;
  readonly sessionLeaseMs: number;
  readonly permissionPolicy?: AgentPermissionPolicy;
}): AgentTurnRuntime => {
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
        if (
          input.context.scopeId !== scopeId ||
          input.context.workThreadId !== workThreadId
        ) {
          return yield* new ContextProjectionError({
            message:
              "Context projection does not match the agent session binding",
          });
        }
        const bindingKey = JSON.stringify([
          agentId,
          authority,
          scopeId,
          workThreadId,
          privacyPartition,
        ]);
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
          const denied = turnAllow.find(
            (operation) => !turnContext.grants.includes(operation),
          );
          if (denied !== undefined) {
            return yield* new AuthorizationError({
              operation: denied,
              message: `Turn operation is not present in the context grants: ${denied}`,
            });
          }

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
            state: "running",
            createdAt: storedTurn?.createdAt ?? now,
          };
          yield* store.saveTurn(
            runningTurn,
            bindingKey,
            sessionClaim.lease.token,
          );
          activeTurn = runningTurn;

          const lastSequence = storedEvents.at(-1)?.seq ?? 0;
          const interpreted = driver
            .turn({
              session: handle,
              sessionId: session.id,
              turnId,
              afterSequence: lastSequence,
              context: turnContext,
              allow: turnAllow,
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
                  ? driver
                      .cancel({ session: handle, turnId })
                      .pipe(Effect.catchAll(() => Effect.void))
                  : Effect.void,
              ),
            );
          const streamState = yield* interpreted;
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

  return { run };
};
