import { SocketModeClient } from "@slack/socket-mode";
import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import type { DurableInbox, InboxClaim } from "@openmatter/inbox";
import type { OpenMatterApplication } from "@openmatter/runtime";
import { Cause, Data, Duration, Effect, Fiber, Option, Schema } from "effect";

export class LocalRuntimeError extends Data.TaggedError("LocalRuntimeError")<{
  readonly phase: "start" | "ingest" | "recovery" | "stop";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SocketModeEnvelope {
  readonly type: string;
  readonly envelope_id: string;
  readonly body: unknown;
  readonly ack: (payload?: unknown) => Promise<void>;
}

export type SocketModeListener = (
  envelope: SocketModeEnvelope,
) => Promise<void> | void;

export interface SocketModeClientPort {
  readonly on: (event: string, listener: SocketModeListener) => unknown;
  readonly off: (event: string, listener?: SocketModeListener) => unknown;
  readonly start: () => Promise<unknown>;
  readonly disconnect: () => Promise<void>;
}

export interface LocalSlackRuntimeOptions {
  readonly appToken: string;
  readonly application: OpenMatterApplication;
  /** Durable transport inbox. Slack is acknowledged only after enqueue. */
  readonly inbox: DurableInbox;
  readonly client?: SocketModeClientPort;
  readonly clock?: () => number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly inboxOwnerId?: string;
  readonly inboxLeaseMs?: number;
  readonly inboxPollIntervalMs?: number;
  readonly inboxBatchSize?: number;
  readonly inboxConcurrency?: number;
  /** Host-owned durable outbox recovery cadence. Set false to use an external
   * scheduler instead. */
  readonly recoveryIntervalMs?: number | false;
  readonly onError?: (error: LocalRuntimeError) => void;
}

export interface LocalSlackRuntime {
  readonly startEffect: Effect.Effect<void, LocalRuntimeError>;
  readonly stopEffect: Effect.Effect<void, LocalRuntimeError>;
  readonly runEffect: Effect.Effect<never, LocalRuntimeError>;
  readonly recoverEffect: Effect.Effect<void, LocalRuntimeError>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly recover: () => Promise<void>;
}

const socketInput = (eventType: string, body: unknown): unknown =>
  eventType === "slash_commands" &&
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body)
    ? { type: "slash_command", ...body }
    : body;

const isRetryable = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null) return false;
  const tagged = cause as {
    readonly _tag?: string;
    readonly retryable?: boolean;
  };
  return tagged._tag === "IntegrationError"
    ? tagged.retryable === true
    : tagged._tag === "EventBusyError" ||
        tagged._tag === "SessionBusyError" ||
        tagged._tag === "StoreError" ||
        tagged._tag === "AgentDriverError";
};

const retryDelay = (cause: unknown, now: number, fallback: number) => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "retryAt" in cause &&
    typeof cause.retryAt === "string"
  ) {
    const retryAt = Date.parse(cause.retryAt);
    if (Number.isFinite(retryAt)) {
      return Math.max(fallback, retryAt - now);
    }
  }
  return fallback;
};

const positiveInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const nonNegativeInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;

export const makeLocalSlackRuntime = (
  options: LocalSlackRuntimeOptions,
): LocalSlackRuntime => {
  const client =
    options.client ??
    (new SocketModeClient({
      appToken: options.appToken,
    }) as SocketModeClientPort);
  const listeners = new Map<string, SocketModeListener>();
  const inFlight = new Set<Fiber.RuntimeFiber<void, never>>();
  const consumerWake = Effect.unsafeMakeLatch();
  const clock = options.clock ?? Date.now;
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, 1_000);
  const maxAttempts = positiveInteger(
    options.maxAttempts,
    Number.MAX_SAFE_INTEGER,
  );
  const inboxOwnerId =
    options.inboxOwnerId ?? `local-${globalThis.crypto.randomUUID()}`;
  const inboxLeaseMs = positiveInteger(options.inboxLeaseMs, 60_000);
  const inboxPollIntervalMs = positiveInteger(options.inboxPollIntervalMs, 250);
  const inboxBatchSize = positiveInteger(options.inboxBatchSize, 32);
  const inboxConcurrency = positiveInteger(options.inboxConcurrency, 8);
  const recoveryIntervalMs =
    options.recoveryIntervalMs === false
      ? false
      : typeof options.recoveryIntervalMs === "number" &&
          Number.isFinite(options.recoveryIntervalMs) &&
          options.recoveryIntervalMs > 0
        ? Math.floor(options.recoveryIntervalMs)
        : 30_000;
  let recoveryFiber: Fiber.RuntimeFiber<never, never> | undefined;
  let consumerFiber: Fiber.RuntimeFiber<never, never> | undefined;
  let started = false;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const detachListeners = () => {
    for (const [eventType, registered] of listeners) {
      client.off(eventType, registered);
    }
    listeners.clear();
  };

  const report = (error: LocalRuntimeError): Effect.Effect<void> =>
    Effect.sync(() => {
      try {
        options.onError?.(error);
      } catch {
        // Observability hooks must never change envelope lifecycle semantics.
      }
    });

  const recoverEffect = Effect.suspend(() =>
    options.application.recoverEffectsEffect(),
  ).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new LocalRuntimeError({
          phase: "recovery",
          message: "Unable to recover pending OpenMatter effects",
          cause,
        }),
    ),
  );

  const startRecovery = () => {
    if (recoveryIntervalMs === false || recoveryFiber !== undefined) return;
    const fiber = Effect.runFork(
      Effect.forever(
        Effect.sleep(recoveryIntervalMs).pipe(
          Effect.zipRight(recoverEffect),
          Effect.catchAll(report),
        ),
      ),
    );
    recoveryFiber = fiber;
    fiber.addObserver(() => {
      if (recoveryFiber === fiber) recoveryFiber = undefined;
    });
  };

  const errorMessage = (cause: unknown) =>
    cause instanceof Error ? cause.message : String(cause);

  const processClaim = (claim: InboxClaim): Effect.Effect<void> => {
    const settle = Effect.suspend(() =>
      options.application.acceptFromEffect(
        claim.item.integrationId,
        claim.item.body,
      ),
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.isInterruptedOnly(cause)) return Effect.interrupt;
          const failure = Cause.failureOption(cause);
          const reportedCause = Option.isSome(failure)
            ? failure.value
            : Cause.squash(cause);
          const error = new LocalRuntimeError({
            phase: "ingest",
            message: `Unable to process durable ${claim.item.eventType} envelope`,
            cause: reportedCause,
          });
          const settlement =
            (Option.isNone(failure) || isRetryable(failure.value)) &&
            claim.attempt < maxAttempts
              ? options.inbox.retry(claim.item.id, claim.lease.token, {
                  delayMs: retryDelay(reportedCause, clock(), retryDelayMs),
                  error: errorMessage(reportedCause),
                })
              : options.inbox.complete(claim.item.id, claim.lease.token);
          return settlement.pipe(Effect.zipRight(report(error)));
        },
        onSuccess: () =>
          options.inbox.complete(claim.item.id, claim.lease.token),
      }),
    );
    const heartbeat: Effect.Effect<never, unknown> = Effect.forever(
      Effect.sleep(
        Duration.millis(Math.max(1, Math.floor(inboxLeaseMs / 3))),
      ).pipe(
        Effect.zipRight(
          options.inbox.renew(claim.item.id, claim.lease.token, {
            durationMs: inboxLeaseMs,
          }),
        ),
      ),
    );
    return Effect.raceFirst(settle, heartbeat).pipe(
      Effect.onInterrupt(() =>
        options.inbox
          .retry(claim.item.id, claim.lease.token, {
            delayMs: 0,
            error: "Local runtime interrupted",
          })
          .pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.interrupt
          : report(
              new LocalRuntimeError({
                phase: "ingest",
                message: `Unable to settle durable ${claim.item.eventType} envelope`,
                cause: Cause.squash(cause),
              }),
            ),
      ),
    );
  };

  const drainOnce = () =>
    options.inbox
      .claim({
        ownerId: inboxOwnerId,
        durationMs: inboxLeaseMs,
        limit: inboxBatchSize,
      })
      .pipe(
        Effect.flatMap((claims) =>
          Effect.forEach(claims, processClaim, {
            concurrency: inboxConcurrency,
            discard: true,
          }),
        ),
      );

  const startConsumer = () => {
    if (consumerFiber !== undefined) return;
    const fiber = Effect.runFork(
      Effect.forever(
        consumerWake.close.pipe(
          Effect.zipRight(drainOnce()),
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.interrupt
              : report(
                  new LocalRuntimeError({
                    phase: "ingest",
                    message: "Unable to claim durable Socket Mode envelopes",
                    cause: Cause.squash(cause),
                  }),
                ),
          ),
          Effect.zipRight(
            Effect.raceFirst(
              consumerWake.await,
              Effect.sleep(Duration.millis(inboxPollIntervalMs)),
            ),
          ),
        ),
      ),
    );
    consumerFiber = fiber;
    fiber.addObserver(() => {
      if (consumerFiber === fiber) consumerFiber = undefined;
    });
  };

  const envelopeProgram = (envelope: SocketModeEnvelope) =>
    Effect.gen(function* () {
      if (
        typeof envelope.envelope_id !== "string" ||
        envelope.envelope_id.length === 0
      ) {
        return yield* new LocalRuntimeError({
          phase: "ingest",
          message: `Slack ${envelope.type} envelope is missing envelope_id`,
        });
      }
      const body = yield* Effect.try({
        try: (): JsonValue => {
          const value = structuredClone(
            socketInput(envelope.type, envelope.body),
          );
          if (!Schema.is(JsonValueSchema)(value)) {
            throw new Error("Socket envelope body is not portable JSON");
          }
          return value;
        },
        catch: (cause) =>
          new LocalRuntimeError({
            phase: "ingest",
            message: `Slack ${envelope.type} envelope is not portable data`,
            cause,
          }),
      });
      const itemId = `slack:${envelope.envelope_id}`;
      yield* options.inbox
        .enqueue({
          id: itemId,
          idempotencyKey: itemId,
          integrationId: "slack",
          eventType: envelope.type,
          body,
          receivedAt: new Date(clock()).toISOString(),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new LocalRuntimeError({
                phase: "ingest",
                message: `Unable to persist Slack ${envelope.type} envelope`,
                cause,
              }),
          ),
        );
      yield* Effect.tryPromise({
        try: () => envelope.ack(),
        catch: (cause) =>
          new LocalRuntimeError({
            phase: "ingest",
            message: `Unable to acknowledge Slack ${envelope.type} envelope`,
            cause,
          }),
      });
      yield* consumerWake.open;
    }).pipe(
      Effect.asVoid,
      Effect.catchAll(report),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : report(
              new LocalRuntimeError({
                phase: "ingest",
                message: `Slack ${envelope.type} envelope terminated unexpectedly`,
                cause,
              }),
            ),
      ),
    );

  const listener: SocketModeListener = (envelope) => {
    const fiber = Effect.runFork(envelopeProgram(envelope));
    inFlight.add(fiber);
    fiber.addObserver(() => inFlight.delete(fiber));
    return Effect.runPromise(Fiber.await(fiber)).then(() => undefined);
  };

  const attachListener = () => {
    listeners.set("slack_event", listener);
    client.on("slack_event", listener);
  };

  const startOnce = (): Promise<void> => {
    if (stopping !== undefined) return stopping.then(startOnce);
    if (started) {
      if (listeners.size === 0) attachListener();
      startRecovery();
      return Promise.resolve();
    }
    if (starting !== undefined) return starting;
    attachListener();
    const pending = Promise.resolve()
      .then(() => client.start())
      .then(() => {
        started = true;
        startConsumer();
        startRecovery();
      })
      .catch((cause) => {
        detachListeners();
        throw cause;
      })
      .finally(() => {
        if (starting === pending) starting = undefined;
      });
    starting = pending;
    return pending;
  };

  const stopOnce = (): Promise<void> => {
    if (stopping !== undefined) return stopping;
    const pending = Promise.resolve()
      .then(async () => {
        if (starting !== undefined) {
          try {
            await starting;
          } catch {
            // The start path already detached its listener.
          }
        }
        detachListeners();
        if (recoveryFiber !== undefined) {
          const fiber = recoveryFiber;
          recoveryFiber = undefined;
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
        if (consumerFiber !== undefined) {
          const fiber = consumerFiber;
          consumerFiber = undefined;
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
        await Effect.runPromise(Fiber.interruptAll([...inFlight]));
        if (started) {
          await client.disconnect();
          started = false;
        }
      })
      .finally(() => {
        if (stopping === pending) stopping = undefined;
      });
    stopping = pending;
    return pending;
  };

  const startEffect = Effect.tryPromise({
    try: startOnce,
    catch: (cause) =>
      new LocalRuntimeError({
        phase: "start",
        message: "Unable to start Slack Socket Mode",
        cause,
      }),
  });

  const stopEffect = Effect.tryPromise({
    try: stopOnce,
    catch: (cause) =>
      new LocalRuntimeError({
        phase: "stop",
        message: "Unable to stop Slack Socket Mode",
        cause,
      }),
  });

  const runEffect = Effect.scoped(
    Effect.acquireRelease(startEffect, () =>
      stopEffect.pipe(Effect.orDie),
    ).pipe(Effect.flatMap(() => Effect.never)),
  );

  return {
    startEffect,
    stopEffect,
    runEffect,
    recoverEffect,
    start: () => Effect.runPromise(startEffect),
    stop: () => Effect.runPromise(stopEffect),
    recover: () => Effect.runPromise(recoverEffect),
  };
};
