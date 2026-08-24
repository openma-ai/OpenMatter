import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import type { GitHubCredentialsFor } from "./credentials.js";
import { isRecord } from "./shared.js";

export interface GitHubProviderResponse {
  readonly payload: JsonValue;
  readonly headers: Headers;
}

export const makeGitHubProviderClient = (input: {
  readonly credentialsFor: GitHubCredentialsFor;
  readonly fetchImplementation: typeof globalThis.fetch;
  readonly apiBaseUrl: string;
  readonly apiVersion: string;
  readonly clock: () => string;
}) => {
  const { apiBaseUrl, apiVersion, clock, credentialsFor, fetchImplementation } =
    input;

  const retryAtFrom = (response: Response): string | undefined => {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        const now = Date.parse(clock());
        if (Number.isFinite(now)) {
          return new Date(now + seconds * 1_000).toISOString();
        }
      }
      const absolute = Date.parse(retryAfter);
      if (Number.isFinite(absolute)) return new Date(absolute).toISOString();
    }
    if (response.headers.get("x-ratelimit-remaining") !== "0") {
      return undefined;
    }
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset === null) return undefined;
    const epochSeconds = Number.parseInt(reset, 10);
    return Number.isSafeInteger(epochSeconds) && epochSeconds >= 0
      ? new Date(epochSeconds * 1_000).toISOString()
      : undefined;
  };

  const rateLimited = (response: Response, payload?: unknown): boolean => {
    if (response.status === 429) return true;
    if (response.status !== 403) return false;
    const message =
      isRecord(payload) && typeof payload.message === "string"
        ? payload.message.toLowerCase()
        : "";
    return (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after") ||
      message.includes("secondary rate limit") ||
      message.includes("abuse detection")
    );
  };

  const request = (options: {
    readonly installationId: string;
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly path: string;
    readonly query?: Readonly<Record<string, string | number | undefined>>;
    readonly body?: Readonly<Record<string, unknown>>;
  }): Effect.Effect<GitHubProviderResponse, IntegrationError> => {
    const url = new URL(options.path, apiBaseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return credentialsFor(options.installationId).pipe(
      Effect.flatMap(({ token }) =>
        Effect.tryPromise({
          try: () =>
            fetchImplementation(url, {
              method: options.method,
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": apiVersion,
                ...(options.body === undefined
                  ? {}
                  : { "content-type": "application/json; charset=utf-8" }),
              },
              ...(options.body === undefined
                ? {}
                : { body: JSON.stringify(options.body) }),
            }),
          catch: (cause) =>
            new IntegrationError({
              message: `GitHub ${options.method} ${options.path} request failed`,
              retryable: true,
              cause,
            }),
        }),
      ),
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            new IntegrationError({
              message: `GitHub ${options.method} ${options.path} response could not be read`,
              retryable: rateLimited(response) || response.status >= 500,
              ...(retryAtFrom(response) === undefined
                ? {}
                : { retryAt: retryAtFrom(response)! }),
              cause,
            }),
        }).pipe(
          Effect.flatMap((text) => {
            let payload: unknown = null;
            if (text.length > 0) {
              try {
                payload = JSON.parse(text) as unknown;
              } catch (cause) {
                return Effect.fail(
                  new IntegrationError({
                    message: `GitHub ${options.method} ${options.path} returned invalid JSON`,
                    retryable: rateLimited(response) || response.status >= 500,
                    ...(retryAtFrom(response) === undefined
                      ? {}
                      : { retryAt: retryAtFrom(response)! }),
                    cause,
                  }),
                );
              }
            }
            if (!Schema.is(JsonValueSchema)(payload)) {
              return Effect.fail(
                new IntegrationError({
                  message: `GitHub ${options.method} ${options.path} returned non-portable data`,
                  retryable:
                    rateLimited(response, payload) || response.status >= 500,
                }),
              );
            }
            if (!response.ok) {
              const retryAt = retryAtFrom(response);
              return Effect.fail(
                new IntegrationError({
                  message: `GitHub ${options.method} ${options.path} failed with HTTP ${response.status}`,
                  retryable:
                    rateLimited(response, payload) || response.status >= 500,
                  ...(retryAt === undefined ? {} : { retryAt }),
                  cause: payload,
                }),
              );
            }
            return Effect.succeed({
              payload: structuredClone(payload),
              headers: response.headers,
            });
          }),
        ),
      ),
    );
  };

  return { request, retryAtFrom };
};

export type GitHubProviderClient = ReturnType<typeof makeGitHubProviderClient>;
