import {
  ProviderError,
  type BondProvider,
  type ProviderAppConfig,
  type SecretRef,
} from "@openmatter/bond";
import { Effect } from "effect";
import type { Fetch } from "./http.js";
import { refreshAccessToken, revokeToken, type OAuthClient } from "./oauth.js";
import { revokeSelfToken } from "./tokens.js";

export interface GitLabBondProviderOptions {
  readonly fetch?: Fetch;
  readonly clock?: () => string;
  /** Resolves `oauth.clientSecret` references. Omit for public clients. */
  readonly resolveSecret?: (ref: SecretRef) => Effect.Effect<string, unknown>;
}

/**
 * Bond's GitLab provider. GitLab has no delegation marker, so user-principal
 * writes need the ProviderApp's `allowUserPrincipalOutput`. The app principal
 * is a registered bot credential stored on the Installation; GitLab 17.1
 * cannot rotate it from the bot itself, so an administrator replaces it.
 */
export const makeGitLabBondProvider = (
  options: GitLabBondProviderOptions = {},
): BondProvider => {
  const client = (config: ProviderAppConfig) =>
    Effect.gen(function* () {
      if (config.oauth === undefined) {
        return yield* Effect.fail(
          new ProviderError({
            message: `${config.id} has no OAuth application`,
            rejected: true,
          }),
        );
      }
      const secretRef = config.oauth.clientSecret;
      const clientSecret =
        secretRef === undefined || options.resolveSecret === undefined
          ? undefined
          : yield* options.resolveSecret(secretRef).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderError({
                    message: "Unable to resolve the OAuth client secret",
                    rejected: false,
                    cause,
                  }),
              ),
            );
      const c: OAuthClient = {
        origin: config.baseUrl,
        clientId: config.oauth.clientId,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      };
      return c;
    });

  return {
    provider: "gitlab",
    delegationMarker: false,
    refreshUserToken: (config, refreshToken) =>
      client(config).pipe(
        Effect.flatMap((c) => refreshAccessToken(c, refreshToken)),
      ),
    revokeUserToken: (config, tokens) =>
      tokens.method === "pat"
        ? revokeSelfToken(config.baseUrl, tokens.accessToken, options.fetch)
        : client(config).pipe(
            Effect.flatMap((c) => revokeToken(c, tokens.accessToken)),
          ),
    appCredential: (config, installation, stored) =>
      stored === undefined
        ? Effect.fail(
            new ProviderError({
              message: `Installation ${installation.id} of ${config.id} has no bot credential`,
              rejected: true,
            }),
          )
        : Effect.succeed({
            token: stored,
            ...(installation.credentialExpiresAt === undefined
              ? {}
              : { expiresAt: installation.credentialExpiresAt }),
          }),
  };
};
