import {
  CredentialError,
  makeCredentialResolver,
  type CredentialResolver,
} from "@openmatter/credentials";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import { isRecord } from "./shared.js";
import type { GitHubCredentials, GitHubIntegrationOptions } from "./types.js";

export type GitHubCredentialsFor = (
  installationId: string | undefined,
) => Effect.Effect<GitHubCredentials, IntegrationError>;

export const makeGitHubCredentialsFor = (
  options: GitHubIntegrationOptions,
): GitHubCredentialsFor => {
  const validate = (
    value: unknown,
  ): Effect.Effect<GitHubCredentials, IntegrationError> =>
    isRecord(value) && typeof value.token === "string" && value.token.length > 0
      ? Effect.succeed({ token: value.token })
      : Effect.fail(
          new IntegrationError({
            message: "GitHub credential resolver returned invalid credentials",
            retryable: false,
          }),
        );

  return (installationId) => {
    if (!("credentials" in options)) return validate(options);
    if (installationId === undefined || installationId.length === 0) {
      return Effect.fail(
        new IntegrationError({
          message: "GitHub installation ID is required to resolve credentials",
          retryable: false,
        }),
      );
    }
    const configured = options.credentials;
    const resolver: CredentialResolver<GitHubCredentials> =
      typeof configured === "function"
        ? makeCredentialResolver(({ authority }) => configured(authority))
        : configured;
    if (
      typeof resolver !== "object" ||
      resolver === null ||
      typeof resolver.resolve !== "function"
    ) {
      return Effect.fail(
        new IntegrationError({
          message: "GitHub credential resolver is invalid",
          retryable: false,
        }),
      );
    }
    return Effect.suspend(() =>
      resolver.resolve({ integrationId: "github", authority: installationId }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IntegrationError({
            message:
              cause instanceof CredentialError
                ? cause.message
                : `Unable to resolve GitHub credentials for ${installationId}`,
            retryable:
              cause instanceof CredentialError ? cause.retryable : true,
            cause,
          }),
      ),
      Effect.flatMap(validate),
    );
  };
};
