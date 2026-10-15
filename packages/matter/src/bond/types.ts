// Domain values for Bond. See docs/BONDS.md.
//
// Identifiers only: plaintext credentials never appear in these types. Tokens
// cross the store boundary as `Sealed` values produced by the application's
// SecretCipher.

export type ProviderKind = "github" | "gitlab";

/** How a user linked: provider authorization or a pasted personal access token. */
export type LinkMethod = "oauth" | "pat";

export type LinkMethodPolicy = "pat_only" | "oauth_only" | "oauth_preferred";

/** Which principal an operation may use. See "Principal selection". */
export type PrincipalPolicy = "app" | "user" | "user_only";

export type IdentityBinding =
  | { readonly kind: "none" }
  | { readonly kind: "sso_extern_uid"; readonly ssoProvider: string };

/** A reference the application resolves to secret material. Never the secret. */
export interface SecretRef {
  readonly ref: string;
}

/**
 * The effective configuration of one ProviderApp for one tenant, supplied by
 * the application through ProviderAppSource and read again on every
 * operation. Provider identity (provider, origin, OAuth client, GitHub App)
 * is shared by every tenant; the policy fields may differ per tenant.
 */
export interface ProviderAppConfig {
  readonly id: string;
  readonly provider: ProviderKind;
  /** Canonical https origin, for example `https://gitlab.example.com`. */
  readonly baseUrl: string;
  readonly linkMethodPolicy: LinkMethodPolicy;
  readonly principalPolicy: PrincipalPolicy;
  /** Rule 6. Off unless the application enables it. */
  readonly participantsAsPrincipal?: boolean;
  readonly allowedScopes: readonly string[];
  /** Maximum lifetime of an accepted personal access token. */
  readonly maxPatLifetimeDays?: number;
  readonly identityBinding: IdentityBinding;
  /** The IDENTITY_MODEL administrator opt-in for providers without a delegation marker. */
  readonly allowUserPrincipalOutput: boolean;
  readonly oauth?: {
    readonly clientId: string;
    readonly clientSecret?: SecretRef;
  };
  readonly github?: {
    readonly appId: string;
    readonly slug: string;
    readonly privateKey: SecretRef;
  };
  readonly caBundle?: SecretRef;
}

/** Ciphertext and the key that sealed it. Always stored and returned together. */
export interface Sealed {
  readonly keyId: string;
  readonly ciphertext: string;
}

export type InstallationStatus =
  "pending" | "active" | "suspended" | "revoked" | "released";

/** The app principal in one provider account or group, owned by exactly one tenant. */
export interface Installation {
  readonly id: string;
  readonly tenantId: string;
  readonly providerAppId: string;
  /** GitHub installation id, or the bot user id of a GitLab bot credential. */
  readonly providerInstallationId: string;
  readonly accountLogin?: string;
  readonly status: InstallationStatus;
  readonly claimedBy: string;
  readonly claimedAt: string;
  /** Present when the provider has no minting protocol, as with a GitLab bot token. */
  readonly credential?: Sealed;
  readonly credentialExpiresAt?: string;
}

export type UserLinkStatus =
  "active" | "refresh_failed" | "expired" | "method_disallowed" | "revoked";

/** One application user ↔ one provider user under one ProviderApp. */
export interface UserLink {
  readonly id: string;
  readonly tenantId: string;
  readonly appUserId: string;
  readonly providerAppId: string;
  /** Stable provider user id. Login and email are display data. */
  readonly providerUserId: string;
  readonly login: string;
  readonly method: LinkMethod;
  readonly access: Sealed;
  readonly refresh?: Sealed;
  readonly accessExpiresAt?: string;
  readonly scopes: readonly string[];
  readonly status: UserLinkStatus;
  readonly statusReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Increases on every token or status change. */
  readonly revision: number;
}

export interface UserLinkWrite {
  readonly tenantId: string;
  readonly appUserId: string;
  readonly providerAppId: string;
  readonly providerUserId: string;
  readonly login: string;
  readonly method: LinkMethod;
  readonly access: Sealed;
  readonly refresh?: Sealed;
  readonly accessExpiresAt?: string;
  readonly scopes: readonly string[];
}

export interface SealedTokens {
  readonly access: Sealed;
  readonly refresh?: Sealed;
  readonly accessExpiresAt?: string;
  readonly scopes?: readonly string[];
}

export interface RefreshLease {
  readonly token: string;
  readonly owner: string;
  readonly expiresAt: string;
}

export interface Tombstone {
  readonly at: string;
  readonly actor: string;
  readonly reason: string;
}

/** Who performs one external operation. */
export type ExecutionPrincipal =
  | {
      readonly kind: "app";
      readonly providerAppId: string;
      readonly installationId: string;
    }
  | {
      readonly kind: "user";
      readonly providerAppId: string;
      readonly userLinkId: string;
      readonly installationId?: string;
    };

/**
 * Why the resolved principal differs from the requested one. `policy_app`
 * means the requester asked to act as themselves and the policy is `app`.
 */
export type FallbackReason =
  | "no_link"
  | "refresh_failed"
  | "expired"
  | "method_disallowed"
  | "revoked"
  | "policy_app";

export interface PrincipalResolution {
  readonly principal: ExecutionPrincipal;
  readonly policy: PrincipalPolicy;
  readonly fallback: false | { readonly reason: FallbackReason };
  readonly trigger: "attended" | "unattended";
  /** The application user who caused the work, when known. */
  readonly requesterId?: string;
}

/** A usable credential for one operation. Hold it in memory only. */
export interface BondCredential {
  readonly token: string;
  readonly principal: ExecutionPrincipal;
  readonly method?: LinkMethod;
  readonly expiresAt?: string;
}

/**
 * One immutable fact per credential resolution, granted or denied.
 * Identifiers only, never tokens. The visible author on the work surface is
 * recorded by the integration that writes the output.
 */
export interface AuditFact {
  readonly at: string;
  readonly outcome: "granted" | "denied";
  /** The failure reason, when denied. */
  readonly denial?: string;
  readonly tenantId: string;
  readonly providerAppId: string;
  readonly requestingActor?: string;
  readonly trigger: "attended" | "unattended";
  /** Present when granted. */
  readonly executionPrincipal?: ExecutionPrincipal;
  readonly method?: LinkMethod;
  /** Absent only when the configuration could not be read. */
  readonly policy?: PrincipalPolicy;
  readonly fallback: false | { readonly reason: FallbackReason };
  readonly access: "read" | "write";
  readonly operation?: string;
  /** Resource address, such as a project path. */
  readonly resource?: string;
}

export type LinkHealth = "ok" | "expiring" | "expired" | "inactive";
