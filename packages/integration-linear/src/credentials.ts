import {
  CredentialError,
  makeCredentialResolver,
  type CredentialResolver,
} from "@openmatter/credentials";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { LinearCredentials, LinearIntegrationOptions } from "./types.js";

export type LinearCredentialsFor = (
  organizationId: string,
) => Effect.Effect<LinearCredentials, IntegrationError>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateCredentials = (
  value: unknown,
): Effect.Effect<LinearCredentials, IntegrationError> => {
  if (
    isRecord(value) &&
    value.kind === "oauth" &&
    typeof value.accessToken === "string" &&
    value.accessToken.length > 0
  ) {
    return Effect.succeed({ kind: "oauth", accessToken: value.accessToken });
  }
  if (
    isRecord(value) &&
    value.kind === "apiKey" &&
    typeof value.apiKey === "string" &&
    value.apiKey.length > 0
  ) {
    return Effect.succeed({ kind: "apiKey", apiKey: value.apiKey });
  }
  return Effect.fail(
    new IntegrationError({
      message: "Linear credential resolver returned invalid credentials",
      retryable: false,
    }),
  );
};

export const makeLinearCredentialsFor = (
  options: LinearIntegrationOptions,
): LinearCredentialsFor => {
  const configured = options.credentials;
  if (
    isRecord(configured) &&
    (configured.kind === "oauth" || configured.kind === "apiKey")
  ) {
    return () => validateCredentials(configured);
  }

  let resolver: CredentialResolver<LinearCredentials>;
  if (typeof configured === "function") {
    resolver = makeCredentialResolver(({ authority }) => configured(authority));
  } else if (isRecord(configured) && typeof configured.resolve === "function") {
    resolver = configured as unknown as CredentialResolver<LinearCredentials>;
  } else {
    return () =>
      Effect.fail(
        new IntegrationError({
          message: "Linear credential resolver is invalid",
          retryable: false,
        }),
      );
  }
  return (organizationId) =>
    Effect.suspend(() =>
      resolver.resolve({
        integrationId: "linear",
        authority: organizationId,
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IntegrationError({
            message:
              cause instanceof CredentialError
                ? cause.message
                : `Unable to resolve Linear credentials for ${organizationId}`,
            retryable:
              cause instanceof CredentialError ? cause.retryable : true,
            cause,
          }),
      ),
      Effect.flatMap(validateCredentials),
    );
};
