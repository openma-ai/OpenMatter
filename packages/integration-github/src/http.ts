import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import type { HttpEndpoint } from "@openmatter/http";
import { Data, Effect, Schema } from "effect";
import { isRecord } from "./shared.js";

export class GitHubHttpIngressError extends Data.TaggedError(
  "GitHubHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401;
  readonly cause?: unknown;
}> {}

export class GitHubHttpSubmissionError extends Data.TaggedError(
  "GitHubHttpSubmissionError",
)<{
  readonly message: string;
  readonly status: 503;
  readonly cause?: unknown;
}> {}

export interface GitHubWebhookInput {
  readonly kind: "github.webhook";
  readonly eventName: string;
  readonly deliveryId: string;
  readonly payload: JsonValue;
}

export interface GitHubHttpEndpointOptions {
  readonly webhookSecret: string;
  readonly path?: string;
  readonly submit: (input: GitHubWebhookInput) => Promise<unknown>;
}

const bytesFromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const verifyGitHubRequest = (input: {
  readonly webhookSecret: string;
  readonly rawBody: string;
  readonly signature: string;
}): Effect.Effect<boolean, GitHubHttpIngressError> =>
  Effect.tryPromise({
    try: async () => {
      if (!input.signature.startsWith("sha256=")) return false;
      const signature = bytesFromHex(input.signature.slice(7));
      if (signature === undefined) return false;
      const encoder = new TextEncoder();
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        encoder.encode(input.webhookSecret),
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
      new GitHubHttpIngressError({
        message: "Unable to verify GitHub request",
        status: 401,
        cause,
      }),
  });

export const decodeGitHubHttpRequest = (
  request: Request,
  options: Pick<GitHubHttpEndpointOptions, "webhookSecret">,
): Effect.Effect<GitHubWebhookInput, GitHubHttpIngressError> =>
  Effect.gen(function* () {
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        new GitHubHttpIngressError({
          message: "Unable to read GitHub request body",
          status: 400,
          cause,
        }),
    });
    const verified = yield* verifyGitHubRequest({
      webhookSecret: options.webhookSecret,
      rawBody,
      signature: request.headers.get("x-hub-signature-256") ?? "",
    });
    if (!verified) {
      return yield* new GitHubHttpIngressError({
        message: "GitHub request signature is invalid",
        status: 401,
      });
    }
    const eventName = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    if (
      eventName === null ||
      eventName.length === 0 ||
      deliveryId === null ||
      deliveryId.length === 0
    ) {
      return yield* new GitHubHttpIngressError({
        message: "GitHub event and delivery headers are required",
        status: 400,
      });
    }
    const payload = yield* Effect.try({
      try: () => JSON.parse(rawBody) as unknown,
      catch: (cause) =>
        new GitHubHttpIngressError({
          message: "GitHub request body is malformed",
          status: 400,
          cause,
        }),
    });
    if (!isRecord(payload) || !Schema.is(JsonValueSchema)(payload)) {
      return yield* new GitHubHttpIngressError({
        message: "GitHub request body must be a portable JSON object",
        status: 400,
      });
    }
    return {
      kind: "github.webhook",
      eventName,
      deliveryId,
      payload: payload as JsonValue,
    };
  });

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const makeGitHubHttpEndpoint = (
  options: GitHubHttpEndpointOptions,
): HttpEndpoint => ({
  method: "POST",
  path: options.path ?? "/github/events",
  handle: (request) =>
    Effect.runPromise(
      decodeGitHubHttpRequest(request, options).pipe(
        Effect.flatMap((input) =>
          Effect.tryPromise({
            try: () => options.submit(input),
            catch: (cause) =>
              new GitHubHttpSubmissionError({
                message: "Unable to submit GitHub work",
                status: 503,
                cause,
              }),
          }).pipe(Effect.as(new Response(null, { status: 202 }))),
        ),
        Effect.catchAll((error) =>
          Effect.succeed(
            jsonResponse({ ok: false, error: error.message }, error.status),
          ),
        ),
      ),
    ),
});
