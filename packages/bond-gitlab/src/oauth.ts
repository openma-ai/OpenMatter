import { ProviderError, type TokenGrant } from "@openmatter/bond";
import { Effect } from "effect";
import {
  canonicalOrigin,
  isRecord,
  requestJson,
  statusError,
  type Fetch,
} from "./http.js";

/**
 * What discovery verified. OAuth calls always use the instance's fixed
 * `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke` under `origin`, so
 * discovery returns no endpoints that callers might follow elsewhere.
 */
export interface GitLabInstance {
  readonly origin: string;
  /** Whether the instance enables the device authorization grant. */
  readonly deviceFlow: boolean;
}

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/**
 * Reads OIDC discovery and requires authorization code with PKCE S256 and
 * refresh tokens, and an issuer equal to the instance origin. Device flow is
 * recorded when present; GitLab can disable it per instance.
 */
export const discoverInstance = (
  origin: string,
  fetchImpl: Fetch = globalThis.fetch,
): Effect.Effect<GitLabInstance, ProviderError> =>
  Effect.gen(function* () {
    const canonical = yield* Effect.try({
      try: () => canonicalOrigin(origin),
      catch: (cause) =>
        new ProviderError({
          message: cause instanceof Error ? cause.message : "Invalid origin",
          rejected: true,
          cause,
        }),
    });
    const response = yield* requestJson(
      fetchImpl,
      `${canonical}/.well-known/openid-configuration`,
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (response.status !== 200 || !isRecord(response.body)) {
      return yield* Effect.fail(statusError("OIDC discovery", response));
    }
    const d = response.body;
    const list = (key: string) =>
      Array.isArray(d[key])
        ? (d[key] as unknown[]).filter((v) => typeof v === "string")
        : [];
    const problems: string[] = [];
    if (
      typeof d.issuer !== "string" ||
      d.issuer.replace(/\/$/, "").toLowerCase() !== canonical
    ) {
      problems.push("issuer does not match the instance origin");
    }
    if (!list("code_challenge_methods_supported").includes("S256")) {
      problems.push("PKCE S256 is not supported");
    }
    if (!list("grant_types_supported").includes("refresh_token")) {
      problems.push("refresh_token grant is not supported");
    }
    if (
      typeof d.authorization_endpoint !== "string" ||
      typeof d.token_endpoint !== "string"
    ) {
      problems.push("authorization or token endpoint is missing");
    }
    if (problems.length > 0) {
      return yield* Effect.fail(
        new ProviderError({
          message: `GitLab instance is not usable: ${problems.join("; ")}`,
          rejected: true,
        }),
      );
    }
    return {
      origin: canonical,
      deviceFlow: typeof d.device_authorization_endpoint === "string",
    };
  });

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
  readonly origin: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Signed, single-use state bound to the user and ProviderApp. */
  readonly state: string;
  readonly codeChallenge: string;
}

export const authorizationUrl = (input: AuthorizationUrlInput): string =>
  `${canonicalOrigin(input.origin)}/oauth/authorize?${new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString()}`;

export interface OAuthClient {
  readonly origin: string;
  readonly clientId: string;
  /** Absent for public clients. */
  readonly clientSecret?: string;
  readonly fetch?: Fetch;
  /** ISO now, for computing expiry. */
  readonly clock?: () => string;
}

const tokenGrant = (body: unknown, now: string): TokenGrant | undefined => {
  if (!isRecord(body) || typeof body.access_token !== "string")
    return undefined;
  // GitLab returns created_at (seconds) and expires_in (seconds).
  const createdMs =
    typeof body.created_at === "number"
      ? body.created_at * 1000
      : Date.parse(now);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string"
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.expires_in === "number"
      ? {
          accessExpiresAt: new Date(
            createdMs + body.expires_in * 1000,
          ).toISOString(),
        }
      : {}),
    ...(typeof body.scope === "string"
      ? { scopes: body.scope.split(" ").filter(Boolean) }
      : {}),
  };
};

const postToken = (
  client: OAuthClient,
  what: string,
  params: Record<string, string>,
) =>
  Effect.gen(function* () {
    const origin = canonicalOrigin(client.origin);
    const now = (client.clock ?? (() => new Date().toISOString()))();
    const response = yield* requestJson(
      client.fetch ?? globalThis.fetch,
      `${origin}/oauth/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          ...params,
          client_id: client.clientId,
          ...(client.clientSecret === undefined
            ? {}
            : { client_secret: client.clientSecret }),
        }).toString(),
      },
    );
    const grant =
      response.status === 200 ? tokenGrant(response.body, now) : undefined;
    if (grant === undefined)
      return yield* Effect.fail(statusError(what, response));
    return grant;
  });

/** Exchanges an authorization code. A wrong verifier does not consume the code on GitLab. */
export const exchangeCode = (
  client: OAuthClient,
  input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  },
) =>
  postToken(client, "Authorization code exchange", {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });

/**
 * Refreshes a user token. GitLab rotates both tokens and invalidates the old
 * access token immediately, and does not detect refresh-token reuse, so the
 * caller must hold the Bond refresh lease.
 */
export const refreshAccessToken = (client: OAuthClient, refreshToken: string) =>
  postToken(client, "Token refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

/**
 * Revokes one access or refresh token. GitLab (Doorkeeper) stores an access
 * token and its refresh token as one record, so revoking either ends that
 * pair only. Other tokens the same user holds for the same application keep
 * working: on a live instance, revoking the previous token after a relink left
 * the new one valid.
 */
export const revokeToken = (client: OAuthClient, token: string) =>
  Effect.gen(function* () {
    const origin = canonicalOrigin(client.origin);
    const response = yield* requestJson(
      client.fetch ?? globalThis.fetch,
      `${origin}/oauth/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          client_id: client.clientId,
          ...(client.clientSecret === undefined
            ? {}
            : { client_secret: client.clientSecret }),
        }).toString(),
      },
    );
    if (response.status !== 200) {
      return yield* Effect.fail(statusError("Token revocation", response));
    }
  });
