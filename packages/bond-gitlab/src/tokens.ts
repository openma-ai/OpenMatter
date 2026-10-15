import type { ProviderError } from "@openma/matter-bond";
import { Effect } from "effect";
import {
  bearer,
  canonicalOrigin,
  isRecord,
  requestJson,
  statusError,
  type Fetch,
} from "./http.js";

/** `GET /api/v4/user`. Numeric `id` is the stable key; the rest is display data. */
export interface GitLabUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly commitEmail?: string;
  readonly bot: boolean;
  readonly identities: readonly {
    readonly provider: string;
    readonly externUid: string;
  }[];
}

/** `GET /api/v4/personal_access_tokens/self`. Works for personal, project, and group access tokens. */
export interface GitLabTokenInfo {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly revoked: boolean;
  readonly scopes: readonly string[];
  /** `YYYY-MM-DD`, or undefined for a token without expiry. */
  readonly expiresAt?: string;
  readonly userId: string;
}

const api = (origin: string, path: string) =>
  `${canonicalOrigin(origin)}/api/v4${path}`;

export const readUser = (
  origin: string,
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Effect.Effect<GitLabUser, ProviderError> =>
  Effect.gen(function* () {
    const response = yield* requestJson(fetchImpl, api(origin, "/user"), {
      method: "GET",
      headers: { ...bearer(token), accept: "application/json" },
    });
    const b = response.body;
    if (response.status !== 200 || !isRecord(b) || typeof b.id !== "number") {
      return yield* Effect.fail(
        statusError("Reading the GitLab user", response),
      );
    }
    const identities = Array.isArray(b.identities)
      ? b.identities.flatMap((i) =>
          isRecord(i) &&
          typeof i.provider === "string" &&
          typeof i.extern_uid === "string"
            ? [{ provider: i.provider, externUid: i.extern_uid }]
            : [],
        )
      : [];
    return {
      id: String(b.id),
      username: typeof b.username === "string" ? b.username : "",
      name: typeof b.name === "string" ? b.name : "",
      ...(typeof b.commit_email === "string" && b.commit_email.length > 0
        ? { commitEmail: b.commit_email }
        : {}),
      bot: b.bot === true,
      identities,
    };
  });

export const readTokenInfo = (
  origin: string,
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Effect.Effect<GitLabTokenInfo, ProviderError> =>
  Effect.gen(function* () {
    const response = yield* requestJson(
      fetchImpl,
      api(origin, "/personal_access_tokens/self"),
      {
        method: "GET",
        headers: { ...bearer(token), accept: "application/json" },
      },
    );
    const b = response.body;
    if (response.status !== 200 || !isRecord(b) || typeof b.id !== "number") {
      return yield* Effect.fail(
        statusError("Reading token metadata", response),
      );
    }
    return {
      id: String(b.id),
      name: typeof b.name === "string" ? b.name : "",
      active: b.active === true,
      revoked: b.revoked === true,
      scopes: Array.isArray(b.scopes)
        ? b.scopes.filter((s): s is string => typeof s === "string")
        : [],
      ...(typeof b.expires_at === "string" ? { expiresAt: b.expires_at } : {}),
      userId: String(b.user_id),
    };
  });

/** `DELETE /api/v4/personal_access_tokens/self`: a token revokes itself. */
export const revokeSelfToken = (
  origin: string,
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const response = yield* requestJson(
      fetchImpl,
      api(origin, "/personal_access_tokens/self"),
      { method: "DELETE", headers: bearer(token) },
    );
    if (response.status !== 204 && response.status !== 200) {
      return yield* Effect.fail(statusError("Token self-revocation", response));
    }
  });

export interface TokenPolicy {
  readonly allowedScopes: readonly string[];
  readonly maxLifetimeDays: number;
  /** ISO now. */
  readonly now: string;
}

export type TokenProblem =
  | "inactive"
  | "revoked"
  | "no_expiry"
  | "expired"
  | "lifetime_exceeded"
  | "scope_not_allowed"
  | "not_a_bot"
  | "is_a_bot"
  | "user_mismatch";

/** End of the UTC expiry day, which is when GitLab stops accepting the token. */
export const tokenExpiryInstant = (expiresAt: string): string =>
  new Date(`${expiresAt}T23:59:59.999Z`).toISOString();

const commonProblems = (
  info: GitLabTokenInfo,
  user: GitLabUser,
  policy: TokenPolicy,
): TokenProblem[] => {
  const problems: TokenProblem[] = [];
  // Both reads must describe the same token: a mixed pair proves nothing.
  if (info.userId !== user.id) problems.push("user_mismatch");
  if (info.revoked) problems.push("revoked");
  if (!info.active) problems.push("inactive");
  if (info.scopes.some((s) => !policy.allowedScopes.includes(s))) {
    problems.push("scope_not_allowed");
  }
  if (info.expiresAt === undefined) {
    problems.push("no_expiry");
  } else {
    const end = Date.parse(tokenExpiryInstant(info.expiresAt));
    const now = Date.parse(policy.now);
    if (end <= now) problems.push("expired");
    else if (end - now > (policy.maxLifetimeDays + 1) * 24 * 60 * 60_000) {
      problems.push("lifetime_exceeded");
    }
  }
  return problems;
};

/**
 * Checks a pasted personal access token: active, scopes within the allowed
 * set, an expiry within the maximum lifetime, and a human owner.
 */
export const validatePersonalAccessToken = (
  info: GitLabTokenInfo,
  user: GitLabUser,
  policy: TokenPolicy,
): readonly TokenProblem[] => [
  ...commonProblems(info, user, policy),
  ...(user.bot ? (["is_a_bot"] as const) : []),
];

/**
 * Checks a bot credential registered as an Installation: the same token
 * checks, plus `bot: true` on its user. A human account's token is never
 * accepted as an app principal.
 */
export const validateBotCredential = (
  info: GitLabTokenInfo,
  user: GitLabUser,
  policy: TokenPolicy,
): readonly TokenProblem[] => [
  ...commonProblems(info, user, policy),
  ...(user.bot ? [] : (["not_a_bot"] as const)),
];
