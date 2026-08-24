import { Data, Effect } from "effect";

/** Public identifiers only. Credential material never belongs in this request. */
export interface CredentialRequest {
  readonly integrationId: string;
  readonly authority: string;
}

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string;
  readonly integrationId: string;
  readonly authority: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export type CredentialSource<Credential> = (
  request: CredentialRequest,
) => Credential | PromiseLike<Credential> | Effect.Effect<Credential, unknown>;

export interface CredentialResolver<Credential> {
  readonly resolve: (
    request: CredentialRequest,
  ) => Effect.Effect<Credential, CredentialError>;
}

const isPromiseLike = <Value>(value: unknown): value is PromiseLike<Value> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const credentialFailure = (
  request: CredentialRequest,
  cause: unknown,
): CredentialError =>
  cause instanceof CredentialError
    ? cause
    : new CredentialError({
        message: `Unable to resolve credential for ${request.integrationId}:${request.authority}`,
        integrationId: request.integrationId,
        authority: request.authority,
        retryable: true,
        cause,
      });

/**
 * Adapts synchronous, Promise, or Effect credential loaders to one typed Effect
 * boundary. Resolution and refresh policy remain owned by the loader.
 */
export const makeCredentialResolver = <Credential>(
  source: CredentialSource<Credential>,
): CredentialResolver<Credential> => ({
  resolve: (request) =>
    Effect.suspend(() => {
      let result:
        | Credential
        | PromiseLike<Credential>
        | Effect.Effect<Credential, unknown>;
      try {
        result = source(request);
      } catch (cause) {
        return Effect.fail(credentialFailure(request, cause));
      }

      if (Effect.isEffect(result)) {
        return result.pipe(
          Effect.mapError((cause) => credentialFailure(request, cause)),
        );
      }
      if (isPromiseLike<Credential>(result)) {
        return Effect.tryPromise({
          try: () => Promise.resolve(result),
          catch: (cause) => credentialFailure(request, cause),
        });
      }
      return Effect.succeed(result);
    }),
});

/** A deployment convenience for one explicitly bound installation. */
export const staticCredentialResolver = <Credential>(
  credential: Credential,
  binding: CredentialRequest,
): CredentialResolver<Credential> =>
  makeCredentialResolver((request) => {
    if (
      request.integrationId !== binding.integrationId ||
      request.authority !== binding.authority
    ) {
      throw new CredentialError({
        message: `No credential is bound for ${request.integrationId}:${request.authority}`,
        integrationId: request.integrationId,
        authority: request.authority,
        retryable: false,
      });
    }
    return credential;
  });
