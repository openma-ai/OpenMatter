import { MESSAGE_IMAGE_MAX_BYTES, readMessageImageBytes } from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect } from "effect";
import { makeSlackCredentialsFor } from "./credentials.js";
import { makeSlackProviderClient } from "./provider-client.js";
import { isRecord } from "./shared.js";
import type {
  SlackCredentialResolver,
  SlackCredentialSource,
  SlackCredentials,
} from "./types.js";

export interface SlackFileDownloadInput {
  /** The same credentials the Integration uses. */
  readonly credentials:
    SlackCredentials | SlackCredentialResolver | SlackCredentialSource;
  /** The installation authority, `source.authority` of the Event. */
  readonly teamId?: string;
  /** The file id, such as `payload.images[n].id`. */
  readonly fileId: string;
  /**
   * The file's `url_private_download` or `url_private`, when the host has it.
   * Without it the helper reads it from `files.info`.
   */
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Default `MESSAGE_IMAGE_MAX_BYTES` (10 MiB). */
  readonly maxBytes?: number;
}

export interface SlackFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const fail = (message: string, retryable: boolean, cause?: unknown) =>
  new IntegrationError({
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });

/** The bot token is only ever sent to Slack's file host over https. */
const fileUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "files.slack.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Downloads a Slack file with the bot token: its `url_private_download`
 * (or `url_private`), read from `files.info` unless `url` is given. The app
 * needs the `files:read` scope. A non-2xx answer, an HTML or JSON body (what
 * Slack serves when the token cannot read the file), or a body over
 * `maxBytes` fails.
 */
export const downloadSlackFile = (
  input: SlackFileDownloadInput,
): Effect.Effect<SlackFile, IntegrationError> => {
  const label = "Slack file download";
  const maxBytes = input.maxBytes ?? MESSAGE_IMAGE_MAX_BYTES;
  if (typeof input.fileId !== "string" || input.fileId.length === 0) {
    return Effect.fail(fail(`${label} needs a fileId`, false));
  }
  const fetch = input.fetch ?? globalThis.fetch;
  const credentialsFor = makeSlackCredentialsFor(
    typeof input.credentials === "function" || "resolve" in input.credentials
      ? { credentials: input.credentials }
      : input.credentials,
  );
  const located: Effect.Effect<string, IntegrationError> =
    input.url !== undefined
      ? Effect.succeed(input.url)
      : makeSlackProviderClient({
          credentialsFor,
          fetchImplementation: fetch,
          clock: () => new Date().toISOString(),
        })
          .apiRead("files.info", { file: input.fileId }, input.teamId ?? "")
          .pipe(
            Effect.flatMap((payload) => {
              const file = isRecord(payload.file) ? payload.file : undefined;
              const url =
                typeof file?.url_private_download === "string"
                  ? file.url_private_download
                  : typeof file?.url_private === "string"
                    ? file.url_private
                    : undefined;
              return url === undefined
                ? Effect.fail(fail(`${label}: files.info has no URL`, false))
                : Effect.succeed(url);
            }),
          );
  return located.pipe(
    Effect.flatMap((value) => {
      const url = fileUrl(value);
      return url === undefined
        ? Effect.fail(
            fail(`${label} only fetches https://files.slack.com URLs`, false),
          )
        : Effect.succeed(url);
    }),
    Effect.flatMap((url) =>
      credentialsFor(input.teamId).pipe(
        Effect.flatMap(({ botToken }) =>
          Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "GET",
                redirect: "manual",
                headers: { authorization: `Bearer ${botToken}` },
              }),
            catch: (cause) => fail(`${label} request failed`, true, cause),
          }),
        ),
      ),
    ),
    Effect.flatMap((response) => {
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      if (!response.ok || /\b(?:json|html)\b/i.test(contentType)) {
        return Effect.promise(
          () =>
            response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        ).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              fail(
                `${label} failed with HTTP ${response.status}${
                  response.ok ? ` (${contentType.split(";")[0]})` : ""
                }`,
                response.status === 429 || response.status >= 500,
              ),
            ),
          ),
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
