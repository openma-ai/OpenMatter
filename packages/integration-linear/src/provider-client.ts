import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import type { LinearCredentialsFor } from "./credentials.js";
import type { LinearCredentials } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const retryAtFrom = (response: Response): string | undefined => {
  const reset =
    response.headers.get("x-ratelimit-endpoint-requests-reset") ??
    response.headers.get("x-ratelimit-requests-reset");
  if (reset === null) return undefined;
  const milliseconds = Number.parseInt(reset, 10);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
};

const retryDetails = (response: Response) => {
  const retryAt = retryAtFrom(response);
  return {
    retryable:
      retryAt !== undefined ||
      response.status === 429 ||
      response.status >= 500,
    ...(retryAt === undefined ? {} : { retryAt }),
  };
};

const authorizationFor = (credentials: LinearCredentials): string =>
  credentials.kind === "oauth"
    ? `Bearer ${credentials.accessToken}`
    : credentials.apiKey;

export const makeLinearProviderClient = (input: {
  readonly credentialsFor: LinearCredentialsFor;
  readonly fetchImplementation: typeof globalThis.fetch;
  readonly endpoint: string;
}) => {
  const execute = (
    operationName: string,
    query: string,
    variables: Readonly<Record<string, JsonValue>>,
    organizationId: string,
  ): Effect.Effect<Record<string, JsonValue>, IntegrationError> =>
    input.credentialsFor(organizationId).pipe(
      Effect.flatMap((credentials) =>
        Effect.tryPromise({
          try: () =>
            input.fetchImplementation(input.endpoint, {
              method: "POST",
              headers: {
                authorization: authorizationFor(credentials),
                "content-type": "application/json; charset=utf-8",
              },
              body: JSON.stringify({ operationName, query, variables }),
            }),
          catch: (cause) =>
            new IntegrationError({
              message: `Linear ${operationName} request failed`,
              retryable: true,
              cause,
            }),
        }),
      ),
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) =>
            new IntegrationError({
              message: `Linear ${operationName} returned invalid JSON`,
              ...retryDetails(response),
              cause,
            }),
        }).pipe(
          Effect.flatMap((payload) => {
            if (!isRecord(payload) || !Schema.is(JsonValueSchema)(payload)) {
              return Effect.fail(
                new IntegrationError({
                  message: `Linear ${operationName} returned an invalid response`,
                  ...retryDetails(response),
                }),
              );
            }
            const errors = Array.isArray(payload.errors) ? payload.errors : [];
            const rateLimited = errors.some(
              (error) =>
                isRecord(error) &&
                isRecord(error.extensions) &&
                error.extensions.code === "RATELIMITED",
            );
            if (!response.ok || errors.length > 0) {
              const details = retryDetails(response);
              return Effect.fail(
                new IntegrationError({
                  message: `Linear ${operationName} failed`,
                  retryable: rateLimited || details.retryable,
                  ...(details.retryAt === undefined
                    ? {}
                    : { retryAt: details.retryAt }),
                  cause: structuredClone(payload),
                }),
              );
            }
            if (!isRecord(payload.data)) {
              return Effect.fail(
                new IntegrationError({
                  message: `Linear ${operationName} response is missing data`,
                  ...retryDetails(response),
                }),
              );
            }
            return Effect.succeed(
              structuredClone(payload.data) as Record<string, JsonValue>,
            );
          }),
        ),
      ),
    );

  return { execute };
};

export type LinearProviderClient = ReturnType<typeof makeLinearProviderClient>;
