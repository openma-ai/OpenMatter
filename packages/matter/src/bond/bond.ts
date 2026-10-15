import type {
  CredentialRequest,
  CredentialResolver,
  ExecutionPrincipalRequest,
} from "../credentials/index.js";
import { CredentialError } from "../credentials/index.js";
import { Duration, Effect, Either } from "effect";
import { BondError, bondError } from "./errors.js";
import type {
  BondProvider,
  BondStore,
  ProviderAppSource,
  SecretCipher,
  TokenGrant,
} from "./ports.js";
import { ProviderError } from "./ports.js";
import { selectPrincipal, type LinkState } from "./principal.js";
import type {
  AuditFact,
  BondCredential,
  Installation,
  LinkHealth,
  LinkMethod,
  LinkMethodPolicy,
  PrincipalPolicy,
  PrincipalResolution,
  ProviderAppConfig,
  ProviderKind,
  Sealed,
  UserLink,
} from "./types.js";

/** Cipher purposes. Applications may bind them to separate keys. */
export const SealPurpose = {
  userAccess: "bond.user.access",
  userRefresh: "bond.user.refresh",
  installationCredential: "bond.installation.credential",
} as const;

export const allowedLinkMethods = (
  policy: LinkMethodPolicy,
): readonly LinkMethod[] =>
  policy === "pat_only"
    ? ["pat"]
    : policy === "oauth_only"
      ? ["oauth", "device"]
      : ["oauth", "device", "pat"];

export interface BondOptions {
  readonly providerApps: ProviderAppSource;
  readonly store: BondStore;
  readonly cipher: SecretCipher;
  readonly providers: Partial<Record<ProviderKind, BondProvider>>;
  /** ISO-8601 now. Defaults to the system clock. */
  readonly clock?: () => string;
  /** Owner recorded on refresh leases. Defaults to a random id per kernel. */
  readonly leaseOwner?: string;
  /** Refresh OAuth access tokens this long before expiry. Default 5 minutes. */
  readonly refreshSkewMs?: number;
  /** Refresh lease lifetime. Default 30 seconds. */
  readonly leaseTtlMs?: number;
  /** Wait between attempts while another caller holds the lease. Default 100 ms. */
  readonly leaseRetryMs?: number;
  /** Attempts before giving up on a held lease. Default 50. */
  readonly leaseAttempts?: number;
  /** Report `expiring` for personal access tokens inside this window. Default 7 days. */
  readonly patWarningMs?: number;
  /** Receives one fact per credential resolution, granted or denied. */
  readonly audit?: (fact: AuditFact) => Effect.Effect<void>;
}

export interface LinkInput {
  readonly tenantId: string;
  readonly appUserId: string;
  readonly providerAppId: string;
  readonly method: LinkMethod;
  readonly providerUser: {
    readonly id: string;
    readonly login: string;
    /** Provider SSO identities, for identity binding. */
    readonly identities?: readonly {
      readonly provider: string;
      readonly externUid: string;
    }[];
  };
  /** The application user's SSO subject, required with `sso_extern_uid`. */
  readonly ssoSubject?: string;
  readonly grant: TokenGrant;
  readonly actor: string;
}

export interface ClaimInstallationInput {
  readonly tenantId: string;
  readonly providerAppId: string;
  readonly providerInstallationId: string;
  readonly accountLogin?: string;
  readonly actor: string;
  /**
   * The caller has verified that `actor` can access this installation on the
   * provider (GitHub: `GET /user/installations`; GitLab: bot credential
   * validation). Bond does not accept an unverified claim.
   */
  readonly verified: true;
  /** Stored credential, for providers without a minting protocol. */
  readonly credential?: {
    readonly token: string;
    readonly expiresAt?: string;
  };
}

export interface CredentialInput {
  readonly tenantId: string;
  readonly providerAppId: string;
  /** Required when the tenant owns several Installations of the ProviderApp. */
  readonly installationId?: string;
  readonly principal: ExecutionPrincipalRequest;
  /**
   * The Session creator. Without it the requester counts as another
   * participant, which needs `participantsAsPrincipal`.
   */
  readonly sessionCreatorId?: string;
  readonly access: "read" | "write";
  readonly operation?: string;
  /** Resource address for the audit fact, such as a project path. */
  readonly resource?: string;
}

export interface ReplaceInstallationCredentialInput {
  readonly tenantId: string;
  readonly installationId: string;
  readonly token: string;
  readonly expiresAt?: string;
  readonly actor: string;
}

const randomId = () => globalThis.crypto.randomUUID();
const ms = (iso: string) => Date.parse(iso);

export const makeBond = (options: BondOptions) => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const leaseOwner = options.leaseOwner ?? `bond-${randomId()}`;
  const refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const leaseRetryMs = options.leaseRetryMs ?? 100;
  const leaseAttempts = options.leaseAttempts ?? 50;
  const patWarningMs = options.patWarningMs ?? 7 * 24 * 60 * 60_000;
  const { store, cipher } = options;
  const appTokenCache = new Map<
    string,
    { readonly token: string; readonly expiresAt?: string }
  >();

  const fromStore = <A>(effect: Effect.Effect<A, { message: string }>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        bondError("store", cause.message, { retryable: true, cause }),
      ),
    );
  const fromCipher = <A>(effect: Effect.Effect<A, { message: string }>) =>
    effect.pipe(
      Effect.mapError((cause) => bondError("cipher", cause.message, { cause })),
    );
  const fromProvider = <A>(effect: Effect.Effect<A, ProviderError>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        bondError("provider", cause.message, {
          retryable: !cause.rejected,
          cause,
        }),
      ),
    );

  const config = (tenantId: string, providerAppId: string) =>
    options.providerApps
      .get({ tenantId, providerAppId })
      .pipe(
        Effect.mapError((cause) =>
          bondError("config", cause.message, { cause }),
        ),
      );

  const provider = (cfg: ProviderAppConfig) => {
    const found = options.providers[cfg.provider];
    return found === undefined
      ? Effect.fail(
          bondError(
            "provider_not_registered",
            `No ${cfg.provider} provider is registered with Bond`,
          ),
        )
      : Effect.succeed(found);
  };

  const seal = (value: string, purpose: string) =>
    fromCipher(cipher.seal(value, purpose));
  const open = (value: Sealed, purpose: string) =>
    fromCipher(cipher.open(value, purpose));

  /** Best-effort provider revocation; the tombstone is written regardless. */
  const revokeAtProvider = (cfg: ProviderAppConfig, link: UserLink) =>
    Effect.gen(function* () {
      const p = yield* provider(cfg);
      const accessToken = yield* open(link.access, SealPurpose.userAccess);
      const refreshToken =
        link.refresh === undefined
          ? undefined
          : yield* open(link.refresh, SealPurpose.userRefresh);
      yield* p.revokeUserToken(cfg, {
        method: link.method,
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
      });
      return true as const;
    }).pipe(Effect.catchAll(() => Effect.succeed(false as const)));

  const tombstone = (link: UserLink, actor: string, reason: string) =>
    fromStore(
      store.revokeUserLink({
        tenantId: link.tenantId,
        linkId: link.id,
        tombstone: { at: clock(), actor, reason },
      }),
    );

  const linkHealth = (link: UserLink, now = clock()): LinkHealth => {
    if (link.status !== "active") return "inactive";
    if (link.accessExpiresAt === undefined) return "ok";
    const remaining = ms(link.accessExpiresAt) - ms(now);
    if (link.method === "pat") {
      if (remaining <= 0) return "expired";
      return remaining <= patWarningMs ? "expiring" : "ok";
    }
    // OAuth: an expired access token is refreshable, so it is not `expired`.
    return remaining <= refreshSkewMs ? "expiring" : "ok";
  };

  const link = (input: LinkInput) =>
    Effect.gen(function* () {
      const cfg = yield* config(input.tenantId, input.providerAppId);
      if (!allowedLinkMethods(cfg.linkMethodPolicy).includes(input.method)) {
        return yield* Effect.fail(
          bondError(
            "method_disallowed",
            `${cfg.id} does not allow linking by ${input.method}`,
          ),
        );
      }
      if (input.grant.scopes === undefined) {
        return yield* Effect.fail(
          bondError(
            "scope_not_allowed",
            "The provider did not report the granted scopes",
          ),
        );
      }
      const scopes = input.grant.scopes;
      const extra = scopes.filter((s) => !cfg.allowedScopes.includes(s));
      if (extra.length > 0) {
        return yield* Effect.fail(
          bondError(
            "scope_not_allowed",
            `Scopes outside the allowed set: ${extra.join(", ")}`,
          ),
        );
      }
      if (input.method === "pat") {
        const max = (cfg.maxPatLifetimeDays ?? 90) * 24 * 60 * 60_000;
        const expiresAt = input.grant.accessExpiresAt;
        if (
          expiresAt === undefined ||
          ms(expiresAt) - ms(clock()) > max ||
          ms(expiresAt) <= ms(clock())
        ) {
          return yield* Effect.fail(
            bondError(
              "pat_lifetime_exceeded",
              `A personal access token must expire within ${cfg.maxPatLifetimeDays ?? 90} days`,
            ),
          );
        }
      }
      if (cfg.identityBinding.kind === "sso_extern_uid") {
        const { ssoProvider } = cfg.identityBinding;
        const identity = input.providerUser.identities?.find(
          (i) => i.provider === ssoProvider,
        );
        if (
          input.ssoSubject === undefined ||
          identity === undefined ||
          identity.externUid !== input.ssoSubject
        ) {
          return yield* Effect.fail(
            bondError(
              "identity_mismatch",
              `The ${cfg.provider} account is not bound to this user's ${ssoProvider} identity`,
            ),
          );
        }
      }

      const holder = yield* fromStore(
        store.findUserLinkByProviderUser({
          tenantId: input.tenantId,
          providerAppId: cfg.id,
          providerUserId: input.providerUser.id,
        }),
      );
      if (holder !== undefined && holder.appUserId !== input.appUserId) {
        return yield* Effect.fail(
          bondError(
            "provider_user_linked_elsewhere",
            `This ${cfg.provider} account is already linked by another user`,
          ),
        );
      }

      // Rule 3: one active link per (tenant, user, ProviderApp). The new link
      // is persisted first, so a failure leaves the previous one intact. The
      // same provider account is updated in place; a different one replaces
      // the previous link, which is then retired.
      const previous = yield* fromStore(
        store.findUserLink({
          tenantId: input.tenantId,
          appUserId: input.appUserId,
          providerAppId: cfg.id,
        }),
      );

      const access = yield* seal(
        input.grant.accessToken,
        SealPurpose.userAccess,
      );
      const refresh =
        input.grant.refreshToken === undefined
          ? undefined
          : yield* seal(input.grant.refreshToken, SealPurpose.userRefresh);
      const result = yield* fromStore(
        store.upsertUserLink({
          tenantId: input.tenantId,
          appUserId: input.appUserId,
          providerAppId: cfg.id,
          providerUserId: input.providerUser.id,
          login: input.providerUser.login,
          method: input.method,
          access,
          ...(refresh === undefined ? {} : { refresh }),
          ...(input.grant.accessExpiresAt === undefined
            ? {}
            : { accessExpiresAt: input.grant.accessExpiresAt }),
          scopes,
        }),
      );
      if (result === "provider_user_taken") {
        return yield* Effect.fail(
          bondError(
            "provider_user_linked_elsewhere",
            `This ${cfg.provider} account is already linked by another user`,
          ),
        );
      }
      if (previous !== undefined) {
        if (previous.id !== result.id) {
          yield* tombstone(previous, input.actor, "relinked");
        }
        // Pasting the same token again must not revoke the token just stored.
        const previousAccess = yield* open(
          previous.access,
          SealPurpose.userAccess,
        );
        if (previousAccess !== input.grant.accessToken) {
          yield* revokeAtProvider(cfg, previous);
        }
      }
      return result;
    });

  const unlink = (q: {
    readonly tenantId: string;
    readonly linkId: string;
    readonly actor: string;
    readonly reason: string;
  }) =>
    Effect.gen(function* () {
      const found = yield* fromStore(store.getUserLink(q));
      if (found === undefined) {
        return yield* Effect.fail(bondError("not_found", "No such link"));
      }
      if (found.status === "revoked") return { providerRevoked: false };
      const cfg = yield* config(q.tenantId, found.providerAppId);
      const providerRevoked = yield* revokeAtProvider(cfg, found);
      yield* tombstone(found, q.actor, q.reason);
      return { providerRevoked };
    });

  /** Rule 4: narrowing the policy disables and revokes links of removed methods. */
  const narrowLinkMethods = (q: {
    readonly tenantId: string;
    readonly providerAppId: string;
  }) =>
    Effect.gen(function* () {
      const cfg = yield* config(q.tenantId, q.providerAppId);
      const allowed = allowedLinkMethods(cfg.linkMethodPolicy);
      const links = yield* fromStore(
        store.listUserLinks({ ...q, status: "active" }),
      );
      let changed = 0;
      for (const l of links) {
        if (allowed.includes(l.method)) continue;
        yield* revokeAtProvider(cfg, l);
        yield* fromStore(
          store.updateUserLinkStatus({
            tenantId: l.tenantId,
            linkId: l.id,
            status: "method_disallowed",
            reason: `link method ${l.method} is no longer allowed`,
          }),
        );
        changed++;
      }
      return changed;
    });

  const claimInstallation = (input: ClaimInstallationInput) =>
    Effect.gen(function* () {
      const cfg = yield* config(input.tenantId, input.providerAppId);
      const credential =
        input.credential === undefined
          ? undefined
          : yield* seal(
              input.credential.token,
              SealPurpose.installationCredential,
            );
      const installation: Installation = {
        id: randomId(),
        tenantId: input.tenantId,
        providerAppId: cfg.id,
        providerInstallationId: input.providerInstallationId,
        ...(input.accountLogin === undefined
          ? {}
          : { accountLogin: input.accountLogin }),
        status: "active",
        claimedBy: input.actor,
        claimedAt: clock(),
        ...(credential === undefined ? {} : { credential }),
        ...(input.credential?.expiresAt === undefined
          ? {}
          : { credentialExpiresAt: input.credential.expiresAt }),
      };
      const result = yield* fromStore(store.claimInstallation(installation));
      if (result === "owned_elsewhere") {
        return yield* Effect.fail(
          bondError(
            "installation_owned_elsewhere",
            "This installation belongs to another tenant; it must be released there first",
          ),
        );
      }
      if (result === "already_owned" && credential !== undefined) {
        // Re-registering a rotated bot token replaces the stored one.
        const owned = (yield* fromStore(
          store.listInstallations({
            tenantId: input.tenantId,
            providerAppId: cfg.id,
          }),
        )).find(
          (i) =>
            i.providerInstallationId === input.providerInstallationId &&
            i.status === "active",
        );
        if (owned !== undefined) {
          yield* fromStore(
            store.updateInstallationCredential({
              tenantId: input.tenantId,
              installationId: owned.id,
              credential,
              ...(input.credential?.expiresAt === undefined
                ? {}
                : { credentialExpiresAt: input.credential.expiresAt }),
            }),
          );
          appTokenCache.delete(owned.id);
        }
      }
      return result;
    });

  /** Replaces an Installation's stored credential and drops the cached token. */
  const replaceInstallationCredential = (
    input: ReplaceInstallationCredentialInput,
  ) =>
    Effect.gen(function* () {
      const credential = yield* seal(
        input.token,
        SealPurpose.installationCredential,
      );
      const result = yield* fromStore(
        store.updateInstallationCredential({
          tenantId: input.tenantId,
          installationId: input.installationId,
          credential,
          ...(input.expiresAt === undefined
            ? {}
            : { credentialExpiresAt: input.expiresAt }),
        }),
      );
      appTokenCache.delete(input.installationId);
      if (result === "not_found") {
        return yield* Effect.fail(
          bondError("not_found", "No such active installation"),
        );
      }
    });

  const releaseInstallation = (q: {
    readonly tenantId: string;
    readonly installationId: string;
    readonly actor: string;
  }) =>
    fromStore(store.releaseInstallation(q)).pipe(
      Effect.tap(() =>
        Effect.sync(() => appTokenCache.delete(q.installationId)),
      ),
    );

  const activeInstallation = (
    tenantId: string,
    cfg: ProviderAppConfig,
    installationId: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (installationId !== undefined) {
        const found = yield* fromStore(
          store.getInstallation({ tenantId, installationId }),
        );
        return found !== undefined &&
          found.providerAppId === cfg.id &&
          found.status === "active"
          ? found
          : undefined;
      }
      const active = (yield* fromStore(
        store.listInstallations({ tenantId, providerAppId: cfg.id }),
      )).filter((i) => i.status === "active");
      if (active.length > 1) {
        return yield* Effect.fail(
          bondError(
            "installation_required",
            `The tenant has ${active.length} installations of ${cfg.id}; name one`,
          ),
        );
      }
      return active[0];
    });

  /** Reads the requester's link and settles PAT expiry and method policy. */
  const linkState = (
    tenantId: string,
    cfg: ProviderAppConfig,
    requesterId: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (requesterId === undefined)
        return { usable: false, reason: "no_link" } as LinkState;
      const found = yield* fromStore(
        store.findUserLink({
          tenantId,
          appUserId: requesterId,
          providerAppId: cfg.id,
        }),
      );
      if (found === undefined) {
        // Report why the last link stopped working, so the user re-links
        // knowingly. An explicit unlink (revoked) reads as no link.
        const history = yield* fromStore(
          store.listUserLinks({ tenantId, providerAppId: cfg.id }),
        );
        const last = history
          .filter((l) => l.appUserId === requesterId)
          .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))[0];
        return (
          last !== undefined &&
          (last.status === "refresh_failed" ||
            last.status === "expired" ||
            last.status === "method_disallowed")
            ? { usable: false, reason: last.status }
            : { usable: false, reason: "no_link" }
        ) as LinkState;
      }
      if (!allowedLinkMethods(cfg.linkMethodPolicy).includes(found.method)) {
        yield* revokeAtProvider(cfg, found);
        yield* fromStore(
          store.updateUserLinkStatus({
            tenantId,
            linkId: found.id,
            status: "method_disallowed",
            reason: `link method ${found.method} is no longer allowed`,
          }),
        );
        return { usable: false, reason: "method_disallowed" } as LinkState;
      }
      if (linkHealth(found) === "expired") {
        yield* fromStore(
          store.updateUserLinkStatus({
            tenantId,
            linkId: found.id,
            status: "expired",
            reason: "personal access token expired",
          }),
        );
        return { usable: false, reason: "expired" } as LinkState;
      }
      return { usable: true, link: found } as LinkState;
    });

  const resolvePrincipal = (
    input: CredentialInput,
    seen: { policy?: PrincipalPolicy } = {},
  ) =>
    Effect.gen(function* () {
      const cfg = yield* config(input.tenantId, input.providerAppId);
      seen.policy = cfg.principalPolicy;
      const p = yield* provider(cfg);
      const installation = yield* activeInstallation(
        input.tenantId,
        cfg,
        input.installationId,
      );
      const state: LinkState =
        input.principal.runAs === "requester" &&
        input.principal.trigger === "attended"
          ? yield* linkState(input.tenantId, cfg, input.principal.requesterId)
          : { usable: false, reason: "no_link" };
      const selected = selectPrincipal({
        config: cfg,
        installation,
        link: state,
        request: input.principal,
        ...(input.sessionCreatorId === undefined
          ? {}
          : { sessionCreatorId: input.sessionCreatorId }),
        access: input.access,
        delegationMarker: p.delegationMarker,
      });
      if (Either.isLeft(selected)) return yield* Effect.fail(selected.left);
      return {
        cfg,
        provider: p,
        installation,
        state,
        resolution: selected.right,
      };
    });

  /** Single-flight refresh under the store lease. */
  const freshUserToken = (
    cfg: ProviderAppConfig,
    start: UserLink,
    force = false,
  ) =>
    Effect.gen(function* () {
      const p = yield* provider(cfg);
      let current = start;
      // A rotation by another caller since we started is fresh enough, even
      // when the refresh skew exceeds the token lifetime. Refreshing again
      // would invalidate the token that caller just handed out.
      const rotatedByOther = (l: UserLink) =>
        l.status === "active" &&
        l.revision !== start.revision &&
        (l.accessExpiresAt === undefined ||
          ms(l.accessExpiresAt) > ms(clock()));
      for (let attempt = 0; attempt < leaseAttempts; attempt++) {
        if (current.status !== "active") {
          return yield* Effect.fail(
            bondError(
              current.status === "revoked"
                ? "revoked"
                : current.status === "expired"
                  ? "expired"
                  : current.status === "method_disallowed"
                    ? "method_disallowed"
                    : "refresh_failed",
              `The linked account is ${current.status}`,
            ),
          );
        }
        const forced = force && current.revision === start.revision;
        if (
          current.method === "pat" ||
          (!forced && linkHealth(current) === "ok")
        ) {
          return current;
        }
        if (current.refresh === undefined) {
          return yield* Effect.fail(
            bondError("refresh_failed", "The link has no refresh token"),
          );
        }
        const lease = yield* fromStore(
          store.acquireRefreshLease({
            tenantId: current.tenantId,
            linkId: current.id,
            owner: leaseOwner,
            ttlMs: leaseTtlMs,
          }),
        );
        if (lease === "held" || lease === "not_active") {
          if (lease === "held")
            yield* Effect.sleep(Duration.millis(leaseRetryMs));
          const reread = yield* fromStore(
            store.getUserLink({
              tenantId: current.tenantId,
              linkId: current.id,
            }),
          );
          if (reread === undefined) {
            return yield* Effect.fail(bondError("not_found", "No such link"));
          }
          current = reread;
          if (rotatedByOther(current)) return current;
          continue;
        }
        // Another caller may have refreshed between our read and the lease.
        const latest = yield* fromStore(
          store.getUserLink({ tenantId: current.tenantId, linkId: current.id }),
        );
        if (
          latest !== undefined &&
          (rotatedByOther(latest) ||
            (!forced &&
              latest.revision !== current.revision &&
              linkHealth(latest) === "ok"))
        ) {
          yield* fromStore(
            store.releaseRefreshLease({
              tenantId: current.tenantId,
              linkId: current.id,
              lease,
            }),
          );
          return latest;
        }
        const refreshToken = yield* open(
          current.refresh,
          SealPurpose.userRefresh,
        );
        const grant = yield* p.refreshUserToken(cfg, refreshToken).pipe(
          Effect.catchAll((cause) =>
            Effect.gen(function* () {
              if (cause.rejected) {
                // Rule 2 of link methods: a failed refresh never becomes a
                // token prompt. The link ends and the user re-links.
                yield* fromStore(
                  store.updateUserLinkStatus({
                    tenantId: current.tenantId,
                    linkId: current.id,
                    status: "refresh_failed",
                    // Never the provider's message: it is not ours to store.
                    reason: `the provider rejected the refresh${cause.status === undefined ? "" : ` (HTTP ${cause.status})`}`,
                  }),
                );
              }
              yield* fromStore(
                store.releaseRefreshLease({
                  tenantId: current.tenantId,
                  linkId: current.id,
                  lease,
                }),
              );
              return yield* Effect.fail(
                bondError(
                  cause.rejected ? "refresh_failed" : "provider",
                  cause.message,
                  { retryable: !cause.rejected, cause },
                ),
              );
            }),
          ),
        );
        const access = yield* seal(grant.accessToken, SealPurpose.userAccess);
        const refresh =
          grant.refreshToken === undefined
            ? undefined
            : yield* seal(grant.refreshToken, SealPurpose.userRefresh);
        const committed = yield* fromStore(
          store.commitRefresh({
            tenantId: current.tenantId,
            linkId: current.id,
            lease,
            tokens: {
              access,
              ...(refresh === undefined ? {} : { refresh }),
              ...(grant.accessExpiresAt === undefined
                ? {}
                : { accessExpiresAt: grant.accessExpiresAt }),
              ...(grant.scopes === undefined ? {} : { scopes: grant.scopes }),
            },
          }),
        );
        if (committed === "revoked") {
          // A late refresh must not resurrect a revoked link.
          yield* fromProvider(
            p.revokeUserToken(cfg, {
              method: "oauth",
              accessToken: grant.accessToken,
              ...(grant.refreshToken === undefined
                ? {}
                : { refreshToken: grant.refreshToken }),
            }),
          ).pipe(Effect.ignore);
          return yield* Effect.fail(
            bondError("revoked", "The link was revoked"),
          );
        }
        const reread = yield* fromStore(
          store.getUserLink({ tenantId: current.tenantId, linkId: current.id }),
        );
        if (reread === undefined) {
          return yield* Effect.fail(bondError("not_found", "No such link"));
        }
        current = reread;
        if (committed === "committed") return current;
      }
      return yield* Effect.fail(
        bondError("refresh_failed", "Timed out waiting for a refresh lease", {
          retryable: true,
        }),
      );
    });

  const appToken = (
    cfg: ProviderAppConfig,
    p: BondProvider,
    installation: Installation,
  ) =>
    Effect.gen(function* () {
      const cached = appTokenCache.get(installation.id);
      if (
        cached !== undefined &&
        (cached.expiresAt === undefined ||
          ms(cached.expiresAt) - ms(clock()) > refreshSkewMs)
      ) {
        return cached;
      }
      if (
        installation.credentialExpiresAt !== undefined &&
        ms(installation.credentialExpiresAt) <= ms(clock())
      ) {
        return yield* Effect.fail(
          bondError(
            "app_not_configured",
            `The app credential for ${cfg.id} has expired`,
          ),
        );
      }
      const stored =
        installation.credential === undefined
          ? undefined
          : yield* open(
              installation.credential,
              SealPurpose.installationCredential,
            );
      const minted = yield* fromProvider(
        p.appCredential(cfg, installation, stored),
      );
      appTokenCache.set(installation.id, minted);
      return minted;
    });

  const resolveCredential = (
    input: CredentialInput,
    seen: { policy?: PrincipalPolicy },
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolvePrincipal(input, seen);
      const { cfg, provider: p, installation } = resolved;
      let { resolution } = resolved;

      const appCredential = (r: PrincipalResolution) =>
        Effect.gen(function* () {
          if (installation === undefined || r.principal.kind !== "app") {
            return yield* Effect.fail(
              bondError("app_not_configured", `${cfg.id} has no app principal`),
            );
          }
          const minted = yield* appToken(cfg, p, installation);
          const result: BondCredential = {
            token: minted.token,
            principal: r.principal,
            ...(minted.expiresAt === undefined
              ? {}
              : { expiresAt: minted.expiresAt }),
          };
          return result;
        });

      if (resolution.principal.kind === "app") {
        return { credential: yield* appCredential(resolution), resolution };
      }
      const { state } = resolved;
      if (!state.usable) {
        return yield* Effect.fail(bondError("link_required", "No usable link"));
      }
      const fresh = yield* Effect.either(freshUserToken(cfg, state.link));
      if (Either.isLeft(fresh)) {
        const e = fresh.left;
        const ended =
          !e.retryable &&
          (e.reason === "refresh_failed" ||
            e.reason === "revoked" ||
            e.reason === "expired" ||
            e.reason === "method_disallowed");
        if (!ended) return yield* Effect.fail(e);
        // Rule 1: the link ended during this call. Re-select with the link's
        // state, which falls back to the app principal only under `user`.
        const reselected = selectPrincipal({
          config: cfg,
          installation,
          link: {
            usable: false,
            reason: e.reason as
              "refresh_failed" | "revoked" | "expired" | "method_disallowed",
          },
          request: input.principal,
          ...(input.sessionCreatorId === undefined
            ? {}
            : { sessionCreatorId: input.sessionCreatorId }),
          access: input.access,
          delegationMarker: p.delegationMarker,
        });
        if (
          Either.isLeft(reselected) ||
          reselected.right.principal.kind !== "app"
        ) {
          return yield* Effect.fail(e);
        }
        resolution = reselected.right;
        return { credential: yield* appCredential(resolution), resolution };
      }
      const token = yield* open(fresh.right.access, SealPurpose.userAccess);
      const result: BondCredential = {
        token,
        principal: resolution.principal,
        method: fresh.right.method,
        ...(fresh.right.accessExpiresAt === undefined
          ? {}
          : { expiresAt: fresh.right.accessExpiresAt }),
      };
      return { credential: result, resolution };
    });

  const auditFact = (
    input: CredentialInput,
    outcome:
      | {
          readonly granted: true;
          readonly credential: BondCredential;
          readonly resolution: PrincipalResolution;
        }
      | {
          readonly granted: false;
          readonly error: BondError;
          readonly policy?: PrincipalPolicy;
        },
  ): AuditFact => ({
    at: clock(),
    outcome: outcome.granted ? "granted" : "denied",
    ...(outcome.granted ? {} : { denial: outcome.error.reason }),
    tenantId: input.tenantId,
    providerAppId: input.providerAppId,
    ...(input.principal.requesterId === undefined
      ? {}
      : { requestingActor: input.principal.requesterId }),
    trigger: input.principal.trigger,
    ...(outcome.granted
      ? {
          executionPrincipal: outcome.credential.principal,
          ...(outcome.credential.method === undefined
            ? {}
            : { method: outcome.credential.method }),
          policy: outcome.resolution.policy,
        }
      : outcome.policy === undefined
        ? {}
        : { policy: outcome.policy }),
    fallback: outcome.granted ? outcome.resolution.fallback : false,
    access: input.access,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.resource === undefined ? {} : { resource: input.resource }),
  });

  /** Resolves a credential and audits the outcome, granted or denied. */
  const credential = (input: CredentialInput) =>
    Effect.suspend(() => {
      const seen: { policy?: PrincipalPolicy } = {};
      const sink = options.audit;
      return resolveCredential(input, seen).pipe(
        Effect.tap((r) =>
          sink === undefined
            ? Effect.void
            : sink(auditFact(input, { granted: true, ...r })),
        ),
        Effect.tapError((error) =>
          sink === undefined
            ? Effect.void
            : sink(
                auditFact(input, {
                  granted: false,
                  error,
                  ...(seen.policy === undefined ? {} : { policy: seen.policy }),
                }),
              ),
        ),
      );
    });

  /**
   * The application saw the provider reject a token Bond handed out. A
   * personal access token ends as `expired`. An OAuth link is refreshed under
   * the lease at once; a rejected refresh ends it as `refresh_failed`.
   */
  const reportRejected = (q: {
    readonly tenantId: string;
    readonly linkId: string;
  }) =>
    Effect.gen(function* () {
      const found = yield* fromStore(store.getUserLink(q));
      if (found === undefined) {
        return yield* Effect.fail(bondError("not_found", "No such link"));
      }
      if (found.status !== "active") return found.status;
      if (found.method === "pat") {
        yield* fromStore(
          store.updateUserLinkStatus({
            tenantId: q.tenantId,
            linkId: found.id,
            status: "expired",
            reason: "the provider rejected the personal access token",
          }),
        );
        return "expired" as const;
      }
      const cfg = yield* config(q.tenantId, found.providerAppId);
      yield* freshUserToken(cfg, found, true);
      return "active" as const;
    });

  /**
   * Adapts Bond to the CredentialResolver port used by Work Integrations. The
   * application maps each request to a ProviderApp and optional Installation.
   */
  const credentialResolver = (
    map: (request: CredentialRequest) => {
      readonly providerAppId: string;
      readonly installationId?: string;
      readonly access: "read" | "write";
      readonly sessionCreatorId?: string;
      readonly operation?: string;
      readonly resource?: string;
    },
  ): CredentialResolver<BondCredential> => ({
    resolve: (request) =>
      Effect.suspend(() => {
        // Fail closed: Bond never guesses who an operation runs as.
        if (request.principal === undefined) {
          return Effect.fail(
            new CredentialError({
              message: "Bond requires an execution principal on the request",
              integrationId: request.integrationId,
              authority: request.authority,
              retryable: false,
            }),
          );
        }
        const target = map(request);
        return credential({
          tenantId: request.principal.tenantId,
          principal: request.principal,
          ...target,
        }).pipe(
          Effect.map((r) => r.credential),
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: cause.message,
                integrationId: request.integrationId,
                authority: request.authority,
                retryable: cause.retryable,
                cause,
              }),
          ),
        );
      }),
  });

  return {
    link,
    unlink,
    narrowLinkMethods,
    claimInstallation,
    replaceInstallationCredential,
    releaseInstallation,
    reportRejected,
    resolvePrincipal: (input: CredentialInput) =>
      resolvePrincipal(input).pipe(
        Effect.map((r): PrincipalResolution => r.resolution),
      ),
    credential,
    credentialResolver,
    linkHealth,
  };
};

export type Bond = ReturnType<typeof makeBond>;

export { BondError };
