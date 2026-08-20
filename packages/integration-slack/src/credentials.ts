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
      return validateCredentials(options);
    }
    if (authorityId === undefined) {
      return Effect.fail(
        new IntegrationError({
          message: "Slack authority ID is required to resolve credentials",
          retryable: false,
        }),
      );
    }
    return Effect.suspend(() => {
      try {
        const result = options.credentials(authorityId);
        if (Effect.isEffect(result)) {
          return result.pipe(Effect.flatMap(validateCredentials));
        }
        if (result instanceof Promise) {
          return Effect.tryPromise({
            try: () => result,
            catch: (cause) =>
              new IntegrationError({
                message: `Unable to resolve Slack credentials for ${authorityId}`,
                retryable: true,
                cause,
              }),
          }).pipe(Effect.flatMap(validateCredentials));
        }
        return validateCredentials(result);
      } catch (cause) {
        return Effect.fail(
          new IntegrationError({
            message: `Unable to resolve Slack credentials for ${authorityId}`,
            retryable: true,
            cause,
          }),
        );
      }
    });
  };

  return credentialsFor;
};
