import {
  ProviderError,
  type BondProvider,
  type ProviderAppConfig,
  type SecretRef,
} from "@openma/matter/bond";
import { Effect, Either } from "effect";
import type { Fetch } from "./http.js";
import {
  refreshUserAccessToken,
  revokeUserToken,
  type OAuthClient,
} from "./oauth.js";
import { mintTenantAccessToken } from "./tokens.js";

export interface FeishuBondProviderOptions {
  readonly fetch?: Fetch;
  readonly clock?: () => string;
  /** Resolves the app secret reference stored in `oauth.clientSecret`. */
  readonly resolveSecret?: (ref: SecretRef) => Effect.Effect<string, unknown>;
}

/**
 * Bond's Feishu provider, for customer self-built apps. The ProviderApp
 * config maps as follows: `baseUrl` selects Feishu or Lark, `oauth.clientId`
 * is the app ID, and `oauth.clientSecret` references the app secret. The app
 * principal is the app's bot: its `tenant_access_token` is minted from the
 * app secret on demand, never stored. User links (device flow or redirect
 * OAuth) are issued to the same app. Feishu has no delegation marker, so
 * user-principal writes need `allowUserPrincipalOutput`.
 */
export const makeFeishuBondProvider = (
  options: FeishuBondProviderOptions = {},
): BondProvider => {
  // Configuration problems are never grant rejections: they must not end
  // every link of the ProviderApp.
  const configError = (message: string, cause?: unknown) =>
    new ProviderError({
      message,
      rejected: false,
      ...(cause === undefined ? {} : { cause }),
    });

  const client = (
    config: ProviderAppConfig,
  ): Effect.Effect<OAuthClient, ProviderError> =>
    Effect.gen(function* () {
      if (config.oauth === undefined) {
        return yield* Effect.fail(
          configError(`${config.id} has no Feishu app ID`),
        );
      }
      const secretRef = config.oauth.clientSecret;
      if (secretRef === undefined) {
        return yield* Effect.fail(
          configError(`${config.id} has no Feishu app secret`),
        );
      }
      if (options.resolveSecret === undefined) {
        return yield* Effect.fail(
          configError(
            `${config.id} has a Feishu app secret but the provider has no resolveSecret`,
          ),
        );
      }
      const appSecret = yield* options
        .resolveSecret(secretRef)
        .pipe(
          Effect.mapError((cause) =>
            configError("Unable to resolve the Feishu app secret", cause),
          ),
        );
      return {
        baseUrl: config.baseUrl,
        appId: config.oauth.clientId,
        appSecret,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      };
    });

  return {
    provider: "feishu",
    delegationMarker: false,
    refreshUserToken: (config, refreshToken) =>
      client(config).pipe(
        Effect.flatMap((c) => refreshUserAccessToken(c, refreshToken)),
      ),
    // The refresh token goes first: once it is revoked the pair cannot be
    // renewed, even if revoking the access token then fails.
    revokeUserToken: (config, tokens) =>
      Effect.gen(function* () {
        const c = yield* client(config);
        const results: Either.Either<void, ProviderError>[] = [];
        if (tokens.refreshToken !== undefined) {
          results.push(
            yield* Effect.either(revokeUserToken(c, tokens.refreshToken)),
          );
        }
        results.push(
          yield* Effect.either(revokeUserToken(c, tokens.accessToken)),
        );
        const failed = results.find(Either.isLeft);
        if (failed !== undefined) return yield* Effect.fail(failed.left);
      }),
    appCredential: (config) =>
      client(config).pipe(Effect.flatMap((c) => mintTenantAccessToken(c))),
  };
};
