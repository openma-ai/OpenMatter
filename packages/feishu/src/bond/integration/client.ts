import { JsonValueSchema, type JsonValue } from "@openma/matter";
import {
  CredentialError,
  makeCredentialResolver,
  type CredentialResolver,
} from "@openma/matter/credentials";
import { IntegrationError } from "@openma/matter/integration";
import { Effect, Schema } from "effect";
import { feishuEndpoints, isRetryableFeishuFailure } from "../http.js";
import { isRecord, nonEmptyString } from "./shared.js";

/**
 * What a Feishu call needs for one authority: the brand's origin and a
 * `tenant_access_token` (the Bond app principal, minted by the Feishu Bond
 * provider and cached by the Bond kernel).
 */
export interface FeishuCredentials {
  /** The open or accounts origin; selects Feishu or Lark. */
  readonly baseUrl: string;
  readonly token: string;
}

export type FeishuCredentialResolver = CredentialResolver<FeishuCredentials>;

export type FeishuCredentialSource = (
  authority: string,
) =>
  | FeishuCredentials
  | PromiseLike<FeishuCredentials>
  | Effect.Effect<FeishuCredentials, unknown>;

export type FeishuCredentialOption =
  FeishuCredentials | FeishuCredentialResolver | FeishuCredentialSource;

export type FeishuCredentialsFor = (
  authority: string,
) => Effect.Effect<
  { readonly open: string; readonly token: string },
  IntegrationError
>;

const invalid = (message: string) =>
  new IntegrationError({ message, retryable: false });

const validate = (
  value: unknown,
): Effect.Effect<
  { readonly open: string; readonly token: string },
  IntegrationError
> => {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.token) ||
    !nonEmptyString(value.baseUrl)
  ) {
    return Effect.fail(
      invalid("Feishu credentials must include a baseUrl and a token"),
    );
  }
  try {
    return Effect.succeed({
      open: feishuEndpoints(value.baseUrl).open,
      token: value.token,
    });
  } catch (cause) {
    return Effect.fail(
      new IntegrationError({
        message: cause instanceof Error ? cause.message : "Invalid baseUrl",
        retryable: false,
        cause,
      }),
    );
  }
};

export const makeFeishuCredentialsFor = (
  option: FeishuCredentialOption,
): FeishuCredentialsFor => {
  if (typeof option === "object" && option !== null && !("resolve" in option)) {
    const fixed = validate(option);
    return () => fixed;
  }
  const resolver: FeishuCredentialResolver =
    typeof option === "function"
      ? makeCredentialResolver(({ authority }) => option(authority))
      : option;
  return (authority) =>
    authority.length === 0
      ? Effect.fail(
          invalid("Feishu authority is required to resolve credentials"),
        )
      : Effect.suspend(() =>
          resolver.resolve({ integrationId: "feishu", authority }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new IntegrationError({
                message:
                  cause instanceof CredentialError
                    ? cause.message
                    : `Unable to resolve Feishu credentials for ${authority}`,
                retryable:
                  cause instanceof CredentialError ? cause.retryable : true,
                cause,
              }),
          ),
          Effect.flatMap(validate),
        );
};

export const makeFeishuClient = (input: {
  readonly credentialsFor: FeishuCredentialsFor;
  readonly fetch: typeof globalThis.fetch;
}) => {
  /**
   * Calls `/open-apis{path}` with the authority's tenant token and returns
   * `data`. Feishu answers `{ code, msg, data }`; a non-zero code is a
   * failure even on HTTP 200. Rate limits, server errors, and the transient
   * codes of `isRetryableFeishuFailure` are retryable.
   */
  const request = (options: {
    readonly authority: string;
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: Readonly<Record<string, unknown>>;
  }): Effect.Effect<JsonValue, IntegrationError> => {
    const label = `Feishu ${options.method} ${options.path}`;
    return input.credentialsFor(options.authority).pipe(
      Effect.flatMap(({ open, token }) => {
        const url = new URL(`/open-apis${options.path}`, open);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          url.searchParams.set(key, value);
        }
        return Effect.tryPromise({
          try: () =>
            input.fetch(url, {
              method: options.method,
              redirect: "manual",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${token}`,
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
              message: `${label} request failed`,
              retryable: true,
              cause,
            }),
        });
      }),
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            new IntegrationError({
              message: `${label} response could not be read`,
              retryable: true,
              cause,
            }),
        }).pipe(
          Effect.flatMap((text) => {
            let payload: unknown = undefined;
            if (text.length > 0) {
              try {
                payload = JSON.parse(text) as unknown;
              } catch {
                payload = undefined;
              }
            }
            const code =
              isRecord(payload) && typeof payload.code === "number"
                ? payload.code
                : undefined;
            if (!response.ok || (code !== undefined && code !== 0)) {
              return Effect.fail(
                new IntegrationError({
                  // Never echo the body: it may repeat message content.
                  message: `${label} failed with HTTP ${response.status}${
                    code === undefined ? "" : ` (code ${code})`
                  }`,
                  retryable: isRetryableFeishuFailure(response.status, code),
                  ...(code === undefined
                    ? {}
                    : { cause: { feishuCode: code } }),
                }),
              );
            }
            const data = isRecord(payload) ? (payload.data ?? null) : null;
            if (!Schema.is(JsonValueSchema)(data)) {
              return Effect.fail(
                new IntegrationError({
                  message: `${label} returned non-portable data`,
                  retryable: false,
                }),
              );
            }
            return Effect.succeed(data as JsonValue);
          }),
        ),
      ),
    );
  };

  return { request };
};

export type FeishuClient = ReturnType<typeof makeFeishuClient>;
