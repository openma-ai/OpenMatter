import { JsonValueSchema, type JsonValue } from "@openma/matter";
import {
  CredentialError,
  makeCredentialResolver,
  type CredentialResolver,
} from "@openma/matter/credentials";
import { IntegrationError } from "@openma/matter/integration";
import { Effect, Schema } from "effect";
import { isRecord, nonEmptyString } from "./shared.js";

/**
 * What a GitLab call needs for one authority: the instance and a token with
 * API access (a Bond's app principal token, or a test token).
 */
export interface GitLabCredentials {
  /** The instance root, for example `https://gitlab.example.com`. */
  readonly baseUrl: string;
  readonly token: string;
}

export type GitLabCredentialResolver = CredentialResolver<GitLabCredentials>;

export type GitLabCredentialSource = (
  authority: string,
) =>
  | GitLabCredentials
  | PromiseLike<GitLabCredentials>
  | Effect.Effect<GitLabCredentials, unknown>;

export type GitLabCredentialOption =
  GitLabCredentials | GitLabCredentialResolver | GitLabCredentialSource;

export type GitLabCredentialsFor = (
  authority: string,
) => Effect.Effect<GitLabCredentials, IntegrationError>;

const invalid = (message: string) =>
  new IntegrationError({ message, retryable: false });

const validate = (
  value: unknown,
): Effect.Effect<GitLabCredentials, IntegrationError> => {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.token) ||
    !nonEmptyString(value.baseUrl)
  ) {
    return Effect.fail(
      invalid("GitLab credentials must include a baseUrl and a token"),
    );
  }
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    return Effect.fail(invalid("GitLab baseUrl is not a URL"));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Effect.fail(invalid("GitLab baseUrl must use http or https"));
  }
  return Effect.succeed({ baseUrl: url.href, token: value.token });
};

export const makeGitLabCredentialsFor = (
  option: GitLabCredentialOption,
): GitLabCredentialsFor => {
  if (typeof option === "object" && option !== null && !("resolve" in option)) {
    const fixed = validate(option);
    return () => fixed;
  }
  const resolver: GitLabCredentialResolver =
    typeof option === "function"
      ? makeCredentialResolver(({ authority }) => option(authority))
      : option;
  return (authority) =>
    authority.length === 0
      ? Effect.fail(
          invalid("GitLab authority is required to resolve credentials"),
        )
      : Effect.suspend(() =>
          resolver.resolve({ integrationId: "gitlab", authority }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new IntegrationError({
                message:
                  cause instanceof CredentialError
                    ? cause.message
                    : `Unable to resolve GitLab credentials for ${authority}`,
                retryable:
                  cause instanceof CredentialError ? cause.retryable : true,
                cause,
              }),
          ),
          Effect.flatMap(validate),
        );
};

export interface GitLabResponse {
  readonly payload: JsonValue;
  readonly headers: Headers;
}

export const makeGitLabClient = (input: {
  readonly credentialsFor: GitLabCredentialsFor;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => string;
}) => {
  const retryAtFrom = (response: Response): string | undefined => {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        const now = Date.parse(input.clock());
        if (Number.isFinite(now)) {
          return new Date(now + seconds * 1_000).toISOString();
        }
      }
      const absolute = Date.parse(retryAfter);
      if (Number.isFinite(absolute)) return new Date(absolute).toISOString();
    }
    if (response.status !== 429) return undefined;
    const reset = Number.parseInt(
      response.headers.get("ratelimit-reset") ?? "",
      10,
    );
    return Number.isSafeInteger(reset) && reset >= 0
      ? new Date(reset * 1_000).toISOString()
      : undefined;
  };

  /** Calls `/api/v4{path}` on the authority's instance. */
  const request = (options: {
    readonly authority: string;
    readonly method: "DELETE" | "GET" | "POST" | "PUT";
    readonly path: string;
    readonly body?: Readonly<Record<string, unknown>>;
  }): Effect.Effect<GitLabResponse, IntegrationError> => {
    const label = `GitLab ${options.method} ${options.path}`;
    return input.credentialsFor(options.authority).pipe(
      Effect.flatMap(({ baseUrl, token }) =>
        Effect.tryPromise({
          try: () =>
            input.fetch(
              new URL(
                `api/v4${options.path}`,
                baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
              ),
              {
                method: options.method,
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
              },
            ),
          catch: (cause) =>
            new IntegrationError({
              message: `${label} request failed`,
              retryable: true,
              cause,
            }),
        }),
      ),
      Effect.flatMap((response) => {
        const retryable = response.status === 429 || response.status >= 500;
        const retryAt = retryAtFrom(response);
        const failure = (message: string, cause?: unknown) =>
          new IntegrationError({
            message,
            retryable,
            ...(retryAt === undefined ? {} : { retryAt }),
            ...(cause === undefined ? {} : { cause }),
          });
        return Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) =>
            failure(`${label} response could not be read`, cause),
        }).pipe(
          Effect.flatMap((text) => {
            let payload: unknown = null;
            if (text.length > 0) {
              try {
                payload = JSON.parse(text) as unknown;
              } catch (cause) {
                return Effect.fail(
                  response.ok
                    ? failure(`${label} returned invalid JSON`, cause)
                    : failure(`${label} failed with HTTP ${response.status}`),
                );
              }
            }
            if (!response.ok) {
              return Effect.fail(
                failure(
                  `${label} failed with HTTP ${response.status}`,
                  payload,
                ),
              );
            }
            if (!Schema.is(JsonValueSchema)(payload)) {
              return Effect.fail(
                failure(`${label} returned non-portable data`),
              );
            }
            return Effect.succeed({ payload, headers: response.headers });
          }),
        );
      }),
    );
  };

  return { request };
};

export type GitLabClient = ReturnType<typeof makeGitLabClient>;
