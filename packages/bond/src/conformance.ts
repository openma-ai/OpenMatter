import { Effect } from "effect";
import type { BondStore } from "./ports.js";
import type {
  Installation,
  RefreshLease,
  Sealed,
  UserLinkWrite,
} from "./types.js";

/**
 * One conformance case. Framework-neutral: run each `run()` inside your test
 * runner. A case throws on failure.
 */
export interface BondStoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface BondStoreConformanceOptions {
  /** Returns a fresh, empty store for each case. */
  readonly makeStore: () => BondStore | Promise<BondStore>;
  /** Lease lifetime used by expiry cases. The suite waits slightly longer. Default 40 ms. */
  readonly shortLeaseMs?: number;
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`BondStore conformance: ${message}`);
};
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sealed = (ciphertext: string, keyId = "k1"): Sealed => ({
  keyId,
  ciphertext,
});

const write = (over: Partial<UserLinkWrite> = {}): UserLinkWrite => ({
  tenantId: "t1",
  appUserId: "u1",
  providerAppId: "app1",
  providerUserId: "p1",
  login: "alice",
  method: "oauth",
  access: sealed("a1"),
  refresh: sealed("r1"),
  accessExpiresAt: "2030-01-01T00:00:00.000Z",
  scopes: ["read_user"],
  ...over,
});

const installation = (over: Partial<Installation> = {}): Installation => ({
  id: globalThis.crypto.randomUUID(),
  tenantId: "t1",
  providerAppId: "app1",
  providerInstallationId: "inst-1",
  status: "active",
  claimedBy: "u1",
  claimedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const linkOf = async (store: BondStore, value: UserLinkWrite) => {
  const result = await run(store.upsertUserLink(value));
  assert(result !== "provider_user_taken", "upsert of a fresh link succeeds");
  if (result === "provider_user_taken") throw new Error("unreachable");
  return result;
};

/**
 * The invariants from docs/BONDS.md as executable cases. Applications run
 * them against their real adapter and database.
 */
export const bondStoreConformanceCases = (
  options: BondStoreConformanceOptions,
): readonly BondStoreConformanceCase[] => {
  const shortLeaseMs = options.shortLeaseMs ?? 40;
  const fresh = async () => options.makeStore();

  return [
    {
      name: "upsert is idempotent by provider user while the link is active",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        const b = await linkOf(store, write({ access: sealed("a2") }));
        assert(a.id === b.id, "same link id on re-upsert");
        assert(b.revision > a.revision, "revision increases");
        assert(b.access.ciphertext === "a2", "tokens are replaced");
      },
    },
    {
      name: "ciphertext and key id are stored and returned together",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(
          store,
          write({
            access: sealed("x", "k-old"),
            refresh: sealed("y", "k-new"),
          }),
        );
        const read = await run(
          store.getUserLink({ tenantId: "t1", linkId: a.id }),
        );
        assert(read?.access.keyId === "k-old", "access key id round-trips");
        assert(read?.refresh?.keyId === "k-new", "refresh key id round-trips");
      },
    },
    {
      name: "reads are tenant-scoped",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        const inst = installation();
        await run(store.claimInstallation(inst));
        assert(
          (await run(store.getUserLink({ tenantId: "t2", linkId: a.id }))) ===
            undefined,
          "getUserLink never crosses tenants",
        );
        assert(
          (await run(
            store.findUserLink({
              tenantId: "t2",
              appUserId: "u1",
              providerAppId: "app1",
            }),
          )) === undefined,
          "findUserLink never crosses tenants",
        );
        assert(
          (await run(
            store.getInstallation({ tenantId: "t2", installationId: inst.id }),
          )) === undefined,
          "getInstallation never crosses tenants",
        );
        assert(
          (
            await run(
              store.listUserLinks({ tenantId: "t2", providerAppId: "app1" }),
            )
          ).length === 0,
          "listUserLinks never crosses tenants",
        );
      },
    },
    {
      name: "a provider user held by another application user is refused",
      run: async () => {
        const store = await fresh();
        await linkOf(store, write());
        const result = await run(
          store.upsertUserLink(write({ appUserId: "u2" })),
        );
        assert(result === "provider_user_taken", "second user is refused");
      },
    },
    {
      name: "only one parallel caller acquires the refresh lease",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            run(
              store.acquireRefreshLease({
                tenantId: "t1",
                linkId: a.id,
                owner: `o${i}`,
                ttlMs: 10_000,
              }),
            ),
          ),
        );
        const won = results.filter((r) => typeof r === "object");
        assert(won.length === 1, `exactly one lease, got ${won.length}`);
        assert(
          results.filter((r) => r === "held").length === 7,
          "the others see held",
        );
      },
    },
    {
      name: "commit succeeds only with the current lease",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        const first = await run(
          store.acquireRefreshLease({
            tenantId: "t1",
            linkId: a.id,
            owner: "o1",
            ttlMs: shortLeaseMs,
          }),
        );
        assert(typeof first === "object", "first lease acquired");
        await sleep(shortLeaseMs * 2);
        const second = await run(
          store.acquireRefreshLease({
            tenantId: "t1",
            linkId: a.id,
            owner: "o2",
            ttlMs: 10_000,
          }),
        );
        assert(typeof second === "object", "expired lease can be taken over");
        const stale = await run(
          store.commitRefresh({
            tenantId: "t1",
            linkId: a.id,
            lease: first as RefreshLease,
            tokens: { access: sealed("stale") },
          }),
        );
        assert(stale === "stale_lease", "stale lease cannot commit");
        const ok = await run(
          store.commitRefresh({
            tenantId: "t1",
            linkId: a.id,
            lease: second as RefreshLease,
            tokens: { access: sealed("a2"), refresh: sealed("r2") },
          }),
        );
        assert(ok === "committed", "current lease commits");
        const read = await run(
          store.getUserLink({ tenantId: "t1", linkId: a.id }),
        );
        assert(
          read?.access.ciphertext === "a2",
          "committed tokens are visible",
        );
        assert(read?.refresh?.ciphertext === "r2", "refresh token rotated");
      },
    },
    {
      name: "a revoked link stays revoked and is never resurrected",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        const lease = await run(
          store.acquireRefreshLease({
            tenantId: "t1",
            linkId: a.id,
            owner: "o1",
            ttlMs: 10_000,
          }),
        );
        assert(typeof lease === "object", "lease acquired");
        await run(
          store.revokeUserLink({
            tenantId: "t1",
            linkId: a.id,
            tombstone: {
              at: "2026-01-01T00:00:00.000Z",
              actor: "u1",
              reason: "unlink",
            },
          }),
        );
        const late = await run(
          store.commitRefresh({
            tenantId: "t1",
            linkId: a.id,
            lease: lease as RefreshLease,
            tokens: { access: sealed("late") },
          }),
        );
        assert(late === "revoked", "commit after revoke is refused");
        await run(
          store.updateUserLinkStatus({
            tenantId: "t1",
            linkId: a.id,
            status: "refresh_failed",
            reason: "x",
          }),
        );
        const read = await run(
          store.getUserLink({ tenantId: "t1", linkId: a.id }),
        );
        assert(
          read?.status === "revoked",
          "status change never leaves revoked",
        );
        assert(
          (await run(
            store.acquireRefreshLease({
              tenantId: "t1",
              linkId: a.id,
              owner: "o2",
              ttlMs: 10_000,
            }),
          )) === "not_active",
          "no lease on a revoked link",
        );
        const again = await linkOf(store, write());
        assert(again.id !== a.id, "relinking creates a new link id");
        assert(
          (
            await run(
              store.findUserLink({
                tenantId: "t1",
                appUserId: "u1",
                providerAppId: "app1",
              }),
            )
          )?.id === again.id,
          "findUserLink returns only the active link",
        );
      },
    },
    {
      name: "status changes are persisted and filterable",
      run: async () => {
        const store = await fresh();
        const a = await linkOf(store, write());
        await linkOf(store, write({ appUserId: "u2", providerUserId: "p2" }));
        await run(
          store.updateUserLinkStatus({
            tenantId: "t1",
            linkId: a.id,
            status: "method_disallowed",
            reason: "policy narrowed",
          }),
        );
        const read = await run(
          store.getUserLink({ tenantId: "t1", linkId: a.id }),
        );
        assert(read?.status === "method_disallowed", "status persisted");
        assert(read?.statusReason === "policy narrowed", "reason persisted");
        const active = await run(
          store.listUserLinks({
            tenantId: "t1",
            providerAppId: "app1",
            status: "active",
          }),
        );
        assert(
          active.length === 1 && active[0]?.appUserId === "u2",
          "filter by status",
        );
      },
    },
    {
      name: "an installation has exactly one owning tenant",
      run: async () => {
        const store = await fresh();
        const first = installation();
        assert(
          (await run(store.claimInstallation(first))) === "claimed",
          "first claim succeeds",
        );
        assert(
          (await run(store.claimInstallation(installation()))) ===
            "already_owned",
          "same tenant sees already_owned",
        );
        const other = installation({ tenantId: "t2" });
        assert(
          (await run(store.claimInstallation(other))) === "owned_elsewhere",
          "another tenant sees owned_elsewhere",
        );
        assert(
          (await run(
            store.getInstallation({ tenantId: "t2", installationId: other.id }),
          )) === undefined,
          "a refused claim changes nothing",
        );
        await run(
          store.releaseInstallation({
            tenantId: "t1",
            installationId: first.id,
            actor: "u1",
          }),
        );
        assert(
          (await run(
            store.claimInstallation(installation({ tenantId: "t2" })),
          )) === "claimed",
          "after release another tenant may claim",
        );
      },
    },
    {
      name: "one link serves two installations of the same ProviderApp",
      run: async () => {
        const store = await fresh();
        await run(
          store.claimInstallation(
            installation({ providerInstallationId: "i1" }),
          ),
        );
        await run(
          store.claimInstallation(
            installation({ providerInstallationId: "i2" }),
          ),
        );
        const a = await linkOf(store, write());
        const list = await run(
          store.listInstallations({ tenantId: "t1", providerAppId: "app1" }),
        );
        assert(list.length === 2, "both installations listed");
        assert(
          (
            await run(
              store.findUserLink({
                tenantId: "t1",
                appUserId: "u1",
                providerAppId: "app1",
              }),
            )
          )?.id === a.id,
          "the link is per ProviderApp, not per installation",
        );
      },
    },
    {
      name: "a pat link is stored without refresh material",
      run: async () => {
        const store = await fresh();
        const { refresh: _r, ...pat } = write({ method: "pat" });
        const a = await linkOf(store, pat);
        assert(a.method === "pat", "method recorded");
        assert(a.refresh === undefined, "no refresh token stored");
      },
    },
  ];
};
