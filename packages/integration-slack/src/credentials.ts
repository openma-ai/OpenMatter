import {
  CredentialError,
  makeCredentialResolver,
  type CredentialResolver,
} from "@openmatter/credentials";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import { isRecord } from "./shared.js";
import type { SlackCredentials, SlackIntegrationOptions } from "./types.js";

export type SlackCredentialsFor = (
  authorityId: string | undefined,
) => Effect.Effect<SlackCredentials, IntegrationError>;

export const makeSlackCredentialsFor = (
  options: SlackIntegrationOptions,
): SlackCredentialsFor => {
  const validateCredentials = (
    value: unknown,
  ): Effect.Effect<SlackCredentials, IntegrationError> =>
    isRecord(value) &&
    typeof value.botToken === "string" &&
    value.botToken.length > 0 &&
    typeof value.botUserId === "string" &&
    value.botUserId.length > 0
      ? Effect.succeed({
          botToken: value.botToken,
          botUserId: value.botUserId,
        })
      : Effect.fail(
          new IntegrationError({
            message: "Slack credential resolver returned invalid credentials",
            retryable: false,
          }),
        );

  const credentialsFor = (
    authorityId: string | undefined,
  ): Effect.Effect<SlackCredentials, IntegrationError> => {
    if (typeof options.credentials !== "function") {
      if (!("credentials" in options)) {
        return validateCredentials(options);
      }
    }
    if (authorityId === undefined) {
      return Effect.fail(
        new IntegrationError({
          message: "Slack authority ID is required to resolve credentials",
          retryable: false,
        }),
      );
    }
    const configured = options.credentials;
    const resolver: CredentialResolver<SlackCredentials> =
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
          message: "Slack credential resolver is invalid",
          retryable: false,
        }),
      );
    }

    return Effect.suspend(() =>
      resolver.resolve({ integrationId: "slack", authority: authorityId }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IntegrationError({
            message:
              cause instanceof CredentialError
                ? cause.message
                : `Unable to resolve Slack credentials for ${authorityId}`,
            retryable:
              cause instanceof CredentialError ? cause.retryable : true,
            cause,
          }),
      ),
      Effect.flatMap(validateCredentials),
    );
  };

  return credentialsFor;
};
