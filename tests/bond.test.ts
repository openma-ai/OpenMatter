import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  BondError,
  ConfigError,
  ProviderError,
  StoreError,
  bondStoreConformanceCases,
  checkResourceRequest,
  makeBond,
  manifestProblems,
  parseResourceId,
  resourceId,
  type BondManifest,
  makeMemoryBondStore,
  selectPrincipal,
  type AuditFact,
  type BondProvider,
  type ProviderAppConfig,
  type SecretCipher,
  type TokenGrant,
} from "../packages/matter/src/bond/index.js";

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
            new ProviderError({
              message: "invalid_grant body=secret-marker",
              rejected: true,
              status: 400,
            }),
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
      get: ({ providerAppId: id }) => {
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
  ({
    tenantId: "t1",
    trigger: "attended",
    runAs: "requester",
    requesterId,
  }) as const;

const unattendedApp = {
  tenantId: "t1",
  trigger: "unattended",
  runAs: "app",
} as const;

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
  type Request = Parameters<typeof selectPrincipal>[0]["request"];
  const pick = (
    policy: ProviderAppConfig["principalPolicy"],
    opts: {
      readonly runAs?: "app" | "requester";
      readonly unattended?: boolean;
      readonly link?: boolean;
      readonly installation?: boolean;
    } = {},
  ) =>
    selectPrincipal({
      config: { ...baseConfig, principalPolicy: policy },
      installation: opts.installation === false ? undefined : installation,
      link: opts.link === false ? noLink : link,
      request: (opts.runAs === "app"
        ? {
            tenantId: "t1",
            trigger: opts.unattended === true ? "unattended" : "attended",
            runAs: "app",
            requesterId: "u1",
          }
        : attended()) as Request,
      sessionCreatorId: "u1",
      access: "write",
      delegationMarker: false,
    });
  const kind = (r: ReturnType<typeof pick>) =>
    Either.isRight(r)
      ? `${r.right.principal.kind}${r.right.fallback ? `:${r.right.fallback.reason}` : ""}`
      : r.left.reason;

  it("follows the runAs by policy matrix", () => {
    expect(kind(pick("app"))).toBe("app:policy_app");
    expect(kind(pick("user"))).toBe("user");
    expect(kind(pick("user", { link: false }))).toBe("app:no_link");
    expect(kind(pick("user_only"))).toBe("user");
    expect(kind(pick("user_only", { link: false }))).toBe("link_required");
    expect(kind(pick("app", { runAs: "app" }))).toBe("app");
    expect(kind(pick("user", { runAs: "app" }))).toBe("app");
    expect(kind(pick("user_only", { runAs: "app" }))).toBe("app_disallowed");
    expect(kind(pick("user_only", { runAs: "app", unattended: true }))).toBe(
      "unattended_unsupported",
    );
  });

  it("never lends a person's link to unattended work, even with a known actor", () => {
    expect(kind(pick("user", { runAs: "app", unattended: true }))).toBe("app");
    expect(
      kind(
        pick("user", { runAs: "app", unattended: true, installation: false }),
      ),
    ).toBe("unattended_unsupported");
    const unattendedRequester = selectPrincipal({
      config: { ...baseConfig, principalPolicy: "user" },
      installation,
      link,
      request: {
        tenantId: "t1",
        trigger: "unattended",
        runAs: "requester",
        requesterId: "u1",
      } as unknown as Request,
      sessionCreatorId: "u1",
      access: "read",
      delegationMarker: false,
    });
    expect(kind(unattendedRequester)).toBe("invalid_principal_request");
  });

  it("rejects malformed requests instead of guessing", () => {
    for (const request of [
      { tenantId: "t1", trigger: "attended", runAs: "requester" },
      { tenantId: "t1", runAs: "app" },
      {
        tenantId: "t1",
        trigger: "attended",
        runAs: "owner",
        requesterId: "u1",
      },
    ]) {
      const r = selectPrincipal({
        config: { ...baseConfig, principalPolicy: "user" },
        installation,
        link,
        request: request as unknown as Request,
        sessionCreatorId: "u1",
        access: "read",
        delegationMarker: false,
      });
      expect(kind(r)).toBe("invalid_principal_request");
    }
  });

  it("offers only the user principal without an installation", () => {
    expect(kind(pick("user", { link: false, installation: false }))).toBe(
      "link_required",
    );
    expect(kind(pick("app", { installation: false }))).toBe(
      "app_not_configured",
    );
  });

  it("records the fallback reason", () => {
    const r = selectPrincipal({
      config: { ...baseConfig, principalPolicy: "user" },
      installation,
      link: { usable: false, reason: "refresh_failed" },
      request: attended(),
      sessionCreatorId: "u1",
      access: "read",
      delegationMarker: false,
    });
    expect(Either.getOrThrow(r).fallback).toEqual({ reason: "refresh_failed" });
  });

  it("requires the opt-in for user output without a delegation marker and never switches to the app", () => {
    const input = {
      config: {
        ...baseConfig,
        principalPolicy: "user",
        allowUserPrincipalOutput: false,
      },
      installation,
      link,
      request: attended(),
      sessionCreatorId: "u1",
      delegationMarker: false,
    } as const;
    expect(kind(selectPrincipal({ ...input, access: "write" }))).toBe(
      "user_output_disabled",
    );
    expect(kind(selectPrincipal({ ...input, access: "read" }))).toBe("user");
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

  it("treats an unknown Session creator as another participant", () => {
    const { sessionCreatorId: _c, ...input } = {
      config: baseConfig,
      installation: undefined,
      link,
      request: attended("u1"),
      sessionCreatorId: "u1",
      access: "read",
      delegationMarker: false,
    } as const;
    expect(kind(selectPrincipal(input))).toBe("participant_not_allowed");
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

  it("relinking persists the new token before revoking the previous one", async () => {
    const ctx = setup();
    const first = await run(oauthLink(ctx));
    const second = await run(
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-new",
          accessExpiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    // Same provider account: updated in place with the other method.
    expect(second.id).toBe(first.id);
    expect(second.method).toBe("pat");
    expect(second.refresh).toBeUndefined();
    expect(ctx.provider.revoked).toEqual(["access-0"]);

    // A different provider account replaces the link and retires the old one.
    const third = await run(oauthLink(ctx, { providerUserId: "43" }));
    expect(third.id).not.toBe(first.id);
    expect(ctx.provider.revoked).toEqual(["access-0", "glpat-new"]);
    const old = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: first.id }),
    );
    expect(old?.status).toBe("revoked");
  });

  it("relinking with the same token does not revoke it", async () => {
    const ctx = setup({ linkMethodPolicy: "pat_only" });
    const pat = () =>
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-same",
          accessExpiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      });
    const first = await run(pat());
    const again = await run(pat());
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("active");
    expect(ctx.provider.revoked).toEqual([]);
  });

  it("keeps the previous link when storing the new one fails", async () => {
    const ctx = setup();
    const first = await run(oauthLink(ctx));
    const failing = makeBond({
      providerApps: { get: () => Effect.succeed(baseConfig) },
      store: {
        ...ctx.store,
        upsertUserLink: () =>
          Effect.fail(new StoreError({ message: "database unavailable" })),
      },
      cipher: ctx.cipher,
      providers: { gitlab: ctx.provider },
    });
    const err = await fail(
      failing.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "oauth",
        providerUser: { id: "43", login: "alice2" },
        grant: { accessToken: "a2", refreshToken: "r2", scopes: ["read_user"] },
        actor: "u1",
      }),
    );
    expect(err.reason).toBe("store");
    const kept = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: first.id }),
    );
    expect(kept?.status).toBe("active");
    expect(ctx.provider.revoked).toEqual([]);
  });

  it("refuses a grant whose scopes the provider did not report", async () => {
    const ctx = setup();
    const err = await fail(
      ctx.bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "oauth",
        providerUser: { id: "42", login: "alice" },
        grant: { accessToken: "a", refreshToken: "r" },
        actor: "u1",
      }),
    );
    expect(err.reason).toBe("scope_not_allowed");
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
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(err.reason).toBe("method_disallowed");
  });
});

describe("Bond device links", () => {
  const deviceLink = (
    ctx: ReturnType<typeof setup>,
    accessExpiresAt?: string,
  ) =>
    ctx.bond.link({
      tenantId: "t1",
      appUserId: "u1",
      providerAppId: "gl",
      method: "device",
      providerUser: { id: "42", login: "alice" },
      grant: {
        accessToken: "access-0",
        refreshToken: "refresh-0",
        accessExpiresAt:
          accessExpiresAt ?? new Date(ctx.now() + 2 * HOUR).toISOString(),
        scopes: ["read_user"],
      },
      actor: "u1",
    });

  it("links and resolves a device link where OAuth is allowed", async () => {
    for (const linkMethodPolicy of ["oauth_only", "oauth_preferred"] as const) {
      const ctx = setup({ linkMethodPolicy });
      const link = await run(deviceLink(ctx));
      expect(link.method).toBe("device");
      expect(link.refresh?.ciphertext).toBe(
        "sealed:bond.user.refresh:refresh-0",
      );
      const { credential } = await run(
        ctx.bond.credential({
          tenantId: "t1",
          providerAppId: "gl",
          principal: attended(),
          sessionCreatorId: "u1",
          access: "read",
        }),
      );
      expect(credential.token).toBe("access-0");
      expect(ctx.audit[0]).toMatchObject({ method: "device" });
    }
  });

  it("refreshes a device link like an OAuth link", async () => {
    const ctx = setup();
    await run(deviceLink(ctx, new Date(ctx.now() + 60_000).toISOString()));
    const { credential } = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(ctx.provider.refreshCalls).toBe(1);
    expect(credential.token).toBe("access-1");
  });

  it("does not apply the personal access token lifetime to device links", async () => {
    const ctx = setup({ maxPatLifetimeDays: 1 });
    const link = await run(
      deviceLink(ctx, new Date(ctx.now() + 30 * DAY).toISOString()),
    );
    expect(link.method).toBe("device");
  });

  it("refuses a device link under a pat-only policy", async () => {
    const ctx = setup({ linkMethodPolicy: "pat_only" });
    expect((await fail(deviceLink(ctx))).reason).toBe("method_disallowed");
  });

  it("narrowing to pat only disables and revokes device links", async () => {
    const ctx = setup();
    await run(deviceLink(ctx));
    ctx.setConfig({ linkMethodPolicy: "pat_only" });
    expect(
      await run(
        ctx.bond.narrowLinkMethods({ tenantId: "t1", providerAppId: "gl" }),
      ),
    ).toBe(1);
    expect(ctx.provider.revoked).toEqual(["access-0"]);
  });

  it("registers a feishu provider", async () => {
    let now = Date.parse("2026-10-12T00:00:00.000Z");
    const feishu: BondProvider = {
      ...fakeProvider(() => now),
      provider: "feishu",
    };
    const config: ProviderAppConfig = {
      ...baseConfig,
      id: "fs",
      provider: "feishu",
      baseUrl: "https://open.feishu.cn",
    };
    const bond = makeBond({
      providerApps: { get: () => Effect.succeed(config) },
      store: makeMemoryBondStore({ nowMs: () => now }),
      cipher: testCipher(),
      providers: { feishu },
      clock: () => new Date(now).toISOString(),
    });
    await run(
      bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "fs",
        method: "device",
        providerUser: { id: "ou_1", login: "alice" },
        grant: {
          accessToken: "u-token",
          refreshToken: "r-token",
          accessExpiresAt: new Date(now + 2 * HOUR).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    now += 1;
    const { credential } = await run(
      bond.credential({
        tenantId: "t1",
        providerAppId: "fs",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(credential.token).toBe("u-token");
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
        sessionCreatorId: "u1",
        access: "write",
        operation: "git.push",
        resource: "group/project",
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
      outcome: "granted",
      trigger: "attended",
      resource: "group/project",
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
            sessionCreatorId: "u1",
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
            sessionCreatorId: "u1",
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
      sessionCreatorId: "u1",
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
          sessionCreatorId: "u1",
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
        sessionCreatorId: "u1",
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
        principal: unattendedApp,
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
        principal: unattendedApp,
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
        sessionCreatorId: "nobody",
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
        principal: unattendedApp,
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
      sessionCreatorId: "u1",
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
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(err).toBeInstanceOf(BondError);
    expect(err.reason).toBe("config");
  });

  const claimBot = (
    ctx: ReturnType<typeof setup>,
    providerInstallationId = "bot-1",
    token = "glpat-bot",
  ) =>
    ctx.bond.claimInstallation({
      tenantId: "t1",
      providerAppId: "gl",
      providerInstallationId,
      actor: "admin",
      verified: true,
      credential: {
        token,
        expiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
      },
    });

  it("treats a webhook with a mapped actor as unattended", async () => {
    const ctx = setup({ principalPolicy: "user" });
    await run(oauthLink(ctx));
    await run(claimBot(ctx));
    const r = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { ...unattendedApp, requesterId: "u1" },
        sessionCreatorId: "u1",
        access: "write",
      }),
    );
    expect(r.credential.principal.kind).toBe("app");
    expect(ctx.audit.at(-1)).toMatchObject({
      outcome: "granted",
      trigger: "unattended",
      requestingActor: "u1",
      executionPrincipal: { kind: "app" },
    });
  });

  it("requires a named installation when the tenant owns several", async () => {
    const ctx = setup({ principalPolicy: "app" });
    await run(claimBot(ctx, "bot-1", "glpat-one"));
    await run(claimBot(ctx, "bot-2", "glpat-two"));
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: unattendedApp,
        access: "read",
      }),
    );
    expect(err.reason).toBe("installation_required");
    const [first] = await run(
      ctx.store.listInstallations({ tenantId: "t1", providerAppId: "gl" }),
    );
    const named = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        installationId: first?.id ?? "",
        principal: unattendedApp,
        access: "read",
      }),
    );
    expect(named.credential.token).toBe("glpat-one");
  });

  it("falls back to the app in the same call when the refresh is rejected under user", async () => {
    const ctx = setup({ principalPolicy: "user" });
    await run(claimBot(ctx));
    const link = await run(oauthLink(ctx, { expiresInMs: 60_000 }));
    ctx.provider.reject = true;
    const r = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "write",
      }),
    );
    expect(r.credential.token).toBe("glpat-bot");
    expect(r.resolution.fallback).toEqual({ reason: "refresh_failed" });
    expect(ctx.audit.at(-1)?.fallback).toEqual({ reason: "refresh_failed" });
    const stored = await run(
      ctx.store.getUserLink({ tenantId: "t1", linkId: link.id }),
    );
    expect(stored?.status).toBe("refresh_failed");
    // The provider's message is never stored.
    expect(stored?.statusReason).toBe(
      "the provider rejected the refresh (HTTP 400)",
    );
  });

  it("does not switch principals on a transport failure", async () => {
    const ctx = setup({ principalPolicy: "user" });
    await run(claimBot(ctx));
    await run(oauthLink(ctx, { expiresInMs: 60_000 }));
    const mutable = ctx.provider as {
      refreshUserToken: BondProvider["refreshUserToken"];
    };
    const original = mutable.refreshUserToken;
    mutable.refreshUserToken = () =>
      Effect.fail(new ProviderError({ message: "timeout", rejected: false }));
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "write",
      }),
    );
    mutable.refreshUserToken = original;
    expect(err.reason).toBe("provider");
    expect(err.retryable).toBe(true);
  });

  it("audits denials with the reason and policy", async () => {
    const ctx = setup();
    await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "write",
        operation: "git.push",
        resource: "group/project",
      }),
    );
    await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: unattendedApp,
        access: "write",
      }),
    );
    expect(ctx.audit).toEqual([
      expect.objectContaining({
        outcome: "denied",
        denial: "link_required",
        policy: "user_only",
        trigger: "attended",
        requestingActor: "u1",
        operation: "git.push",
        resource: "group/project",
        fallback: false,
      }),
      expect.objectContaining({
        outcome: "denied",
        denial: "unattended_unsupported",
        trigger: "unattended",
      }),
    ]);
    expect(ctx.audit[0]?.executionPrincipal).toBeUndefined();
  });

  it("replaces a rotated bot credential and drops the cached token", async () => {
    const ctx = setup({ principalPolicy: "app" });
    await run(claimBot(ctx, "bot-1", "glpat-old"));
    const read = () =>
      run(
        ctx.bond.credential({
          tenantId: "t1",
          providerAppId: "gl",
          principal: unattendedApp,
          access: "read",
        }),
      ).then((r) => r.credential.token);
    expect(await read()).toBe("glpat-old");
    expect(await run(claimBot(ctx, "bot-1", "glpat-rotated"))).toBe(
      "already_owned",
    );
    expect(await read()).toBe("glpat-rotated");
    const [installation] = await run(
      ctx.store.listInstallations({ tenantId: "t1", providerAppId: "gl" }),
    );
    await run(
      ctx.bond.replaceInstallationCredential({
        tenantId: "t1",
        installationId: installation?.id ?? "",
        token: "glpat-third",
        actor: "admin",
      }),
    );
    expect(await read()).toBe("glpat-third");
    const err = await fail(
      ctx.bond.replaceInstallationCredential({
        tenantId: "t2",
        installationId: installation?.id ?? "",
        token: "glpat-foreign",
        actor: "intruder",
      }),
    );
    expect(err.reason).toBe("not_found");
    expect(await read()).toBe("glpat-third");
  });

  it("ends a personal access token the provider rejected", async () => {
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
          accessExpiresAt: new Date(ctx.now() + 30 * DAY).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    expect(
      await run(ctx.bond.reportRejected({ tenantId: "t1", linkId: link.id })),
    ).toBe("expired");
    const err = await fail(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(err.reason).toBe("expired");
  });

  it("refreshes an OAuth link at once when the provider rejected its token", async () => {
    const ctx = setup();
    const link = await run(oauthLink(ctx));
    expect(
      await run(ctx.bond.reportRejected({ tenantId: "t1", linkId: link.id })),
    ).toBe("active");
    expect(ctx.provider.refreshCalls).toBe(1);
    const r = await run(
      ctx.bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(r.credential.token).toBe("access-1");
  });

  it("reads policy per tenant", async () => {
    const ctx = setup();
    await run(oauthLink(ctx));
    const perTenant = makeBond({
      providerApps: {
        get: ({ tenantId }) =>
          Effect.succeed({
            ...baseConfig,
            principalPolicy: tenantId === "t1" ? "user_only" : "app",
          }),
      },
      store: ctx.store,
      cipher: ctx.cipher,
      providers: { gitlab: ctx.provider },
    });
    const t1 = await run(
      perTenant.resolvePrincipal({
        tenantId: "t1",
        providerAppId: "gl",
        principal: attended(),
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(t1.policy).toBe("user_only");
    const t2 = await fail(
      perTenant.resolvePrincipal({
        tenantId: "t2",
        providerAppId: "gl",
        principal: { ...attended(), tenantId: "t2" },
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(t2.reason).toBe("app_not_configured");
  });
});

describe("binding manifest helpers", () => {
  const manifest: BondManifest = {
    provider: "gitlab",
    title: "Test",
    setupSchema: {
      type: "object",
      properties: { baseUrl: { type: "string", title: "URL", format: "uri" } },
      required: ["baseUrl"],
    },
    linkMethods: ["pat"],
    resourceKinds: [
      {
        kind: "project",
        title: "Project",
        operations: [
          { name: "fetch", description: "f", access: "read" },
          { name: "push", description: "p", access: "write" },
        ],
      },
    ],
  };

  it("parses and builds <kind>:<key> resource IDs", () => {
    expect(resourceId("project", 42)).toBe("project:42");
    expect(parseResourceId("project:42")).toEqual({
      kind: "project",
      key: "42",
    });
    expect(parseResourceId("chat:oc_a:b")).toEqual({
      kind: "chat",
      key: "oc_a:b",
    });
    for (const bad of ["", "project", "project:", ":42", "Project:1", "1x:2"]) {
      expect(parseResourceId(bad)).toBeUndefined();
    }
  });

  it("checks the kind and operations before any provider call", () => {
    expect(
      checkResourceRequest(manifest, "project:7", ["fetch", "push"]),
    ).toMatchObject({
      ok: true,
      key: "7",
      kind: { kind: "project" },
    });
    expect(checkResourceRequest(manifest, "nope", ["fetch"])).toMatchObject({
      ok: false,
      reason: "malformed_id",
    });
    expect(checkResourceRequest(manifest, "group:7", ["fetch"])).toMatchObject({
      ok: false,
      reason: "unknown_kind",
    });
    expect(
      checkResourceRequest(manifest, "project:7", ["fetch", "delete"]),
    ).toMatchObject({
      ok: false,
      reason: "unknown_operation",
      message: "project does not support delete",
    });
  });

  it("reports manifest problems a host could not render or enforce", () => {
    expect(manifestProblems(manifest)).toEqual([]);
    const broken: BondManifest = {
      ...manifest,
      setupSchema: { type: "object", properties: {}, required: ["baseUrl"] },
      resourceKinds: [
        { kind: "project", title: "P", operations: [] },
        {
          kind: "project",
          title: "P2",
          operations: [
            { name: "Push", description: "x", access: "write" },
            { name: "fetch", description: "x", access: "read" },
            { name: "fetch", description: "x", access: "read" },
          ],
        },
      ],
    };
    expect(manifestProblems(broken)).toEqual([
      "kind project has no operations",
      "duplicate kind project",
      "invalid operation project.Push",
      "duplicate operation project.fetch",
      "required field baseUrl is not defined",
    ]);
  });
});
