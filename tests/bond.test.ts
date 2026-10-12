import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  BondError,
  ConfigError,
  ProviderError,
  bondStoreConformanceCases,
  makeBond,
  makeMemoryBondStore,
  selectPrincipal,
  type AuditFact,
  type BondProvider,
  type ProviderAppConfig,
  type SecretCipher,
  type TokenGrant,
} from "../packages/bond/src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fail = async <A>(effect: Effect.Effect<A, BondError>) => {
  const result = await run(Effect.either(effect));
  if (Either.isRight(result)) throw new Error("expected failure");
  return result.left;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const baseConfig: ProviderAppConfig = {
  id: "gl",
  provider: "gitlab",
  baseUrl: "https://gitlab.example.com",
  linkMethodPolicy: "oauth_preferred",
  principalPolicy: "user_only",
  allowedScopes: ["read_user", "read_api", "write_repository"],
  maxPatLifetimeDays: 90,
  identityBinding: { kind: "none" },
  allowUserPrincipalOutput: true,
};

/** Reversible test cipher that records purposes, so tests can assert sealing. */
const testCipher = (): SecretCipher & { purposes: string[] } => {
  const purposes: string[] = [];
  return {
    purposes,
    seal: (plaintext, purpose) =>
      Effect.sync(() => {
        purposes.push(purpose);
        return { keyId: "k1", ciphertext: `sealed:${purpose}:${plaintext}` };
      }),
    open: (sealed, purpose) =>
      Effect.sync(() => {
        const prefix = `sealed:${purpose}:`;
        if (!sealed.ciphertext.startsWith(prefix)) {
          throw new Error(`purpose mismatch for ${purpose}`);
        }
        return sealed.ciphertext.slice(prefix.length);
      }),
  };
};

interface FakeProvider extends BondProvider {
  refreshCalls: number;
  revoked: string[];
  nextGrant: (n: number) => TokenGrant;
  reject: boolean;
  delayMs: number;
}

const fakeProvider = (clock: () => number): FakeProvider => {
  const p: FakeProvider = {
    provider: "gitlab",
    delegationMarker: false,
    refreshCalls: 0,
    revoked: [],
    reject: false,
    delayMs: 0,
    nextGrant: (n) => ({
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      accessExpiresAt: new Date(clock() + 2 * HOUR).toISOString(),
    }),
    refreshUserToken: (_config, refreshToken) =>
      Effect.gen(function* () {
        p.refreshCalls++;
        const n = p.refreshCalls;
        if (p.delayMs > 0) yield* Effect.sleep(p.delayMs);
        if (p.reject) {
          return yield* Effect.fail(
            new ProviderError({ message: "invalid_grant", rejected: true }),
          );
        }
        expect(refreshToken.startsWith("refresh-")).toBe(true);
        return p.nextGrant(n);
      }),
    revokeUserToken: (_config, tokens) =>
      Effect.sync(() => {
        p.revoked.push(tokens.accessToken);
      }),
    appCredential: (_config, _installation, stored) =>
      stored === undefined
        ? Effect.fail(
            new ProviderError({
              message: "no stored credential",
              rejected: true,
            }),
          )
        : Effect.succeed({ token: stored }),
  };
  return p;
};

const setup = (over: Partial<ProviderAppConfig> = {}) => {
  let now = Date.parse("2026-10-12T00:00:00.000Z");
  const configs = new Map<string, ProviderAppConfig>([
    ["gl", { ...baseConfig, ...over }],
  ]);
  const store = makeMemoryBondStore({ nowMs: () => now });
  const cipher = testCipher();
  const provider = fakeProvider(() => now);
  const audit: AuditFact[] = [];
  const bond = makeBond({
    providerApps: {
      get: (id) => {
        const cfg = configs.get(id);
        return cfg === undefined
          ? Effect.fail(
              new ConfigError({ message: "unknown", providerAppId: id }),
            )
          : Effect.succeed(cfg);
      },
    },
    store,
    cipher,
    providers: { gitlab: provider },
    clock: () => new Date(now).toISOString(),
    leaseRetryMs: 1,
    audit: (fact) => Effect.sync(() => void audit.push(fact)),
  });
  return {
    bond,
    store,
    cipher,
    provider,
    audit,
    configs,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setConfig: (patch: Partial<ProviderAppConfig>) =>
      configs.set("gl", {
        ...(configs.get("gl") as ProviderAppConfig),
        ...patch,
      }),
  };
};

const oauthLink = (
  ctx: ReturnType<typeof setup>,
  over: {
    appUserId?: string;
    providerUserId?: string;
    expiresInMs?: number;
  } = {},
) =>
  ctx.bond.link({
    tenantId: "t1",
    appUserId: over.appUserId ?? "u1",
    providerAppId: "gl",
    method: "oauth",
    providerUser: { id: over.providerUserId ?? "42", login: "alice" },
    grant: {
      accessToken: "access-0",
      refreshToken: "refresh-0",
      accessExpiresAt: new Date(
        ctx.now() + (over.expiresInMs ?? 2 * HOUR),
      ).toISOString(),
      scopes: ["read_user", "write_repository"],
    },
    actor: over.appUserId ?? "u1",
  });

const attended = (requesterId = "u1") =>
  ({ tenantId: "t1", runAs: "requester", requesterId }) as const;

describe("BondStore conformance (memory adapter)", () => {
  for (const c of bondStoreConformanceCases({
    makeStore: () => makeMemoryBondStore(),
  })) {
    it(c.name, c.run);
  }
});

describe("selectPrincipal", () => {
  const installation = {
    id: "i1",
    tenantId: "t1",
    providerAppId: "gl",
    providerInstallationId: "bot-1",
    status: "active",
    claimedBy: "admin",
    claimedAt: "2026-01-01T00:00:00.000Z",
  } as const;
  const link = {
    usable: true,
    link: { id: "l1" },
  } as unknown as Parameters<typeof selectPrincipal>[0]["link"];
  const noLink = { usable: false, reason: "no_link" } as const;
  const pick = (
    policy: ProviderAppConfig["principalPolicy"],
    hasLink: boolean,
    hasInstallation: boolean,
    unattended = false,
  ) =>
    selectPrincipal({
      config: { ...baseConfig, principalPolicy: policy },
      installation: hasInstallation ? installation : undefined,
      link: hasLink ? link : noLink,
      request: unattended
        ? { tenantId: "t1", runAs: "requester" }
        : { tenantId: "t1", runAs: "requester", requesterId: "u1" },
      access: "write",
      delegationMarker: false,
    });
  const kind = (r: ReturnType<typeof pick>) =>
    Either.isRight(r)
      ? `${r.right.principal.kind}${r.right.fallback ? ":fallback" : ""}`
      : r.left.reason;

  it("follows the policy table", () => {
    expect(kind(pick("app", true, true))).toBe("app");
    expect(kind(pick("app", false, true))).toBe("app");
    expect(kind(pick("user", true, true))).toBe("user");
    expect(kind(pick("user", false, true))).toBe("app:fallback");
    expect(kind(pick("user_only", true, true))).toBe("user");
    expect(kind(pick("user_only", false, true))).toBe("link_required");
  });

  it("never lends a person's link to unattended work", () => {
    expect(kind(pick("user", true, true, true))).toBe("app");
    expect(kind(pick("user_only", true, true, true))).toBe(
      "unattended_unsupported",
    );
    expect(kind(pick("user", true, false, true))).toBe(
      "unattended_unsupported",
    );
  });

  it("offers only the user principal without an installation", () => {
    expect(kind(pick("user", false, false))).toBe("link_required");
    expect(kind(pick("app", true, false))).toBe("app_not_configured");
  });

  it("records the fallback reason", () => {
    const r = selectPrincipal({
      config: { ...baseConfig, principalPolicy: "user" },
      installation,
      link: { usable: false, reason: "refresh_failed" },
      request: attended(),
      access: "read",
      delegationMarker: false,
    });
    expect(Either.getOrThrow(r).fallback).toEqual({ reason: "refresh_failed" });
  });

  it("requires the opt-in for user output without a delegation marker", () => {
    const r = selectPrincipal({
      config: { ...baseConfig, allowUserPrincipalOutput: false },
      installation: undefined,
      link,
      request: attended(),
      access: "write",
      delegationMarker: false,
    });
    expect(Either.isLeft(r) && r.left.reason).toBe("user_output_disabled");
    const read = selectPrincipal({
      config: { ...baseConfig, allowUserPrincipalOutput: false },
      installation: undefined,
      link,
      request: attended(),
      access: "read",
      delegationMarker: false,
    });
    expect(Either.isRight(read)).toBe(true);
  });

  it("runs as another participant only with participantsAsPrincipal", () => {
    const input = {
      installation: undefined,
      link,
      request: attended("u2"),
      sessionCreatorId: "u1",
      access: "read",
      delegationMarker: false,
    } as const;
    expect(kind(selectPrincipal({ ...input, config: baseConfig }))).toBe(
      "participant_not_allowed",
    );
    expect(
      kind(
        selectPrincipal({
          ...input,
          config: { ...baseConfig, participantsAsPrincipal: true },
        }),
      ),
    ).toBe("user");
  });
});

describe("Bond linking", () => {
  it("seals tokens and never stores plaintext", async () => {
    const ctx = setup();
    const link = await run(oauthLink(ctx));
    expect(link.access.ciphertext).toBe("sealed:bond.user.access:access-0");
    expect(link.refresh?.ciphertext).toBe("sealed:bond.user.refresh:refresh-0");
    expect(link.method).toBe("oauth");
  });

  it("rejects methods outside the link method policy", async () => {
    const ctx = setup({ linkMethodPolicy: "oauth_only" });
    const err = await fail(
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-x",
          accessExpiresAt: new Date(ctx.now() + DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    expect(err.reason).toBe("method_disallowed");
  });

  it("rejects extra scopes and personal access tokens without a bounded expiry", async () => {
    const ctx = setup();
    const pat = (accessExpiresAt: string | undefined, scopes: string[]) =>
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-x",
          ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
          scopes,
        },
        actor: "u1",
      });
    expect(
      (await fail(pat(new Date(ctx.now() + DAY).toISOString(), ["api"])))
        .reason,
    ).toBe("scope_not_allowed");
    expect((await fail(pat(undefined, ["read_user"]))).reason).toBe(
      "pat_lifetime_exceeded",
    );
    expect(
      (
        await fail(
          pat(new Date(ctx.now() + 91 * DAY).toISOString(), ["read_user"]),
        )
      ).reason,
    ).toBe("pat_lifetime_exceeded");
    const ok = await run(
      pat(new Date(ctx.now() + 30 * DAY).toISOString(), ["read_user"]),
    );
    expect(ok.refresh).toBeUndefined();
  });

  it("binds the provider account to the user's SSO subject", async () => {
    const ctx = setup({
      identityBinding: { kind: "sso_extern_uid", ssoProvider: "corp" },
    });
    const attempt = (externUid: string) =>
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "oauth",
        providerUser: {
          id: "42",
          login: "alice",
          identities: [{ provider: "corp", externUid }],
        },
        ssoSubject: "alice@corp",
        grant: { accessToken: "a", refreshToken: "r", scopes: ["read_user"] },
        actor: "u1",
      });
    expect((await fail(attempt("bob@corp"))).reason).toBe("identity_mismatch");
    await run(attempt("alice@corp"));
  });

  it("refuses a provider account already linked by another user", async () => {
    const ctx = setup();
    await run(oauthLink(ctx));
    const err = await fail(oauthLink(ctx, { appUserId: "u2" }));
    expect(err.reason).toBe("provider_user_linked_elsewhere");
  });

  it("relinking revokes the previous grant first", async () => {
    const ctx = setup();
    const first = await run(oauthLink(ctx));
    const second = await run(oauthLink(ctx));
    expect(second.id).not.toBe(first.id);
    expect(ctx.provider.revoked).toEqual(["access-0"]);
    const old = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: first.id }),
    );
    expect(old?.status).toBe("revoked");
  });

  it("narrowing the policy disables and revokes links of the removed method", async () => {
    const ctx = setup();
    await run(
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-1",
          accessExpiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    await run(oauthLink(ctx, { appUserId: "u2", providerUserId: "43" }));
    ctx.setConfig({ linkMethodPolicy: "oauth_only" });
    expect(
      await run(
        ctx.bond.narrowLinkMethods({ tenantId: "t1", providerAppId: "gl" }),
      ),
    ).toBe(1);
    expect(ctx.provider.revoked).toEqual(["glpat-1"]);
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended("u1"),
        access: "read",
      }),
    );
    expect(err.reason).toBe("method_disallowed");
  });
});

describe("Bond credentials", () => {
  it("returns the user token and audits the resolution", async () => {
    const ctx = setup();
    const link = await run(oauthLink(ctx));
    const { credential } = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        access: "write",
        operation: "git.push",
      }),
    );
    expect(credential.token).toBe("access-0");
    expect(credential.principal).toEqual({
      kind: "user",
      providerAppId: "gl",
      userLinkId: link.id,
    });
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0]).toMatchObject({
      requestingActor: "u1",
      method: "oauth",
      policy: "user_only",
      fallback: false,
      access: "write",
      operation: "git.push",
    });
    expect(JSON.stringify(ctx.audit)).not.toContain("access-0");
  });

  it("refreshes once for many parallel callers", async () => {
    const ctx = setup();
    await run(oauthLink(ctx, { expiresInMs: 60_000 }));
    ctx.provider.delayMs = 20;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        run(
          ctx.bond.credential({
            tenantId: "t1",
            providerAppId: "gl",
            principal: attended(),
            access: "read",
          }),
        ),
      ),
    );
    expect(ctx.provider.refreshCalls).toBe(1);
    expect(new Set(results.map((r) => r.credential.token))).toEqual(
      new Set(["access-1"]),
    );
  });

  it("refreshes once even when the skew exceeds the token lifetime", async () => {
    let now = Date.parse("2026-10-12T00:00:00.000Z");
    const store = makeMemoryBondStore({ nowMs: () => now });
    const provider = fakeProvider(() => now);
    provider.delayMs = 20;
    const bond = makeBond({
      providerApps: { get: () => Effect.succeed(baseConfig) },
      store,
      cipher: testCipher(),
      providers: { gitlab: provider },
      clock: () => new Date(now).toISOString(),
      leaseRetryMs: 1,
      refreshSkewMs: 3 * HOUR,
    });
    await run(
      bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "oauth",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "access-0",
          refreshToken: "refresh-0",
          accessExpiresAt: new Date(now + 2 * HOUR).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(
          bond.credential({
            tenantId: "t1",
            providerAppId: "gl",
            principal: attended(),
            access: "read",
          }),
        ),
      ),
    );
    expect(provider.refreshCalls).toBe(1);
    expect(new Set(results.map((r) => r.credential.token))).toEqual(
      new Set(["access-1"]),
    );
    now += 1;
  });

  it("ends the link on a rejected refresh and never asks for a token", async () => {
    const ctx = setup();
    const link = await run(oauthLink(ctx, { expiresInMs: 60_000 }));
    ctx.provider.reject = true;
    const req = ctx.bond.credential({
      tenantId: "t1",
      providerAppId: "gl",
      principal: attended(),
      access: "read",
    });
    expect((await fail(req)).reason).toBe("refresh_failed");
    const stored = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: link.id }),
    );
    expect(stored?.status).toBe("refresh_failed");
    expect((await fail(req)).reason).toBe("refresh_failed");
    expect(ctx.provider.refreshCalls).toBe(1);
  });

  it("does not resurrect a link revoked during refresh", async () => {
    const ctx = setup();
    const link = await run(oauthLink(ctx, { expiresInMs: 60_000 }));
    ctx.provider.delayMs = 30;
    const pending = run(
      Effect.either(
        ctx.bond.credential({
          tenantId: "t1",
          providerAppId: "gl",
          principal: attended(),
          access: "read",
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));
    await run(
      ctx.bond.unlink({
        tenantId: "t1",
        linkId: link.id,
        actor: "u1",
        reason: "unlink",
      }),
    );
    const result = await pending;
    expect(Either.isLeft(result) && result.left.reason).toBe("revoked");
    expect(ctx.provider.revoked).toContain("access-1");
    const stored = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: link.id }),
    );
    expect(stored?.status).toBe("revoked");
  });

  it("expires personal access tokens and reports the warning window", async () => {
    const ctx = setup({ linkMethodPolicy: "pat_only" });
    const link = await run(
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-1",
          accessExpiresAt: new Date(ctx.now() + 10 * DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    expect(ctx.bond.linkHealth(link)).toBe("ok");
    ctx.advance(4 * DAY);
    expect(ctx.bond.linkHealth(link)).toBe("expiring");
    ctx.advance(7 * DAY);
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        access: "read",
      }),
    );
    expect(err.reason).toBe("expired");
    expect(ctx.provider.refreshCalls).toBe(0);
  });

  it("rejects unattended work without an app principal", async () => {
    const ctx = setup({ principalPolicy: "user" });
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { tenantId: "t1", runAs: "app" },
        access: "write",
      }),
    );
    expect(err.reason).toBe("unattended_unsupported");
  });

  it("uses a registered bot credential for unattended work and fallback", async () => {
    const ctx = setup({ principalPolicy: "user" });
    const claimed = await run(
      ctx.bond.claimInstallation({
        tenantId: "t1",
        providerAppId: "gl",
        providerInstallationId: "bot-2402",
        actor: "admin",
        verified: true,
        credential: {
          token: "glpat-bot",
          expiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
        },
      }),
    );
    expect(claimed).toBe("claimed");
    expect(ctx.cipher.purposes).toContain("bond.installation.credential");

    const unattended = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { tenantId: "t1", runAs: "app" },
        access: "write",
      }),
    );
    expect(unattended.credential.token).toBe("glpat-bot");
    expect(unattended.credential.principal.kind).toBe("app");

    const fallback = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended("nobody"),
        access: "write",
      }),
    );
    expect(fallback.resolution.fallback).toEqual({ reason: "no_link" });
    expect(ctx.audit.at(-1)?.fallback).toEqual({ reason: "no_link" });

    const elsewhere = await fail(
      ctx.bond.claimInstallation({
        tenantId: "t2",
        providerAppId: "gl",
        providerInstallationId: "bot-2402",
        actor: "other",
        verified: true,
      }),
    );
    expect(elsewhere.reason).toBe("installation_owned_elsewhere");
  });

  it("fails clearly when the bot credential has expired", async () => {
    const ctx = setup({ principalPolicy: "app" });
    await run(
      ctx.bond.claimInstallation({
        tenantId: "t1",
        providerAppId: "gl",
        providerInstallationId: "bot-1",
        actor: "admin",
        verified: true,
        credential: {
          token: "glpat-bot",
          expiresAt: new Date(ctx.now() + DAY).toISOString(),
        },
      }),
    );
    ctx.advance(2 * DAY);
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { tenantId: "t1", runAs: "app" },
        access: "read",
      }),
    );
    expect(err.reason).toBe("app_not_configured");
  });

  it("adapts to the CredentialResolver port", async () => {
    const ctx = setup();
    await run(oauthLink(ctx));
    const resolver = ctx.bond.credentialResolver(() => ({
      providerAppId: "gl",
      access: "read",
    }));
    const ok = await run(
      resolver.resolve({
        integrationId: "gitlab",
        authority: "gitlab.example.com",
        principal: attended(),
      }),
    );
    expect(ok.token).toBe("access-0");
    const missing = await run(
      Effect.either(
        resolver.resolve({
          integrationId: "gitlab",
          authority: "gitlab.example.com",
        }),
      ),
    );
    expect(Either.isLeft(missing) && missing.left._tag).toBe("CredentialError");
  });

  it("surfaces typed errors, not defects", async () => {
    const ctx = setup();
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "missing",
        principal: attended(),
        access: "read",
      }),
    );
    expect(err).toBeInstanceOf(BondError);
    expect(err.reason).toBe("config");
  });
});
