import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import type { HttpEndpoint } from "@openmatter/http";
import { Data, Effect, Schema } from "effect";
import { isRecord, withoutSlackCredentials } from "./shared.js";

export class SlackRequestVerificationError extends Data.TaggedError(
  "SlackRequestVerificationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SlackHttpIngressError extends Data.TaggedError(
  "SlackHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401;
  readonly cause?: unknown;
}> {}

export class SlackHttpSubmissionError extends Data.TaggedError(
  "SlackHttpSubmissionError",
)<{
  readonly message: string;
  readonly status: 503;
  readonly cause?: unknown;
}> {}

export interface SlackRequestVerificationInput {
  readonly signingSecret: string;
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly now?: () => number;
  readonly toleranceSeconds?: number;
}

const bytesFromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const verifySlackRequest = (
  input: SlackRequestVerificationInput,
): Effect.Effect<boolean, SlackRequestVerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const timestamp = Number.parseInt(input.timestamp, 10);
      const now = input.now?.() ?? Math.floor(Date.now() / 1_000);
      if (
        !Number.isSafeInteger(timestamp) ||
        Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)
      ) {
        return false;
      }
      if (!input.signature.startsWith("v0=")) return false;
      const signature = bytesFromHex(input.signature.slice(3));
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
        encoder.encode(`v0:${input.timestamp}:${input.rawBody}`),
      );
    },
    catch: (cause) =>
      new SlackRequestVerificationError({
        message: "Unable to verify Slack request",
        cause,
      }),
  });

export interface SlackHttpRequestOptions {
  readonly signingSecret: string;
  readonly now?: () => number;
  readonly toleranceSeconds?: number;
}

export type SlackHttpRequestResult =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "input"; readonly input: JsonValue };

export interface SlackHttpEndpointOptions extends SlackHttpRequestOptions {
  readonly path?: string;
  readonly submit: (input: JsonValue) => Promise<unknown>;
}

const parseSlackHttpBody = (rawBody: string, contentType: string): unknown => {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const parameters = new URLSearchParams(rawBody);
    const interactivePayload = parameters.get("payload");
    if (interactivePayload !== null) return JSON.parse(interactivePayload);
    return { type: "slash_command", ...Object.fromEntries(parameters) };
  }
  return JSON.parse(rawBody);
};

export const decodeSlackHttpRequest = (
  request: Request,
  options: SlackHttpRequestOptions,
): Effect.Effect<SlackHttpRequestResult, SlackHttpIngressError> =>
  Effect.gen(function* () {
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        new SlackHttpIngressError({
          message: "Unable to read Slack request body",
          status: 400,
          cause,
        }),
    });
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";
    const verified = yield* verifySlackRequest({
      signingSecret: options.signingSecret,
      rawBody,
      timestamp,
      signature,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.toleranceSeconds === undefined
        ? {}
        : { toleranceSeconds: options.toleranceSeconds }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SlackHttpIngressError({
            message: "Unable to verify Slack request",
            status: 401,
            cause,
          }),
      ),
    );
    if (!verified) {
      return yield* new SlackHttpIngressError({
        message: "Slack request signature is invalid or expired",
        status: 401,
      });
    }
    const parsed = yield* Effect.try({
      try: () =>
        parseSlackHttpBody(
          rawBody,
          request.headers.get("content-type") ?? "application/json",
        ),
      catch: (cause) =>
        new SlackHttpIngressError({
          message: "Slack request body is malformed",
          status: 400,
          cause,
        }),
    });
    if (!isRecord(parsed) || !Schema.is(JsonValueSchema)(parsed)) {
      return yield* new SlackHttpIngressError({
        message: "Slack request body must be a portable JSON object",
        status: 400,
      });
    }
    if (parsed.type === "url_verification") {
      if (typeof parsed.challenge !== "string") {
        return yield* new SlackHttpIngressError({
          message: "Slack URL verification is missing its challenge",
          status: 400,
        });
      }
      return { kind: "challenge", challenge: parsed.challenge };
    }
    return { kind: "input", input: withoutSlackCredentials(parsed) };
  });

const slackJsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Provider-owned endpoint that can be mounted by any OpenMatter HTTP
 * framework component. Signature verification stays beside Slack decoding. */
export const makeSlackHttpEndpoint = (
  options: SlackHttpEndpointOptions,
): HttpEndpoint => ({
  method: "POST",
  path: options.path ?? "/slack/events",
  handle: (request) =>
    Effect.runPromise(
      decodeSlackHttpRequest(request, options).pipe(
        Effect.flatMap((decoded) => {
          if (decoded.kind === "challenge") {
            return Effect.succeed(
              slackJsonResponse({ challenge: decoded.challenge }, 200),
            );
          }
          return Effect.tryPromise({
            try: () => options.submit(decoded.input),
            catch: (cause) =>
              new SlackHttpSubmissionError({
                message: "Unable to submit Slack work",
                status: 503,
                cause,
              }),
          }).pipe(Effect.as(new Response(null, { status: 200 })));
        }),
        Effect.catchAll((error) =>
          Effect.succeed(
            slackJsonResponse(
              { ok: false, error: error.message },
              error.status,
            ),
          ),
        ),
      ),
    ),
});
