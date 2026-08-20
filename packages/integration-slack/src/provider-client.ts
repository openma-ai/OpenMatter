import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import type { SlackCredentialsFor } from "./credentials.js";
import { isRecord } from "./shared.js";

const transientSlackErrors = new Set([
  "fatal_error",
  "internal_error",
  "rate_limited",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
  "team_added_to_org",
]);

export const makeSlackProviderClient = (input: {
  readonly credentialsFor: SlackCredentialsFor;
  readonly fetchImplementation: typeof globalThis.fetch;
  readonly clock: () => string;
}) => {
  const { clock, credentialsFor, fetchImplementation } = input;

  const retryAtFrom = (response: Response): string | undefined => {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter === null) return undefined;
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const now = Date.parse(clock());
      return Number.isFinite(now)
        ? new Date(now + seconds * 1_000).toISOString()
        : undefined;
    }
    const absolute = Date.parse(retryAfter);
    return Number.isFinite(absolute)
      ? new Date(absolute).toISOString()
      : undefined;
  };

  const parseApiResponse = (
    method: string,
    response: Response,
    acceptedErrors: readonly string[] = [],
  ): Effect.Effect<Record<string, JsonValue>, IntegrationError> =>
    Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        new IntegrationError({
          message: `Slack ${method} returned invalid JSON`,
          retryable: response.status === 429 || response.status >= 500,
          ...(retryAtFrom(response) === undefined
            ? {}
            : { retryAt: retryAtFrom(response)! }),
          cause,
        }),
    }).pipe(
      Effect.flatMap((payload) => {
        if (!isRecord(payload) || !Schema.is(JsonValueSchema)(payload)) {
          return Effect.fail(
            new IntegrationError({
              message: `Slack ${method} returned an invalid response`,
              retryable: response.status === 429 || response.status >= 500,
              ...(retryAtFrom(response) === undefined
                ? {}
                : { retryAt: retryAtFrom(response)! }),
            }),
          );
        }
        if (!response.ok || payload.ok !== true) {
          const code =
            typeof payload.error === "string" ? payload.error : "unknown";
          if (response.ok && acceptedErrors.includes(code)) {
            return Effect.succeed(
              structuredClone(payload) as Record<string, JsonValue>,
            );
          }
          const retryAt = retryAtFrom(response);
          return Effect.fail(
            new IntegrationError({
              message: `Slack ${method} failed: ${code}`,
              retryable:
                response.status === 429 ||
                response.status >= 500 ||
                transientSlackErrors.has(code),
              ...(retryAt === undefined ? {} : { retryAt }),
              cause: payload,
            }),
          );
        }
        return Effect.succeed(
          structuredClone(payload) as Record<string, JsonValue>,
        );
      }),
    );

  const apiCall = (
    method: string,
    body: Record<string, unknown>,
    acceptedErrors: readonly string[] = [],
    teamId?: string,
  ) =>
    credentialsFor(teamId).pipe(
      Effect.flatMap(({ botToken }) =>
        Effect.tryPromise({
          try: () =>
            fetchImplementation(`https://slack.com/api/${method}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${botToken}`,
                "content-type": "application/json; charset=utf-8",
              },
              body: JSON.stringify(body),
            }),
          catch: (cause) =>
            new IntegrationError({
              message: `Slack ${method} request failed`,
              retryable: true,
              cause,
            }),
        }),
      ),
      Effect.flatMap((response) =>
        parseApiResponse(method, response, acceptedErrors),
      ),
      Effect.map((providerReceipt) => ({ providerReceipt })),
    );

  const apiRead = (
    method: string,
    parameters: Readonly<Record<string, string | number | undefined>>,
    teamId: string,
  ): Effect.Effect<Record<string, JsonValue>, IntegrationError> => {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return credentialsFor(teamId).pipe(
      Effect.flatMap(({ botToken }) =>
        Effect.tryPromise({
          try: () =>
            fetchImplementation(url, {
              method: "GET",
              headers: { authorization: `Bearer ${botToken}` },
            }),
          catch: (cause) =>
            new IntegrationError({
              message: `Slack ${method} request failed`,
              retryable: true,
              cause,
            }),
        }),
      ),
      Effect.flatMap((response) => parseApiResponse(method, response)),
    );
  };

  return { apiCall, apiRead, retryAtFrom };
};

export type SlackProviderClient = ReturnType<typeof makeSlackProviderClient>;
