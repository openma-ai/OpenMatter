import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ProviderError,
  makeBond,
  makeMemoryBondStore,
  manifestProblems,
  type ProviderAppConfig,
} from "../packages/matter/src/bond/index.js";
import {
  authorizationUrl,
  beginDeviceAuthorization,
  createPkce,
  exchangeCode,
  feishuEndpoints,
  feishuManifest,
  feishuSetupProblems,
  inspectFeishuApp,
  isRetryableFeishuFailure,
  makeFeishuBinding,
  makeFeishuBondProvider,
  makeFeishuResourceCatalog,
  mintTenantAccessToken,
  pollDeviceToken,
  refreshUserAccessToken,
} from "../packages/feishu/src/bond/index.js";

const FEISHU = "https://open.feishu.cn";
const LARK = "https://open.larksuite.com";
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const fail = async <A, E>(e: Effect.Effect<A, E>) => {
  const result = await Effect.runPromise(Effect.either(e));
  if (Either.isRight(result)) throw new Error("expected a failure");
  return result.left;
};

type Handler = (
  url: URL,
  init: RequestInit,
) => { status: number; body?: unknown };
const fakeFetch = (handler: Handler) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
};

const formBody = (init: RequestInit) =>
  Object.fromEntries(new URLSearchParams(String(init.body)));
const jsonBody = (init: RequestInit) =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

const client = (impl: typeof fetch, now = "2026-10-16T00:00:00.000Z") => ({
  baseUrl: FEISHU,
  appId: "cli_test_app",
  appSecret: "test-secret",
  fetch: impl,
  clock: () => now,
});

describe("Feishu brands and errors", () => {
  it("selects the open and accounts origins by brand and rejects others", () => {
    expect(feishuEndpoints(FEISHU)).toEqual({
      brand: "feishu",
      open: "https://open.feishu.cn",
      accounts: "https://accounts.feishu.cn",
    });
    expect(feishuEndpoints("https://accounts.larksuite.com/")).toEqual({
      brand: "lark",
      open: LARK,
      accounts: "https://accounts.larksuite.com",
    });
    expect(() => feishuEndpoints("https://open.example.com")).toThrow();
    expect(() => feishuEndpoints("http://open.feishu.cn")).toThrow();
    expect(() => feishuEndpoints("https://open.feishu.cn/path")).toThrow();
  });

  it("classifies rate limits and server errors as retryable", () => {
    expect(isRetryableFeishuFailure(429, undefined)).toBe(true);
    expect(isRetryableFeishuFailure(503, undefined)).toBe(true);
    expect(isRetryableFeishuFailure(200, 99991400)).toBe(true);
    expect(isRetryableFeishuFailure(400, 20050)).toBe(true);
    expect(isRetryableFeishuFailure(400, 99991663)).toBe(false);
    expect(isRetryableFeishuFailure(400, undefined)).toBe(false);
  });
});

describe("Feishu tenant access token", () => {
  it("mints a token for a self-built app and reports its expiry", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 },
    }));
    const token = await run(
      mintTenantAccessToken({
        baseUrl: FEISHU,
        appId: "cli_test_app",
        appSecret: "test-secret",
        fetch: impl,
        clock: () => "2026-10-16T00:00:00.000Z",
      }),
    );
    expect(token).toEqual({
      token: "t-1",
      expiresAt: "2026-10-16T02:00:00.000Z",
    });
    expect(calls[0]!.url).toBe(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    );
    expect(jsonBody(calls[0]!.init)).toEqual({
      app_id: "cli_test_app",
      app_secret: "test-secret",
    });
  });

  it("maps a Feishu error code without echoing the secret", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: { code: 10014, msg: "app secret invalid" },
    }));
    const error = await fail(
      mintTenantAccessToken({
        baseUrl: FEISHU,
        appId: "cli_test_app",
        appSecret: "test-secret",
        fetch: impl,
      }),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("10014");
    expect(error.message).not.toContain("test-secret");
    expect(error.rejected).toBe(false);
  });

  it("marks a rate-limited mint as retryable", async () => {
    const { impl } = fakeFetch(() => ({
      status: 400,
      body: { code: 99991400, msg: "frequency limit" },
    }));
    const error = await fail(
      mintTenantAccessToken({
        baseUrl: FEISHU,
        appId: "cli_test_app",
        appSecret: "test-secret",
        fetch: impl,
      }),
    );
    expect(error.cause).toEqual({ feishuCode: 99991400, retryable: true });
  });
});

describe("Feishu user authorization", () => {
  it("builds a PKCE authorization URL on the accounts origin", async () => {
    const pkce = await run(createPkce());
    const url = new URL(
      authorizationUrl({
        baseUrl: FEISHU,
        clientId: "cli_test_app",
        redirectUri: "https://oma.example.com/callback",
        scopes: ["docx:document:readonly", "offline_access"],
        state: "s1",
        codeChallenge: pkce.challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cli_test_app",
      response_type: "code",
      redirect_uri: "https://oma.example.com/callback",
      scope: "docx:document:readonly offline_access",
      state: "s1",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
  });

  it("exchanges a code with credentials in the form body only", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        code: 0,
        access_token: "u-1",
        refresh_token: "r-1",
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: "docx:document:readonly offline_access",
        token_type: "Bearer",
      },
    }));
    const grant = await run(
      exchangeCode(client(impl), {
        code: "c1",
        redirectUri: "https://oma.example.com/callback",
        codeVerifier: "v1",
      }),
    );
    expect(grant).toEqual({
      accessToken: "u-1",
      refreshToken: "r-1",
      accessExpiresAt: "2026-10-16T02:00:00.000Z",
      scopes: ["docx:document:readonly", "offline_access"],
    });
    expect(calls[0]!.url).toBe("https://accounts.feishu.cn/oauth/v3/token");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(formBody(calls[0]!.init)).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      redirect_uri: "https://oma.example.com/callback",
      code_verifier: "v1",
      client_id: "cli_test_app",
      client_secret: "test-secret",
    });
  });

  it("returns the rotated pair on refresh and rejects a dead grant", async () => {
    const { impl } = fakeFetch((_url, init) => {
      const body = formBody(init);
      if (body.refresh_token === "r-dead")
        return { status: 400, body: { code: 20064, error: "invalid_grant" } };
      return {
        status: 200,
        body: {
          code: 0,
          access_token: "u-2",
          refresh_token: "r-2",
          expires_in: 7200,
          scope: "offline_access",
        },
      };
    });
    const grant = await run(refreshUserAccessToken(client(impl), "r-1"));
    expect(grant.refreshToken).toBe("r-2");
    const error = await fail(refreshUserAccessToken(client(impl), "r-dead"));
    expect(error.rejected).toBe(true);
  });

  it("does not treat a server error on refresh as a rejected grant", async () => {
    const { impl } = fakeFetch(() => ({
      status: 500,
      body: { code: 20050, error: "server_error" },
    }));
    const error = await fail(refreshUserAccessToken(client(impl), "r-1"));
    expect(error.rejected).toBe(false);
    expect(error.cause).toEqual({ feishuCode: 20050, retryable: true });
  });

  it("begins a device authorization and polls every state", async () => {
    let answer: { status: number; body: unknown } = { status: 200, body: {} };
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === "/oauth/v1/device_authorization") {
        return {
          status: 200,
          body: {
            device_code: "dc-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://accounts.feishu.cn/device",
            verification_uri_complete:
              "https://accounts.feishu.cn/device?code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          },
        };
      }
      return answer;
    });
    const c = client(impl);
    const begun = await run(
      beginDeviceAuthorization(c, ["docx:document:readonly"]),
    );
    expect(begun).toEqual({
      deviceCode: "dc-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.feishu.cn/device",
      verificationUriComplete:
        "https://accounts.feishu.cn/device?code=ABCD-EFGH",
      expiresAt: "2026-10-16T00:10:00.000Z",
      interval: 5,
    });
    expect(formBody(calls[0]!.init).scope).toBe(
      "docx:document:readonly offline_access",
    );

    answer = { status: 400, body: { error: "authorization_pending" } };
    expect(
      await run(pollDeviceToken(c, { deviceCode: "dc-1", interval: 5 })),
    ).toEqual({ status: "pending", interval: 5 });
    answer = { status: 400, body: { error: "slow_down" } };
    expect(
      await run(pollDeviceToken(c, { deviceCode: "dc-1", interval: 5 })),
    ).toEqual({ status: "slow_down", interval: 10 });
    expect(
      await run(pollDeviceToken(c, { deviceCode: "dc-1", interval: 58 })),
    ).toEqual({ status: "slow_down", interval: 60 });
    answer = { status: 400, body: { error: "expired_token" } };
    expect(
      await run(pollDeviceToken(c, { deviceCode: "dc-1", interval: 5 })),
    ).toEqual({ status: "expired" });
    answer = { status: 400, body: { error: "access_denied" } };
    expect(
      await run(pollDeviceToken(c, { deviceCode: "dc-1", interval: 5 })),
    ).toEqual({ status: "denied" });
    answer = {
      status: 200,
      body: {
        code: 0,
        access_token: "u-1",
        refresh_token: "r-1",
        expires_in: 7200,
        scope: "docx:document:readonly offline_access",
      },
    };
    const granted = await run(
      pollDeviceToken(c, { deviceCode: "dc-1", interval: 5 }),
    );
    expect(granted.status).toBe("granted");
    const poll = calls.at(-1)!;
    expect(poll.url).toBe("https://accounts.feishu.cn/oauth/v3/token");
    expect(formBody(poll.init).grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(formBody(poll.init).device_code).toBe("dc-1");
  });
});

describe("Feishu BondProvider with the Bond kernel", () => {
  it("mints the app credential, refreshes a device link, and revokes it", async () => {
    let now = Date.parse("2026-10-16T00:00:00.000Z");
    let issued = 0;
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        expect(jsonBody(init).app_secret).toBe("resolved-secret");
        return {
          status: 200,
          body: { code: 0, tenant_access_token: "t-1", expire: 7200 },
        };
      }
      if (url.pathname === "/oauth/v3/token") {
        issued++;
        expect(formBody(init).grant_type).toBe("refresh_token");
        return {
          status: 200,
          body: {
            code: 0,
            access_token: `u-${issued}`,
            refresh_token: `r-${issued}`,
            expires_in: 7200,
            scope: "offline_access",
          },
        };
      }
      if (url.pathname === "/oauth/v1/revoke")
        return { status: 200, body: { code: 0 } };
      return { status: 404 };
    });
    const config: ProviderAppConfig = {
      id: "fs",
      provider: "feishu",
      baseUrl: FEISHU,
      linkMethodPolicy: "oauth_only",
      principalPolicy: "user",
      allowedScopes: ["offline_access"],
      identityBinding: { kind: "none" },
      allowUserPrincipalOutput: false,
      oauth: { clientId: "cli_test_app", clientSecret: { ref: "vault:fs" } },
    };
    const clock = () => new Date(now).toISOString();
    const bond = makeBond({
      providerApps: {
        get: ({ providerAppId: id }) =>
          id === "fs"
            ? Effect.succeed(config)
            : Effect.fail(new ConfigError({ message: "x", providerAppId: id })),
      },
      store: makeMemoryBondStore({ nowMs: () => now }),
      cipher: {
        seal: (p) => Effect.succeed({ keyId: "k", ciphertext: p }),
        open: (s) => Effect.succeed(s.ciphertext),
      },
      providers: {
        feishu: makeFeishuBondProvider({
          fetch: impl,
          clock,
          resolveSecret: () => Effect.succeed("resolved-secret"),
        }),
      },
      clock,
    });

    await run(
      bond.claimInstallation({
        tenantId: "t1",
        providerAppId: "fs",
        providerInstallationId: "cli_test_app",
        accountLogin: "OMA Bot",
        actor: "admin",
        verified: true,
      }),
    );
    const app = await run(
      bond.credential({
        tenantId: "t1",
        providerAppId: "fs",
        principal: { tenantId: "t1", trigger: "unattended", runAs: "app" },
        access: "write",
      }),
    );
    expect(app.credential.token).toBe("t-1");

    const link = await run(
      bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "fs",
        method: "device",
        providerUser: { id: "ou_test", login: "Alice" },
        grant: {
          accessToken: "u-0",
          refreshToken: "r-0",
          accessExpiresAt: new Date(now + 7200_000).toISOString(),
          scopes: ["offline_access"],
        },
        actor: "u1",
      }),
    );
    now += 7200_000;
    const user = await run(
      bond.credential({
        tenantId: "t1",
        providerAppId: "fs",
        principal: {
          tenantId: "t1",
          trigger: "attended",
          runAs: "requester",
          requesterId: "u1",
        },
        sessionCreatorId: "u1",
        access: "read",
      }),
    );
    expect(user.credential.token).toBe("u-1");

    await run(
      bond.unlink({
        tenantId: "t1",
        linkId: link.id,
        actor: "u1",
        reason: "unlink",
      }),
    );
    const revokes = calls.filter((c) => c.url.endsWith("/oauth/v1/revoke"));
    expect(revokes.map((r) => formBody(r.init).token)).toEqual(["r-1", "u-1"]);
    expect(formBody(revokes[0]!.init).client_secret).toBe("resolved-secret");
  });

  it("fails on a client secret without a resolver", async () => {
    const provider = makeFeishuBondProvider();
    const error = await fail(
      provider.refreshUserToken(
        {
          id: "fs",
          provider: "feishu",
          baseUrl: FEISHU,
          linkMethodPolicy: "oauth_only",
          principalPolicy: "user",
          allowedScopes: [],
          identityBinding: { kind: "none" },
          allowUserPrincipalOutput: false,
          oauth: { clientId: "cli_test_app", clientSecret: { ref: "x" } },
        },
        "r-1",
      ),
    );
    expect(error.rejected).toBe(false);
  });
});

describe("Feishu manifest, setup, and resources", () => {
  it("declares a valid manifest and wires the binding", () => {
    expect(manifestProblems(feishuManifest)).toEqual([]);
    expect(feishuManifest.linkMethods).toEqual(["device", "oauth"]);
    const binding = makeFeishuBinding();
    expect(binding.manifest).toBe(feishuManifest);
    expect(binding.provider.provider).toBe("feishu");
    expect(binding.provider.delegationMarker).toBe(false);
  });

  it("requires an encrypt key for webhook ingress and a cli_ app id", () => {
    const ok = {
      kind: "self_built",
      brand: "feishu",
      appId: "cli_test_app",
      appSecret: "s",
      ingress: "long_connection",
    };
    expect(feishuSetupProblems(ok)).toEqual([]);
    expect(feishuSetupProblems({ ...ok, ingress: "webhook" })).toContain(
      "webhook ingress requires encryptKey",
    );
    expect(
      feishuSetupProblems({ ...ok, ingress: "webhook", encryptKey: "k" }),
    ).toEqual([]);
    expect(feishuSetupProblems({ ...ok, appId: "app_1" })).toContain(
      "appId must start with cli_",
    );
    expect(feishuSetupProblems({ ...ok, kind: "marketplace" })).toContain(
      "kind must be self_built",
    );
  });

  it("reads the bot behind pasted credentials", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal")
        return {
          status: 200,
          body: { code: 0, tenant_access_token: "t-1", expire: 7200 },
        };
      if (url.pathname === "/open-apis/bot/v3/info")
        return {
          status: 200,
          body: {
            code: 0,
            bot: {
              app_name: "OMA Bot",
              open_id: "ou_bot",
              activate_status: 2,
            },
          },
        };
      return { status: 404 };
    });
    const info = await run(
      inspectFeishuApp({
        baseUrl: FEISHU,
        appId: "cli_test_app",
        appSecret: "test-secret",
        fetch: impl,
      }),
    );
    expect(info).toEqual({
      providerInstallationId: "cli_test_app",
      accountLogin: "OMA Bot",
      botOpenId: "ou_bot",
    });
    expect(
      (calls[1]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer t-1");
  });

  const config: ProviderAppConfig = {
    id: "fs",
    provider: "feishu",
    baseUrl: FEISHU,
    linkMethodPolicy: "oauth_only",
    principalPolicy: "user",
    allowedScopes: [],
    identityBinding: { kind: "none" },
    allowUserPrincipalOutput: false,
  };

  it("lists the chats the bot is in, page by page", async () => {
    const { impl, calls } = fakeFetch((url) => {
      const token = url.searchParams.get("page_token");
      return token === null
        ? {
            status: 200,
            body: {
              code: 0,
              data: {
                items: [
                  { chat_id: "oc_a", name: "Frontend" },
                  { chat_id: "oc_b", name: "Ops" },
                ],
                has_more: true,
                page_token: "p2",
              },
            },
          }
        : {
            status: 200,
            body: {
              code: 0,
              data: {
                items: [{ chat_id: "oc_c", name: "Release" }],
                has_more: false,
              },
            },
          };
    });
    const catalog = makeFeishuResourceCatalog({ fetch: impl });
    const first = await run(catalog.list({ config, token: "t-1", limit: 2 }));
    expect(first).toEqual({
      items: [
        { id: "chat:oc_a", kind: "chat", title: "Frontend" },
        { id: "chat:oc_b", kind: "chat", title: "Ops" },
      ],
      nextCursor: "p2",
    });
    expect(calls[0]!.url).toBe(
      "https://open.feishu.cn/open-apis/im/v1/chats?page_size=2",
    );
    const second = await run(
      catalog.list({ config, token: "t-1", cursor: "p2" }),
    );
    expect(second.nextCursor).toBeUndefined();
    const filtered = await run(
      catalog.list({ config, token: "t-1", query: "front" }),
    );
    expect(filtered.items.map((i) => i.id)).toEqual(["chat:oc_a"]);
  });

  it("validates a chat and reports one the bot cannot see", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname.endsWith("/oc_a")
        ? { status: 200, body: { code: 0, data: { name: "Frontend" } } }
        : { status: 400, body: { code: 232011, msg: "not in chat" } },
    );
    const catalog = makeFeishuResourceCatalog({ fetch: impl });
    expect(
      await run(
        catalog.validate({
          config,
          token: "t-1",
          resource: "chat:oc_a",
          operations: ["im_read", "im_send"],
        }),
      ),
    ).toEqual({
      ok: true,
      resource: { id: "chat:oc_a", kind: "chat", title: "Frontend" },
    });
    const missing = await run(
      catalog.validate({
        config,
        token: "t-1",
        resource: "chat:oc_b",
        operations: ["im_read"],
      }),
    );
    expect(missing).toMatchObject({ ok: false, reason: "not_found" });
    const malformed = await run(
      catalog.validate({
        config,
        token: "t-1",
        resource: "chat:bad id",
        operations: ["im_read"],
      }),
    );
    expect(malformed).toMatchObject({ ok: false, reason: "malformed_id" });
    expect(calls).toHaveLength(2);
  });
});
