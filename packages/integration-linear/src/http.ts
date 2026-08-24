import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import type { HttpEndpoint } from "@openmatter/http";
import { Data, Effect, Schema } from "effect";

export class LinearRequestVerificationError extends Data.TaggedError(
  "LinearRequestVerificationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LinearHttpIngressError extends Data.TaggedError(
  "LinearHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401 | 500;
  readonly cause?: unknown;
}> {}

export class LinearHttpSubmissionError extends Data.TaggedError(
  "LinearHttpSubmissionError",
)<{
  readonly message: string;
  readonly status: 503;
  readonly cause?: unknown;
}> {}

export interface LinearRequestVerificationInput {
  readonly signingSecret: string;
  readonly rawBody: string;
  readonly signature: string;
}

export interface LinearWebhookInput {
  readonly kind: "linear.webhook";
  readonly deliveryId: string;
  readonly eventName: string;
  readonly timestamp: string;
  readonly payload: JsonValue;
}

export interface LinearHttpRequestOptions {
  readonly signingSecret: string;
  readonly now?: () => number;
  readonly toleranceMilliseconds?: number;
}

export interface LinearHttpEndpointOptions extends LinearHttpRequestOptions {
  readonly path?: string;
  readonly submit: (input: LinearWebhookInput) => Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bytesFromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const verifyLinearRequest = (
  input: LinearRequestVerificationInput,
): Effect.Effect<boolean, LinearRequestVerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const signature = bytesFromHex(input.signature);
      if (signature === undefined) return false;
      const encoder = new TextEncoder();
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        encoder.encode(input.signingSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return globalThis.crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(input.rawBody),
      );
    },
    catch: (cause) =>
      new LinearRequestVerificationError({
        message: "Unable to verify Linear request",
        cause,
      }),
  });

export const decodeLinearHttpRequest = (
  request: Request,
  options: LinearHttpRequestOptions,
): Effect.Effect<LinearWebhookInput, LinearHttpIngressError> =>
  Effect.gen(function* () {
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        new LinearHttpIngressError({
          message: "Unable to read Linear request body",
          status: 400,
          cause,
        }),
    });
    const verified = yield* verifyLinearRequest({
      signingSecret: options.signingSecret,
      rawBody,
      signature: request.headers.get("linear-signature") ?? "",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LinearHttpIngressError({
            message: "Unable to verify Linear request",
            status: 500,
            cause,
          }),
      ),
    );
    if (!verified) {
      return yield* new LinearHttpIngressError({
        message: "Linear request signature is invalid",
        status: 401,
      });
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(rawBody) as unknown,
      catch: (cause) =>
        new LinearHttpIngressError({
          message: "Linear request body is malformed",
          status: 400,
          cause,
        }),
    });
    if (!isRecord(parsed) || !Schema.is(JsonValueSchema)(parsed)) {
      return yield* new LinearHttpIngressError({
        message: "Linear request body must be a JSON object",
        status: 400,
      });
    }
    const deliveryId = request.headers.get("linear-delivery") ?? "";
    const eventName = request.headers.get("linear-event") ?? "";
    const timestamp = request.headers.get("linear-timestamp") ?? "";
    if (deliveryId.length === 0 || eventName.length === 0) {
      return yield* new LinearHttpIngressError({
        message: "Linear delivery metadata is missing",
        status: 400,
      });
    }
    const webhookTimestamp = parsed.webhookTimestamp;
    const now = options.now?.() ?? Date.now();
    if (
      !Number.isSafeInteger(webhookTimestamp) ||
      Math.abs(now - (webhookTimestamp as number)) >
        (options.toleranceMilliseconds ?? 60_000)
    ) {
      return yield* new LinearHttpIngressError({
        message: "Linear request timestamp is invalid or stale",
        status: 401,
      });
    }
    return {
      kind: "linear.webhook",
      deliveryId,
      eventName,
      timestamp,
      payload: structuredClone(parsed) as JsonValue,
    };
  });

const jsonResponse = (status: number, error: string): Response =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const makeLinearHttpEndpoint = (
  options: LinearHttpEndpointOptions,
): HttpEndpoint => ({
  method: "POST",
  path: options.path ?? "/linear/events",
  handle: (request) =>
    Effect.runPromise(
      decodeLinearHttpRequest(request, options).pipe(
        Effect.flatMap((decoded) =>
          Effect.tryPromise({
            try: () => options.submit(decoded),
            catch: (cause) =>
              new LinearHttpSubmissionError({
                message: "Unable to submit Linear work",
                status: 503,
                cause,
              }),
          }),
        ),
        Effect.as(new Response(null, { status: 200 })),
        Effect.catchAll((error) =>
          Effect.succeed(jsonResponse(error.status, error.message)),
        ),
      ),
    ),
});
