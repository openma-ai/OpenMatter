import { JsonValueSchema, type JsonValue } from "@openma/matter";
import type { HttpEndpoint } from "@openma/matter/http";
import { Data, Effect, Schema } from "effect";
import { isRecord } from "./shared.js";

export class GitLabHttpIngressError extends Data.TaggedError(
  "GitLabHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401;
  readonly cause?: unknown;
}> {}

export class GitLabHttpSubmissionError extends Data.TaggedError(
  "GitLabHttpSubmissionError",
)<{
  readonly message: string;
  readonly status: 503;
  readonly cause?: unknown;
}> {}

/** One verified GitLab webhook delivery, ready for `integration.ingest`. */
export interface GitLabWebhookInput {
  readonly kind: "gitlab.webhook";
  /**
   * Who received the webhook, chosen by the host (for example a Bond id).
   * It becomes the Event source authority and selects credentials for replies.
   */
  readonly authority: string;
  /** The `X-Gitlab-Event` header, for example `Merge Request Hook`. */
  readonly eventName: string;
  /** Stable across GitLab retries; see `decodeGitLabHttpRequest`. */
  readonly deliveryId: string;
  /** The `X-Gitlab-Instance` header (GitLab 15.5+), when present. */
  readonly instance?: string;
  readonly payload: JsonValue;
}

export interface GitLabHttpEndpointOptions {
  /** The secret token configured on the GitLab webhook. */
  readonly webhookToken: string;
  readonly authority: string;
  readonly path?: string;
  readonly submit: (input: GitLabWebhookInput) => Promise<unknown>;
}

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );

/**
 * Compares the `X-Gitlab-Token` header with the configured secret token in
 * constant time. Both values are hashed first, so the comparison does not
 * reveal the secret's length either. An empty configured token never matches.
 */
export const verifyGitLabToken = (input: {
  readonly webhookToken: string;
  readonly received: string;
}): Effect.Effect<boolean, GitLabHttpIngressError> =>
  Effect.tryPromise({
    try: async () => {
      if (input.webhookToken.length === 0) return false;
      const [expected, received] = await Promise.all([
        sha256(input.webhookToken),
        sha256(input.received),
      ]);
      let difference = 0;
      for (let index = 0; index < expected.length; index += 1) {
        difference |= expected[index]! ^ received[index]!;
      }
      return difference === 0;
    },
    catch: (cause) =>
      new GitLabHttpIngressError({
        message: "Unable to verify GitLab request",
        status: 401,
        cause,
      }),
  });

const header = (request: Request, name: string): string | undefined => {
  const value = request.headers.get(name);
  return value === null || value.length === 0 ? undefined : value;
};

/**
 * Verifies and decodes one GitLab webhook request. The delivery id is the
 * first of `webhook-id` and `Idempotency-Key` (both stable across retries,
 * GitLab 17.4+) and `X-Gitlab-Event-UUID` (GitLab 14.8+).
 */
export const decodeGitLabHttpRequest = (
  request: Request,
  options: Pick<GitLabHttpEndpointOptions, "webhookToken" | "authority">,
): Effect.Effect<GitLabWebhookInput, GitLabHttpIngressError> =>
  Effect.gen(function* () {
    const verified = yield* verifyGitLabToken({
      webhookToken: options.webhookToken,
      received: header(request, "x-gitlab-token") ?? "",
    });
    if (!verified) {
      return yield* new GitLabHttpIngressError({
        message: "GitLab webhook token is invalid",
        status: 401,
      });
    }
    const eventName = header(request, "x-gitlab-event");
    const deliveryId =
      header(request, "webhook-id") ??
      header(request, "idempotency-key") ??
      header(request, "x-gitlab-event-uuid");
    if (eventName === undefined || deliveryId === undefined) {
      return yield* new GitLabHttpIngressError({
        message: "GitLab event and delivery id headers are required",
        status: 400,
      });
    }
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        new GitLabHttpIngressError({
          message: "Unable to read GitLab request body",
          status: 400,
          cause,
        }),
    });
    const payload = yield* Effect.try({
      try: () => JSON.parse(rawBody) as unknown,
      catch: (cause) =>
        new GitLabHttpIngressError({
          message: "GitLab request body is malformed",
          status: 400,
          cause,
        }),
    });
    if (!isRecord(payload) || !Schema.is(JsonValueSchema)(payload)) {
      return yield* new GitLabHttpIngressError({
        message: "GitLab request body must be a portable JSON object",
        status: 400,
      });
    }
    const instance = header(request, "x-gitlab-instance");
    return {
      kind: "gitlab.webhook",
      authority: options.authority,
      eventName,
      deliveryId,
      ...(instance === undefined ? {} : { instance }),
      payload: payload as JsonValue,
    };
  });

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * A webhook endpoint for one GitLab authority. Hosts that serve many
 * authorities from one route call `decodeGitLabHttpRequest` with the token
 * and authority they look up for the request instead.
 */
export const makeGitLabHttpEndpoint = (
  options: GitLabHttpEndpointOptions,
): HttpEndpoint => ({
  method: "POST",
  path: options.path ?? "/gitlab/events",
  handle: (request) =>
    Effect.runPromise(
      decodeGitLabHttpRequest(request, options).pipe(
        Effect.flatMap((input) =>
          Effect.tryPromise({
            try: () => options.submit(input),
            catch: (cause) =>
              new GitLabHttpSubmissionError({
                message: "Unable to submit GitLab work",
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
