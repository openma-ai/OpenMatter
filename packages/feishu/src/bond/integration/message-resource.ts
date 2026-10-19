import { MESSAGE_IMAGE_MAX_BYTES, readMessageImageBytes } from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect } from "effect";
import { isRetryableFeishuFailure } from "../http.js";
import {
  makeFeishuCredentialsFor,
  type FeishuCredentialOption,
} from "./client.js";
import { isRecord, nonEmptyString } from "./shared.js";

export interface FeishuMessageResourceInput {
  /** The same credentials the Integration uses. */
  readonly credentials: FeishuCredentialOption;
  /** Selects credentials when `credentials` is a resolver or source. */
  readonly authority?: string;
  /** The message that carries the resource, `payload.messageId`. */
  readonly messageId: string;
  /** The resource key, such as an image's `payload.images[n].id`. */
  readonly fileKey: string;
  /** Default `image`. */
  readonly type?: "image" | "file";
  readonly fetch?: typeof globalThis.fetch;
  /** Default `MESSAGE_IMAGE_MAX_BYTES` (10 MiB). */
  readonly maxBytes?: number;
}

export interface FeishuMessageResource {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const fail = (message: string, retryable: boolean, cause?: unknown) =>
  new IntegrationError({
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Downloads a resource of a message the bot received:
 * `GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=…`
 * with the tenant token. The app needs the `im:resource` scope. A non-2xx
 * answer, a JSON error body, or a body over `maxBytes` fails; the body is
 * never echoed into the error.
 */
export const downloadFeishuMessageResource = (
  input: FeishuMessageResourceInput,
): Effect.Effect<FeishuMessageResource, IntegrationError> => {
  const type = input.type ?? "image";
  const maxBytes = input.maxBytes ?? MESSAGE_IMAGE_MAX_BYTES;
  const label = "Feishu message resource download";
  if (!nonEmptyString(input.messageId) || !nonEmptyString(input.fileKey)) {
    return Effect.fail(fail(`${label} needs a messageId and a fileKey`, false));
  }
  const fetch = input.fetch ?? globalThis.fetch;
  return makeFeishuCredentialsFor(input.credentials)(
    input.authority ?? "",
  ).pipe(
    Effect.flatMap(({ open, token }) => {
      const url = new URL(
        `/open-apis/im/v1/messages/${encodeURIComponent(
          input.messageId,
        )}/resources/${encodeURIComponent(input.fileKey)}`,
        open,
      );
      url.searchParams.set("type", type);
      return Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "GET",
            redirect: "manual",
            headers: { authorization: `Bearer ${token}` },
          }),
        catch: (cause) => fail(`${label} request failed`, true, cause),
      });
    }),
    Effect.flatMap((response) => {
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const isJson = /\bjson\b/i.test(contentType);
      if (!response.ok || isJson) {
        return Effect.promise(() => response.text().catch(() => "")).pipe(
          Effect.flatMap((text) => {
            let code: number | undefined;
            try {
              const payload: unknown = JSON.parse(text);
              if (isRecord(payload) && typeof payload.code === "number") {
                code = payload.code;
              }
            } catch {
              code = undefined;
            }
            return Effect.fail(
              new IntegrationError({
                message: `${label} failed with HTTP ${response.status}${
                  code === undefined ? "" : ` (code ${code})`
                }`,
                retryable: isRetryableFeishuFailure(response.status, code),
                ...(code === undefined ? {} : { cause: { feishuCode: code } }),
              }),
            );
          }),
        );
      }
      return Effect.tryPromise({
        try: () => readMessageImageBytes(response, maxBytes),
        catch: (cause) =>
          fail(`${label} response could not be read`, true, cause),
      }).pipe(
        Effect.flatMap((bytes) =>
          bytes === undefined
            ? Effect.fail(
                fail(`${label} is larger than ${maxBytes} bytes`, false),
              )
            : Effect.succeed({ bytes, contentType }),
        ),
      );
    }),
  );
};
