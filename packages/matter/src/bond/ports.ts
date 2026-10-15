import { Data, type Effect } from "effect";
import type {
  Installation,
  ProviderAppConfig,
  RefreshLease,
  Sealed,
  SealedTokens,
  Tombstone,
  UserLink,
  UserLinkStatus,
  UserLinkWrite,
} from "./types.js";

export class StoreError extends Data.TaggedError("BondStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ConfigError extends Data.TaggedError("BondConfigError")<{
  readonly message: string;
  readonly providerAppId: string;
  readonly cause?: unknown;
}> {}

export class CipherError extends Data.TaggedError("BondCipherError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A provider call failed. `rejected` means the provider refused the grant
 * itself (for example `invalid_grant`), which ends the link. Use it for
 * nothing else: configuration problems such as `invalid_client` and
 * transport failures are not rejections, and are retryable.
 *
 * Bond never persists `message`, but applications may log it, so it must not
 * contain tokens, secrets, or provider response bodies.
 */
export class ProviderError extends Data.TaggedError("BondProviderError")<{
  readonly message: string;
  readonly rejected: boolean;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/**
 * Implemented by the application. Returns the effective configuration of one
 * ProviderApp for one tenant, so policy can be a workspace setting even when
 * the ProviderApp (a GitHub App) is shared. Read on every operation; never
 * cached by Bond.
 */
export interface ProviderAppSource {
  readonly get: (q: {
    readonly tenantId: string;
    readonly providerAppId: string;
  }) => Effect.Effect<ProviderAppConfig, ConfigError>;
}

/** Implemented by the application, for example with a KMS or a purpose-bound cipher. */
export interface SecretCipher {
  readonly seal: (
    plaintext: string,
    purpose: string,
  ) => Effect.Effect<Sealed, CipherError>;
  readonly open: (
    sealed: Sealed,
    purpose: string,
  ) => Effect.Effect<string, CipherError>;
}

export type ClaimResult = "claimed" | "already_owned" | "owned_elsewhere";
export type LeaseResult = RefreshLease | "held" | "not_active";
export type CommitResult = "committed" | "stale_lease" | "revoked";
export type UpsertResult = UserLink | "provider_user_taken";
export type CredentialUpdateResult = "updated" | "not_found";

/**
 * Persistence port. Every read is tenant-scoped. Plaintext tokens never pass
 * through it. Invariants are in docs/BONDS.md and are checked by
 * `bondStoreConformanceCases`.
 */
export interface BondStore {
  readonly getInstallation: (q: {
    readonly tenantId: string;
    readonly installationId: string;
  }) => Effect.Effect<Installation | undefined, StoreError>;
  /** Installations of one ProviderApp owned by the tenant, in claim order. */
  readonly listInstallations: (q: {
    readonly tenantId: string;
    readonly providerAppId: string;
  }) => Effect.Effect<readonly Installation[], StoreError>;
  /** Unique by (providerAppId, providerInstallationId) across all tenants. */
  readonly claimInstallation: (
    value: Installation,
  ) => Effect.Effect<ClaimResult, StoreError>;
  /**
   * Replaces the stored credential of an active Installation owned by the
   * tenant, for example a rotated GitLab bot token. Never touches another
   * tenant's Installation.
   */
  readonly updateInstallationCredential: (q: {
    readonly tenantId: string;
    readonly installationId: string;
    readonly credential: Sealed;
    readonly credentialExpiresAt?: string;
  }) => Effect.Effect<CredentialUpdateResult, StoreError>;
  readonly releaseInstallation: (q: {
    readonly tenantId: string;
    readonly installationId: string;
    readonly actor: string;
  }) => Effect.Effect<void, StoreError>;

  readonly getUserLink: (q: {
    readonly tenantId: string;
    readonly linkId: string;
  }) => Effect.Effect<UserLink | undefined, StoreError>;
  /**
   * The active link of one application user, if any. Two can be active only
   * between persisting a relink to a different provider account and retiring
   * the previous link; return the most recently created one.
   */
  readonly findUserLink: (q: {
    readonly tenantId: string;
    readonly appUserId: string;
    readonly providerAppId: string;
  }) => Effect.Effect<UserLink | undefined, StoreError>;
  /** The active link held by one provider user, if any. */
  readonly findUserLinkByProviderUser: (q: {
    readonly tenantId: string;
    readonly providerAppId: string;
    readonly providerUserId: string;
  }) => Effect.Effect<UserLink | undefined, StoreError>;
  readonly listUserLinks: (q: {
    readonly tenantId: string;
    readonly providerAppId: string;
    readonly status?: UserLinkStatus;
  }) => Effect.Effect<readonly UserLink[], StoreError>;
  /**
   * Idempotent by (tenant, provider user, ProviderApp) while the link is
   * active. Returns `provider_user_taken` when another application user holds
   * the active link. A revoked link is never reused: a new id is created.
   */
  readonly upsertUserLink: (
    value: UserLinkWrite,
  ) => Effect.Effect<UpsertResult, StoreError>;
  /** Never changes a revoked link. */
  readonly updateUserLinkStatus: (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly status: Exclude<UserLinkStatus, "active" | "revoked">;
    readonly reason: string;
  }) => Effect.Effect<void, StoreError>;

  /** Atomic compare-and-set. At most one unexpired lease per link. */
  readonly acquireRefreshLease: (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly owner: string;
    readonly ttlMs: number;
  }) => Effect.Effect<LeaseResult, StoreError>;
  /** Fenced by the lease token. Never succeeds after revocation. */
  readonly commitRefresh: (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly lease: RefreshLease;
    readonly tokens: SealedTokens;
  }) => Effect.Effect<CommitResult, StoreError>;
  readonly releaseRefreshLease: (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly lease: RefreshLease;
  }) => Effect.Effect<void, StoreError>;
  readonly revokeUserLink: (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly tombstone: Tombstone;
  }) => Effect.Effect<void, StoreError>;
}

/** A fresh grant returned by a provider. Plaintext, held only in memory. */
export interface TokenGrant {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accessExpiresAt?: string;
  /**
   * The scopes the provider reports for the token. Linking refuses a grant
   * without them. A provider whose tokens carry no scopes (GitHub App user
   * tokens) reports an empty list explicitly.
   */
  readonly scopes?: readonly string[];
}

/** Provider-specific protocol, implemented by the GitHub and GitLab Bond providers. */
export interface BondProvider {
  readonly provider: "github" | "gitlab";
  /**
   * Whether user-principal output carries a provider-native delegation
   * marker, such as GitHub's "with App". Without one, user-principal writes
   * need `allowUserPrincipalOutput` (IDENTITY_MODEL.md).
   */
  readonly delegationMarker: boolean;
  readonly refreshUserToken: (
    config: ProviderAppConfig,
    refreshToken: string,
  ) => Effect.Effect<TokenGrant, ProviderError>;
  /**
   * Revokes exactly the given token (and its refresh token). It must not
   * revoke other tokens of the same user and application, such as by deleting
   * a GitHub OAuth grant, because a relink revokes the previous token after
   * the new one is stored.
   */
  readonly revokeUserToken: (
    config: ProviderAppConfig,
    tokens: {
      readonly method: "oauth" | "pat";
      readonly accessToken: string;
      readonly refreshToken?: string;
    },
  ) => Effect.Effect<void, ProviderError>;
  /**
   * The app credential for one Installation. `storedCredential` is the opened
   * Installation credential when one is stored (GitLab bot token); providers
   * with a minting protocol (GitHub) ignore it and mint.
   */
  readonly appCredential: (
    config: ProviderAppConfig,
    installation: Installation,
    storedCredential: string | undefined,
  ) => Effect.Effect<
    { readonly token: string; readonly expiresAt?: string },
    ProviderError
  >;
}
