import { ProviderError } from "@openmatter/bond";
import { Effect } from "effect";

export type Fetch = typeof globalThis.fetch;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalizes a GitLab instance URL to its canonical https origin. Rejects
 * plain http except for loopback hosts, and rejects paths, credentials,
 * queries, and fragments.
 */
export const canonicalOrigin = (input: string): string => {
  const url = new URL(input);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("GitLab instance URL must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "GitLab instance URL must not carry credentials, query, or fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("GitLab instance URL must be an origin without a path");
  }
  return url.origin.toLowerCase();
};

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One JSON request. Never follows redirects: a redirect is an error. */
export const requestJson = (
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
): Effect.Effect<JsonResponse, ProviderError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(url, { ...init, redirect: "manual" });
      const text = await response.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { status: response.status, body };
    },
    catch: (cause) =>
      new ProviderError({
        message: `GitLab request failed: ${new URL(url).pathname}`,
        rejected: false,
        cause,
      }),
  });

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Maps a non-2xx GitLab response to a ProviderError without echoing bodies.
 * Only OAuth `invalid_grant` is a rejection, the one answer that means the
 * grant itself is gone. `invalid_client`, other 4xx, and 5xx are
 * configuration or transport problems and must not end a link.
 */
export const statusError = (
  what: string,
  response: JsonResponse,
): ProviderError => {
  const error =
    isRecord(response.body) && typeof response.body.error === "string"
      ? response.body.error
      : undefined;
  return new ProviderError({
    message: `${what} failed with HTTP ${response.status}${error === undefined ? "" : ` (${error})`}`,
    rejected: error === "invalid_grant",
    status: response.status,
  });
};
