import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import {
  decodeSlackHttpRequest,
  type SlackHttpIngressError,
} from "@openmatter/integration-slack";
import type { OpenMatterApplication } from "@openmatter/runtime";
import { Effect, Schema } from "effect";

export interface OpenMatterIngressJob {
  readonly schemaVersion: "0.1";
  readonly integrationId: string;
  readonly input: JsonValue;
}

export interface CloudflareQueuePort {
  readonly send: (body: OpenMatterIngressJob) => Promise<unknown>;
}

export interface CloudflareQueueMessage {
  readonly body: unknown;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface CloudflareQueueBatch {
  readonly messages: readonly CloudflareQueueMessage[];
}

export interface CloudflareRuntimeOptions<Environment> {
  readonly application: (environment: Environment) => OpenMatterApplication;
  readonly clock?: () => number;
  readonly retryDelaySeconds?: number;
  readonly onError?: (
    cause: unknown,
    job: OpenMatterIngressJob | undefined,
  ) => void;
  readonly slack: {
    readonly path?: string;
    readonly signingSecret: (environment: Environment) => string;
    readonly queue: (environment: Environment) => CloudflareQueuePort;
    readonly now?: () => number;
  };
}

export interface CloudflareRuntime<Environment> {
  readonly fetchEffect: (
    request: Request,
    environment: Environment,
  ) => Effect.Effect<Response>;
  readonly fetch: (
    request: Request,
    environment: Environment,
  ) => Promise<Response>;
  readonly queueEffect: (
    batch: CloudflareQueueBatch,
    environment: Environment,
  ) => Effect.Effect<void>;
  readonly queue: (
    batch: CloudflareQueueBatch,
    environment: Environment,
  ) => Promise<void>;
}

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const isIngressJob = (value: unknown): value is OpenMatterIngressJob =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>).schemaVersion === "0.1" &&
  typeof (value as Record<string, unknown>).integrationId === "string" &&
  Schema.is(JsonValueSchema)((value as Record<string, unknown>).input);

const ingressFailureResponse = (error: SlackHttpIngressError): Response =>
  jsonResponse({ ok: false, error: error.message }, error.status);

const shouldRetry = (cause: {
  readonly _tag?: string;
  readonly retryable?: boolean;
}) =>
  cause._tag === "IntegrationError"
    ? cause.retryable === true
    : cause._tag !== "WorkEventValidationError";

const retryDelaySeconds = (
  cause: { readonly retryAt?: string },
  now: number,
  fallback: number,
) => {
  if (typeof cause.retryAt === "string") {
    const retryAt = Date.parse(cause.retryAt);
    if (Number.isFinite(retryAt)) {
      return Math.max(1, Math.ceil((retryAt - now) / 1_000));
    }
  }
  return fallback;
};

const report = (
  observer: CloudflareRuntimeOptions<unknown>["onError"],
  cause: unknown,
  job: OpenMatterIngressJob | undefined,
) => {
  try {
    observer?.(cause, job);
  } catch {
    // Observability hooks must never change queue acknowledgement semantics.
  }
};

export const makeCloudflareRuntime = <Environment>(
  options: CloudflareRuntimeOptions<Environment>,
): CloudflareRuntime<Environment> => {
  const path = options.slack.path ?? "/slack/events";
  const clock = options.clock ?? Date.now;
  const fallbackRetryDelaySeconds = options.retryDelaySeconds ?? 30;
  const retry = (message: CloudflareQueueMessage, cause: unknown) =>
    message.retry({
      delaySeconds: retryDelaySeconds(
        typeof cause === "object" && cause !== null ? cause : {},
        clock(),
        fallbackRetryDelaySeconds,
      ),
    });

  const fetchEffect = (request: Request, environment: Environment) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== path) {
      return Effect.succeed(jsonResponse({ ok: false }, 404));
    }
    return decodeSlackHttpRequest(request, {
      signingSecret: options.slack.signingSecret(environment),
      ...(options.slack.now === undefined ? {} : { now: options.slack.now }),
    }).pipe(
      Effect.flatMap((decoded) => {
        if (decoded.kind === "challenge") {
          return Effect.succeed(
            jsonResponse({ challenge: decoded.challenge }, 200),
          );
        }
        const job: OpenMatterIngressJob = {
          schemaVersion: "0.1",
          integrationId: "slack",
          input: structuredClone(decoded.input),
        };
        return Effect.tryPromise({
          try: () => options.slack.queue(environment).send(job),
          catch: () => undefined,
        }).pipe(
          Effect.match({
            onFailure: () =>
              jsonResponse({ ok: false, error: "queue unavailable" }, 503),
            onSuccess: () => jsonResponse({ ok: true }, 200),
          }),
        );
      }),
      Effect.catchAll((error) => Effect.succeed(ingressFailureResponse(error))),
    );
  };

  const queueEffect = (
    batch: CloudflareQueueBatch,
    environment: Environment,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const application = yield* Effect.try({
        try: () => options.application(environment),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) => {
          report(options.onError, cause, undefined);
          for (const message of batch.messages) retry(message, cause);
          return Effect.succeed(undefined);
        }),
      );
      if (application === undefined) return;
      yield* Effect.forEach(
        batch.messages,
        (message) => {
          if (!isIngressJob(message.body)) {
            message.ack();
            return Effect.void;
          }
          const job = structuredClone(message.body);
          return application
            .acceptFromEffect(job.integrationId, job.input)
            .pipe(
              Effect.match({
                onFailure: (cause) => {
                  report(options.onError, cause, job);
                  if (shouldRetry(cause)) retry(message, cause);
                  else message.ack();
                },
                onSuccess: () => message.ack(),
              }),
            );
        },
        { concurrency: 8, discard: true },
      );
    });

  return {
    fetchEffect,
    fetch: (request, environment) =>
      Effect.runPromise(fetchEffect(request, environment)),
    queueEffect,
    queue: (batch, environment) =>
      Effect.runPromise(queueEffect(batch, environment)),
  };
};
