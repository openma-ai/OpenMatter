import { Effect } from "effect";
import type { BondStore, ClaimResult, LeaseResult } from "./ports.js";
import type { Installation, RefreshLease, UserLink } from "./types.js";

/**
 * In-memory BondStore. **Test-only.** It satisfies the conformance suite but
 * offers no durability, no cross-process lease, and no encryption at rest.
 */
export const makeMemoryBondStore = (
  options: { readonly nowMs?: () => number } = {},
): BondStore => {
  const nowMs = options.nowMs ?? (() => Date.now());
  const iso = () => new Date(nowMs()).toISOString();
  const installations = new Map<string, Installation>();
  const links = new Map<string, UserLink>();
  const leases = new Map<string, RefreshLease>();
  const id = () => globalThis.crypto.randomUUID();

  const sameTenant = <T extends { readonly tenantId: string }>(
    value: T | undefined,
    tenantId: string,
  ) => (value !== undefined && value.tenantId === tenantId ? value : undefined);

  const activeLink = (pred: (l: UserLink) => boolean) =>
    [...links.values()].find((l) => l.status === "active" && pred(l));

  return {
    getInstallation: ({ tenantId, installationId }) =>
      Effect.sync(() =>
        sameTenant(installations.get(installationId), tenantId),
      ),
    listInstallations: ({ tenantId, providerAppId }) =>
      Effect.sync(() =>
        [...installations.values()].filter(
          (i) => i.tenantId === tenantId && i.providerAppId === providerAppId,
        ),
      ),
    claimInstallation: (value) =>
      Effect.sync((): ClaimResult => {
        const owner = [...installations.values()].find(
          (i) =>
            i.providerAppId === value.providerAppId &&
            i.providerInstallationId === value.providerInstallationId &&
            i.status !== "released",
        );
        if (owner === undefined) {
          installations.set(value.id, value);
          return "claimed";
        }
        return owner.tenantId === value.tenantId
          ? "already_owned"
          : "owned_elsewhere";
      }),
    releaseInstallation: ({ tenantId, installationId }) =>
      Effect.sync(() => {
        const found = sameTenant(installations.get(installationId), tenantId);
        if (found !== undefined) {
          installations.set(installationId, { ...found, status: "released" });
        }
      }),

    getUserLink: ({ tenantId, linkId }) =>
      Effect.sync(() => sameTenant(links.get(linkId), tenantId)),
    findUserLink: ({ tenantId, appUserId, providerAppId }) =>
      Effect.sync(() =>
        activeLink(
          (l) =>
            l.tenantId === tenantId &&
            l.appUserId === appUserId &&
            l.providerAppId === providerAppId,
        ),
      ),
    findUserLinkByProviderUser: ({ tenantId, providerAppId, providerUserId }) =>
      Effect.sync(() =>
        activeLink(
          (l) =>
            l.tenantId === tenantId &&
            l.providerAppId === providerAppId &&
            l.providerUserId === providerUserId,
        ),
      ),
    listUserLinks: ({ tenantId, providerAppId, status }) =>
      Effect.sync(() =>
        [...links.values()].filter(
          (l) =>
            l.tenantId === tenantId &&
            l.providerAppId === providerAppId &&
            (status === undefined || l.status === status),
        ),
      ),
    upsertUserLink: (value) =>
      Effect.sync(() => {
        const existing = activeLink(
          (l) =>
            l.tenantId === value.tenantId &&
            l.providerAppId === value.providerAppId &&
            l.providerUserId === value.providerUserId,
        );
        const now = iso();
        if (existing !== undefined) {
          if (existing.appUserId !== value.appUserId) {
            return "provider_user_taken" as const;
          }
          const { refresh: _r, accessExpiresAt: _e, ...rest } = existing;
          const updated: UserLink = {
            ...rest,
            ...value,
            status: "active",
            updatedAt: now,
            revision: existing.revision + 1,
          };
          links.set(existing.id, updated);
          return updated;
        }
        const created: UserLink = {
          ...value,
          id: id(),
          status: "active",
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        links.set(created.id, created);
        return created;
      }),
    updateUserLinkStatus: ({ tenantId, linkId, status, reason }) =>
      Effect.sync(() => {
        const found = sameTenant(links.get(linkId), tenantId);
        if (found === undefined || found.status === "revoked") return;
        links.set(linkId, {
          ...found,
          status,
          statusReason: reason,
          updatedAt: iso(),
          revision: found.revision + 1,
        });
      }),

    acquireRefreshLease: ({ tenantId, linkId, owner, ttlMs }) =>
      Effect.sync((): LeaseResult => {
        const found = sameTenant(links.get(linkId), tenantId);
        if (found === undefined || found.status !== "active") {
          return "not_active";
        }
        const held = leases.get(linkId);
        if (held !== undefined && Date.parse(held.expiresAt) > nowMs()) {
          return "held";
        }
        const lease: RefreshLease = {
          token: id(),
          owner,
          expiresAt: new Date(nowMs() + ttlMs).toISOString(),
        };
        leases.set(linkId, lease);
        return lease;
      }),
    commitRefresh: ({ tenantId, linkId, lease, tokens }) =>
      Effect.sync(() => {
        const found = sameTenant(links.get(linkId), tenantId);
        if (found === undefined || found.status === "revoked") {
          return "revoked" as const;
        }
        const held = leases.get(linkId);
        if (
          held === undefined ||
          held.token !== lease.token ||
          Date.parse(held.expiresAt) <= nowMs()
        ) {
          return "stale_lease" as const;
        }
        const { refresh: _r, accessExpiresAt: _e, ...rest } = found;
        links.set(linkId, {
          ...rest,
          access: tokens.access,
          ...(tokens.refresh === undefined ? {} : { refresh: tokens.refresh }),
          ...(tokens.accessExpiresAt === undefined
            ? {}
            : { accessExpiresAt: tokens.accessExpiresAt }),
          scopes: tokens.scopes ?? found.scopes,
          updatedAt: iso(),
          revision: found.revision + 1,
        });
        leases.delete(linkId);
        return "committed" as const;
      }),
    releaseRefreshLease: ({ tenantId, linkId, lease }) =>
      Effect.sync(() => {
        if (sameTenant(links.get(linkId), tenantId) === undefined) return;
        if (leases.get(linkId)?.token === lease.token) leases.delete(linkId);
      }),
    revokeUserLink: ({ tenantId, linkId, tombstone }) =>
      Effect.sync(() => {
        const found = sameTenant(links.get(linkId), tenantId);
        if (found === undefined || found.status === "revoked") return;
        links.set(linkId, {
          ...found,
          status: "revoked",
          statusReason: `${tombstone.reason} by ${tombstone.actor} at ${tombstone.at}`,
          updatedAt: tombstone.at,
          revision: found.revision + 1,
        });
        leases.delete(linkId);
      }),
  };
};
