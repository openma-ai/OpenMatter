import type { ProviderError } from "@openma/matter/bond";
import { Effect } from "effect";
import {
  bearer,
  endpoints,
  feishuError,
  isoNow,
  isRecord,
  plusSeconds,
  requestJson,
  succeeded,
  type Fetch,
} from "./http.js";

export interface SelfBuiltAppCredentials {
  /** The open or accounts origin; selects Feishu or Lark. */
  readonly baseUrl: string;
  /** `cli_…` */
  readonly appId: string;
  readonly appSecret: string;
  readonly fetch?: Fetch;
  /** ISO now, for computing expiry. */
  readonly clock?: () => string;
}

export interface TenantAccessToken {
  readonly token: string;
  /** The real expiry; the Bond kernel applies its own refresh margin. */
  readonly expiresAt: string;
}

/**
 * Mints a `tenant_access_token` for a self-built app. The token acts as the
 * app's bot in the customer's tenant and lives at most two hours. It is
 * never persisted: the Bond kernel caches it in memory per Installation.
 */
export const mintTenantAccessToken = (
  app: SelfBuiltAppCredentials,
): Effect.Effect<TenantAccessToken, ProviderError> =>
  Effect.gen(function* () {
    const { open } = yield* endpoints(app.baseUrl);
    const now = isoNow(app.clock);
    const response = yield* requestJson(
      app.fetch ?? globalThis.fetch,
      `${open}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          accept: "application/json",
        },
        body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
      },
    );
    const b = response.body;
    if (
      !succeeded(response) ||
      !isRecord(b) ||
      typeof b.tenant_access_token !== "string" ||
      typeof b.expire !== "number"
    ) {
      return yield* Effect.fail(
        feishuError("Minting the tenant access token", response),
      );
    }
    return {
      token: b.tenant_access_token,
      expiresAt: plusSeconds(now, b.expire),
    };
  });

/** What a host stores on the Installation after an administrator pastes credentials. */
export interface FeishuAppInfo {
  /** The app ID: one Installation per self-built app. */
  readonly providerInstallationId: string;
  /** The bot's display name. */
  readonly accountLogin: string;
  /**
   * The bot's `open_id` in this app, for mention detection. The Bond kernel
   * has no field for it, so the host keeps it beside the Installation.
   */
  readonly botOpenId: string;
}

/**
 * Proves pasted credentials work and reads the bot behind them: mints a
 * tenant token, then `GET /open-apis/bot/v3/info`. Fails when the app has no
 * bot capability.
 */
export const inspectFeishuApp = (
  app: SelfBuiltAppCredentials,
): Effect.Effect<FeishuAppInfo, ProviderError> =>
  Effect.gen(function* () {
    const { open } = yield* endpoints(app.baseUrl);
    const { token } = yield* mintTenantAccessToken(app);
    const response = yield* requestJson(
      app.fetch ?? globalThis.fetch,
      `${open}/open-apis/bot/v3/info`,
      {
        method: "GET",
        headers: { ...bearer(token), accept: "application/json" },
      },
    );
    const bot = isRecord(response.body) ? response.body.bot : undefined;
    if (
      !succeeded(response) ||
      !isRecord(bot) ||
      typeof bot.open_id !== "string"
    ) {
      return yield* Effect.fail(
        feishuError("Reading the Feishu bot", response),
      );
    }
    return {
      providerInstallationId: app.appId,
      accountLogin:
        typeof bot.app_name === "string" && bot.app_name.length > 0
          ? bot.app_name
          : app.appId,
      botOpenId: bot.open_id,
    };
  });
