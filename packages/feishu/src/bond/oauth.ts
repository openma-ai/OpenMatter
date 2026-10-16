import type { ProviderError, TokenGrant } from "@openma/matter/bond";
import { Effect } from "effect";
import {
  endpoints,
  feishuCode,
  feishuEndpoints,
  feishuError,
  isoNow,
  isRecord,
  plusSeconds,
  requestJson,
  succeeded,
  type JsonResponse,
} from "./http.js";
import type { SelfBuiltAppCredentials } from "./tokens.js";

/**
 * The app that users authorize. User tokens are issued to the same
 * self-built app as the bot, so a user's `open_id` matches the sender of the
 * events that app receives.
 */
export type OAuthClient = SelfBuiltAppCredentials;

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

/** A fresh PKCE verifier and its S256 challenge. Keep the verifier server-side. */
export const createPkce = (): Effect.Effect<Pkce> =>
  Effect.promise(async () => {
    const verifier = base64url(
      globalThis.crypto.getRandomValues(new Uint8Array(48)),
    );
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return {
      verifier,
      challenge: base64url(new Uint8Array(digest)),
      method: "S256",
    };
  });

export interface AuthorizationUrlInput {
  readonly baseUrl: string;
  /** The app ID. */
  readonly clientId: string;
  /** Must be allowlisted in the app's security settings. */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Signed, single-use state bound to the user and ProviderApp. */
  readonly state: string;
  readonly codeChallenge: string;
}

/** The redirect authorization URL on the accounts origin, with PKCE S256. */
export const authorizationUrl = (input: AuthorizationUrlInput): string =>
  `${feishuEndpoints(input.baseUrl).accounts}/open-apis/authen/v1/authorize?${new URLSearchParams(
    {
      client_id: input.clientId,
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: input.scopes.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    },
  ).toString()}`;

/**
 * Feishu answers that mean the grant or code itself is gone, so the link
 * must end: invalid or expired code (20003, 20004), invalid, expired, or
 * reused refresh token (20026, 20037, 20064, 20065), and OAuth
 * `invalid_grant`. Client errors such as a wrong secret are configuration
 * problems and must not end every link.
 */
const REJECTED_CODES = new Set([20003, 20004, 20026, 20037, 20064, 20065]);

const isRejection = (response: JsonResponse): boolean => {
  const code = feishuCode(response.body);
  const error =
    isRecord(response.body) && typeof response.body.error === "string"
      ? response.body.error
      : undefined;
  return (
    (code !== undefined && REJECTED_CODES.has(code)) ||
    error === "invalid_grant"
  );
};

const tokenGrant = (body: unknown, now: string): TokenGrant | undefined => {
  if (!isRecord(body) || typeof body.access_token !== "string")
    return undefined;
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string"
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.expires_in === "number"
      ? { accessExpiresAt: plusSeconds(now, body.expires_in) }
      : {}),
    scopes:
      typeof body.scope === "string"
        ? body.scope.split(" ").filter(Boolean)
        : [],
  };
};

/**
 * `POST accounts…/oauth/v3/token`, form encoded. The client credentials go
 * in the body only: Feishu answers 20070 when they also arrive as a Basic
 * authorization header.
 */
const postToken = (
  client: OAuthClient,
  params: Record<string, string>,
): Effect.Effect<{ response: JsonResponse; now: string }, ProviderError> =>
  Effect.gen(function* () {
    const { accounts } = yield* endpoints(client.baseUrl);
    const now = isoNow(client.clock);
    const response = yield* requestJson(
      client.fetch ?? globalThis.fetch,
      `${accounts}/oauth/v3/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          ...params,
          client_id: client.appId,
          client_secret: client.appSecret,
        }).toString(),
      },
    );
    return { response, now };
  });

const grantOrFail = (
  what: string,
  { response, now }: { response: JsonResponse; now: string },
): Effect.Effect<TokenGrant, ProviderError> => {
  const grant = succeeded(response)
    ? tokenGrant(response.body, now)
    : undefined;
  return grant === undefined
    ? Effect.fail(feishuError(what, response, isRejection(response)))
    : Effect.succeed(grant);
};

/** Exchanges a redirect authorization code. */
export const exchangeCode = (
  client: OAuthClient,
  input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  },
): Effect.Effect<TokenGrant, ProviderError> =>
  postToken(client, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  }).pipe(Effect.flatMap((r) => grantOrFail("Authorization code exchange", r)));

/**
 * Refreshes a user token. Feishu refresh tokens are single use and rotate,
 * so the caller must hold the Bond refresh lease and store the returned
 * pair together.
 */
export const refreshUserAccessToken = (
  client: OAuthClient,
  refreshToken: string,
): Effect.Effect<TokenGrant, ProviderError> =>
  postToken(client, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }).pipe(Effect.flatMap((r) => grantOrFail("Token refresh", r)));

export interface DeviceAuthorization {
  readonly deviceCode: string;
  /** Shown to the user. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** Carries the user code; render it as a link or QR code. */
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
  /** Seconds between polls. */
  readonly interval: number;
}

const DEFAULT_INTERVAL = 5;
const MAX_INTERVAL = 60;

/**
 * Starts a device authorization (`POST accounts…/oauth/v1/device_authorization`).
 * `offline_access` is always requested so the link gets a refresh token.
 * The user confirms in Feishu; no redirect URL is needed, so this works for
 * every self-built app. The endpoint is the one lark-cli uses.
 */
export const beginDeviceAuthorization = (
  client: OAuthClient,
  scopes: readonly string[],
): Effect.Effect<DeviceAuthorization, ProviderError> =>
  Effect.gen(function* () {
    const { accounts } = yield* endpoints(client.baseUrl);
    const now = isoNow(client.clock);
    const requested = scopes.includes("offline_access")
      ? scopes
      : [...scopes, "offline_access"];
    const response = yield* requestJson(
      client.fetch ?? globalThis.fetch,
      `${accounts}/oauth/v1/device_authorization`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: client.appId,
          client_secret: client.appSecret,
          scope: requested.join(" "),
        }).toString(),
      },
    );
    const b = response.body;
    if (
      !succeeded(response) ||
      !isRecord(b) ||
      typeof b.device_code !== "string" ||
      typeof b.user_code !== "string" ||
      typeof b.verification_uri !== "string" ||
      typeof b.expires_in !== "number"
    ) {
      return yield* Effect.fail(
        feishuError("Starting the device authorization", response),
      );
    }
    return {
      deviceCode: b.device_code,
      userCode: b.user_code,
      verificationUri: b.verification_uri,
      ...(typeof b.verification_uri_complete === "string"
        ? { verificationUriComplete: b.verification_uri_complete }
        : {}),
      expiresAt: plusSeconds(now, b.expires_in),
      interval:
        typeof b.interval === "number" && b.interval > 0
          ? b.interval
          : DEFAULT_INTERVAL,
    };
  });

export type DevicePoll =
  | { readonly status: "pending"; readonly interval: number }
  /** Poll less often from now on. */
  | { readonly status: "slow_down"; readonly interval: number }
  | { readonly status: "expired" }
  | { readonly status: "denied" }
  | { readonly status: "granted"; readonly grant: TokenGrant };

/**
 * Polls a device authorization once. The caller schedules the next poll
 * after `interval` seconds and stops on any answer other than pending or
 * slow_down. Polling is a host job, not a request handler loop.
 */
export const pollDeviceToken = (
  client: OAuthClient,
  input: { readonly deviceCode: string; readonly interval: number },
): Effect.Effect<DevicePoll, ProviderError> =>
  postToken(client, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: input.deviceCode,
  }).pipe(
    Effect.flatMap(
      ({ response, now }): Effect.Effect<DevicePoll, ProviderError> => {
        if (succeeded(response)) {
          const grant = tokenGrant(response.body, now);
          if (grant !== undefined)
            return Effect.succeed({ status: "granted", grant });
        }
        const error =
          isRecord(response.body) && typeof response.body.error === "string"
            ? response.body.error
            : undefined;
        switch (error) {
          case "authorization_pending":
            return Effect.succeed({
              status: "pending",
              interval: input.interval,
            });
          case "slow_down":
            return Effect.succeed({
              status: "slow_down",
              interval: Math.min(input.interval + 5, MAX_INTERVAL),
            });
          case "expired_token":
            return Effect.succeed({ status: "expired" });
          case "access_denied":
            return Effect.succeed({ status: "denied" });
          default:
            return Effect.fail(feishuError("Device token poll", response));
        }
      },
    ),
  );

/**
 * Revokes one user access or refresh token (`POST accounts…/oauth/v1/revoke`,
 * the endpoint lark-cli uses). Revoking one token does not end the user's
 * other tokens for the same app.
 */
export const revokeUserToken = (
  client: OAuthClient,
  token: string,
): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const { accounts } = yield* endpoints(client.baseUrl);
    const response = yield* requestJson(
      client.fetch ?? globalThis.fetch,
      `${accounts}/oauth/v1/revoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          token,
          client_id: client.appId,
          client_secret: client.appSecret,
        }).toString(),
      },
    );
    if (!succeeded(response)) {
      return yield* Effect.fail(feishuError("Token revocation", response));
    }
  });
