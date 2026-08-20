import { SocketModeClient } from "@slack/socket-mode";
import type { OpenMatterApplication } from "@openmatter/runtime";
import { Cause, Data, Effect, Fiber } from "effect";

export class LocalRuntimeError extends Data.TaggedError("LocalRuntimeError")<{
  readonly phase: "start" | "ingest" | "stop";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SocketModeEnvelope {
  readonly type: string;
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
  readonly client?: SocketModeClientPort;
  readonly clock?: () => number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly onError?: (error: LocalRuntimeError) => void;
}

export interface LocalSlackRuntime {
  readonly startEffect: Effect.Effect<void, LocalRuntimeError>;
  readonly stopEffect: Effect.Effect<void, LocalRuntimeError>;
  readonly runEffect: Effect.Effect<never, LocalRuntimeError>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

const socketInput = (eventType: string, body: unknown): unknown =>
  eventType === "slash_commands" &&
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body)
    ? { type: "slash_command", ...body }
    : body;

const isRetryable = (cause: {
  readonly _tag?: string;
  readonly retryable?: boolean;
}) =>
  cause._tag === "IntegrationError"
    ? cause.retryable === true
    : cause._tag === "EventBusyError" ||
      cause._tag === "SessionBusyError" ||
      cause._tag === "StoreError" ||
      cause._tag === "AgentDriverError";

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
  const clock = options.clock ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? 8;
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

  const acceptWithRetry = (
    input: unknown,
    attempt = 1,
  ): ReturnType<OpenMatterApplication["acceptFromEffect"]> =>
    Effect.suspend(() =>
      options.application.acceptFromEffect("slack", input).pipe(
        Effect.catchAll((cause) => {
          if (!isRetryable(cause) || attempt >= maxAttempts) {
            return Effect.fail(cause);
          }
          return Effect.sleep(retryDelay(cause, clock(), retryDelayMs)).pipe(
            Effect.zipRight(acceptWithRetry(input, attempt + 1)),
          );
        }),
      ),
    );

  const envelopeProgram = (envelope: SocketModeEnvelope) =>
    Effect.tryPromise({
      try: () => envelope.ack(),
      catch: (cause) =>
        new LocalRuntimeError({
          phase: "ingest",
          message: `Unable to acknowledge Slack ${envelope.type} envelope`,
          cause,
        }),
    }).pipe(
      Effect.flatMap(() =>
        Effect.try({
          try: () => structuredClone(socketInput(envelope.type, envelope.body)),
          catch: (cause) =>
            new LocalRuntimeError({
              phase: "ingest",
              message: `Slack ${envelope.type} envelope is not portable data`,
              cause,
            }),
        }).pipe(
          Effect.flatMap(acceptWithRetry),
          Effect.mapError(
            (cause) =>
              new LocalRuntimeError({
                phase: "ingest",
                message: `Unable to process Slack ${envelope.type} envelope`,
                cause,
              }),
          ),
        ),
      ),
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
      return Promise.resolve();
    }
    if (starting !== undefined) return starting;
    attachListener();
    const pending = Promise.resolve()
      .then(() => client.start())
      .then(() => {
        started = true;
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
    start: () => Effect.runPromise(startEffect),
    stop: () => Effect.runPromise(stopEffect),
  };
};
