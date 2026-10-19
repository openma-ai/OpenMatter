import { gunzipSync } from "node:zlib";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  SELF_MANAGE_SCOPE,
  beginFeishuAppRegistration,
  checkFeishuAppSetup,
  encodeFeishuAddons,
  feishuAgentSetup,
  feishuScopeApplyUrl,
  pollFeishuAppRegistration,
  type FeishuAppAddons,
} from "../packages/feishu/src/bond/index.js";

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
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
};
const form = (init: RequestInit) =>
  Object.fromEntries(new URLSearchParams(String(init.body)));

/** The platform's decoding: URL-safe base64 back to gzip, then JSON. */
const decode = (encoded: string): unknown =>
  JSON.parse(
    gunzipSync(
      Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    ).toString("utf8"),
  );

const BEGIN = {
  device_code: "dc-test",
  user_code: "UC-TEST",
  verification_uri: "https://open.feishu.cn/page/launcher",
  verification_uri_complete:
    "https://open.feishu.cn/page/launcher?user_code=UC-TEST",
  expires_in: 300,
  interval: 3,
};

describe("one-click Feishu app registration", () => {
  it("encodes addons as gzip JSON in URL-safe base64 without padding", async () => {
    const addons: FeishuAppAddons = {
      scopes: { tenant: ["im:message"], user: ["docx:document:readonly"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
      callbacks: { items: ["card.action.trigger"] },
    };
    const encoded = await run(encodeFeishuAddons(addons));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decode(encoded)).toEqual(addons);
  });

  it("rejects addons the confirmation page would silently drop", async () => {
    const bad: unknown[] = [
      { scopes: { tenant: ["im:message"] }, security: {} },
      { scopes: { tenants: ["im:message"] } },
      { events: { items: { tenant: [""] } } },
      { preset: "false", scopes: { tenant: ["im:message"] } },
      { scopes: { tenant: [] } },
    ];
    for (const addons of bad) {
      const error = await fail(encodeFeishuAddons(addons as FeishuAppAddons));
      expect(error.rejected).toBe(false);
    }
    // An empty payload is meaningful only as the minimal base template.
    expect(decode(await run(encodeFeishuAddons({ preset: false })))).toEqual({
      preset: false,
    });
  });

  it("begins a registration and builds the confirmation link", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: BEGIN }));
    const setup = feishuAgentSetup();
    const registration = await run(
      beginFeishuAppRegistration({
        name: "OMA bot",
        description: "Answers in Feishu",
        avatars: ["https://example.com/a.png", "https://example.com/b.png"],
        addons: setup.addons,
        appId: "cli_existing",
        source: "oma",
        fetch: impl,
        clock: () => "2026-10-16T00:00:00.000Z",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.toString()).toBe(
      "https://accounts.feishu.cn/oauth/v1/app/registration",
    );
    expect(form(calls[0]!.init)).toEqual({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    });
    expect(registration).toMatchObject({
      deviceCode: "dc-test",
      expiresAt: "2026-10-16T00:05:00.000Z",
      interval: 3,
      brand: "feishu",
    });
    const url = new URL(registration.url);
    expect(url.origin + url.pathname).toBe(
      "https://open.feishu.cn/page/launcher",
    );
    expect(url.searchParams.get("user_code")).toBe("UC-TEST");
    expect(url.searchParams.get("source")).toBe("openmatter/oma");
    expect(url.searchParams.get("tp")).toBe("sdk");
    expect(url.searchParams.getAll("avatar")).toHaveLength(2);
    expect(url.searchParams.get("name")).toBe("OMA bot");
    expect(url.searchParams.get("desc")).toBe("Answers in Feishu");
    expect(url.searchParams.get("clientID")).toBe("cli_existing");
    expect(url.searchParams.has("createOnly")).toBe(false);
    expect(decode(url.searchParams.get("addons")!)).toEqual(setup.addons);
  });

  it("uses the Lark origin and defaults when asked", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        device_code: "dc",
        verification_uri_complete: "https://open.larksuite.com/page/x",
      },
    }));
    const registration = await run(
      beginFeishuAppRegistration({
        brand: "lark",
        createOnly: true,
        fetch: impl,
        clock: () => "2026-10-16T00:00:00.000Z",
      }),
    );
    expect(calls[0]!.url.origin).toBe("https://accounts.larksuite.com");
    expect(registration.expiresAt).toBe("2026-10-16T00:10:00.000Z");
    expect(registration.interval).toBe(5);
    expect(new URL(registration.url).searchParams.get("createOnly")).toBe(
      "true",
    );
    expect(new URL(registration.url).searchParams.has("addons")).toBe(false);
  });

  it("refuses bad input before any request and a bad begin answer after", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: BEGIN }));
    await fail(
      beginFeishuAppRegistration({ appId: "not-an-app", fetch: impl }),
    );
    await fail(beginFeishuAppRegistration({ avatars: [], fetch: impl }));
    await fail(
      beginFeishuAppRegistration({
        avatars: Array(7).fill("https://example.com/a.png"),
        fetch: impl,
      }),
    );
    await fail(
      beginFeishuAppRegistration({
        addons: { scopes: { tenant: [] } },
        fetch: impl,
      }),
    );
    expect(calls).toHaveLength(0);
    const insecure = fakeFetch(() => ({
      status: 200,
      body: {
        ...BEGIN,
        verification_uri_complete: "http://open.feishu.cn/page/x",
      },
    }));
    await fail(beginFeishuAppRegistration({ fetch: insecure.impl }));
    const broken = fakeFetch(() => ({
      status: 500,
      body: { error: "server_error" },
    }));
    expect(
      (await fail(beginFeishuAppRegistration({ fetch: broken.impl }))).status,
    ).toBe(500);
  });

  it("polls through pending and slow_down to the new app's credentials", async () => {
    const answers: { status: number; body: unknown }[] = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: {
          client_id: "cli_new",
          client_secret: "new-secret",
          user_info: { open_id: "ou_confirmer", tenant_brand: "feishu" },
        },
      },
    ];
    const { impl, calls } = fakeFetch(() => answers.shift()!);
    const poll = (interval: number) =>
      run(
        pollFeishuAppRegistration({
          deviceCode: "dc-test",
          interval,
          brand: "feishu",
          fetch: impl,
        }),
      );
    expect(await poll(5)).toEqual({
      status: "pending",
      interval: 5,
      brand: "feishu",
    });
    expect(await poll(58)).toEqual({
      status: "slow_down",
      interval: 60,
      brand: "feishu",
    });
    expect(await poll(60)).toEqual({
      status: "registered",
      appId: "cli_new",
      appSecret: "new-secret",
      brand: "feishu",
      openId: "ou_confirmer",
    });
    expect(form(calls[0]!.init)).toEqual({
      action: "poll",
      device_code: "dc-test",
    });
  });

  it("switches to the Lark origin once when the tenant is Lark", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.origin === "https://accounts.feishu.cn"
        ? {
            status: 400,
            body: {
              error: "authorization_pending",
              user_info: { tenant_brand: "lark" },
            },
          }
        : { status: 200, body: { client_id: "cli_lark", client_secret: "s" } },
    );
    expect(
      await run(
        pollFeishuAppRegistration({
          deviceCode: "dc",
          interval: 5,
          brand: "feishu",
          fetch: impl,
        }),
      ),
    ).toEqual({
      status: "registered",
      appId: "cli_lark",
      appSecret: "s",
      brand: "lark",
    });
    expect(calls.map((c) => c.url.origin)).toEqual([
      "https://accounts.feishu.cn",
      "https://accounts.larksuite.com",
    ]);
    // Once on Lark, a Lark answer never switches again.
    const pending = fakeFetch(() => ({
      status: 400,
      body: {
        error: "authorization_pending",
        user_info: { tenant_brand: "lark" },
      },
    }));
    expect(
      await run(
        pollFeishuAppRegistration({
          deviceCode: "dc",
          interval: 5,
          brand: "lark",
          fetch: pending.impl,
        }),
      ),
    ).toEqual({ status: "pending", interval: 5, brand: "lark" });
    expect(pending.calls).toHaveLength(1);
  });

  it("ends on denial and expiry and fails on anything else", async () => {
    for (const [error, status] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      const { impl } = fakeFetch(() => ({ status: 400, body: { error } }));
      expect(
        await run(
          pollFeishuAppRegistration({
            deviceCode: "dc",
            interval: 5,
            brand: "feishu",
            fetch: impl,
          }),
        ),
      ).toEqual({ status });
    }
    const { impl } = fakeFetch(() => ({
      status: 400,
      body: { error: "invalid_request" },
    }));
    const error = await fail(
      pollFeishuAppRegistration({
        deviceCode: "dc",
        interval: 5,
        brand: "feishu",
        fetch: impl,
      }),
    );
    expect(error.message).toContain("invalid_request");
    expect(error.message).not.toContain("dc");
  });
});

describe("Feishu app setup check", () => {
  const { requirements } = feishuAgentSetup();
  const app = (impl: typeof fetch, baseUrl = "https://open.feishu.cn") => ({
    baseUrl,
    appId: "cli_test_app",
    appSecret: "test-secret",
    fetch: impl,
    clock: () => "2026-10-16T00:00:00.000Z",
  });
  const tenantToken = {
    status: 200,
    body: { code: 0, tenant_access_token: "t-test", expire: 7200 },
  };
  const ok = (data: unknown) => ({ status: 200, body: { code: 0, data } });

  const server =
    (options: {
      granted: readonly string[];
      versionId?: string;
      events?: readonly string[];
      bot?: boolean;
      appForbidden?: boolean;
    }): Handler =>
    (url) => {
      const path = url.pathname;
      if (path === "/open-apis/auth/v3/tenant_access_token/internal")
        return tenantToken;
      if (path === "/open-apis/application/v6/scopes") {
        return ok({
          scopes: [
            ...options.granted.map((scope_name) => ({
              scope_name,
              grant_status: 1,
            })),
            { scope_name: "im:message.group_msg", grant_status: 2 },
          ],
        });
      }
      if (path === "/open-apis/application/v6/applications/cli_test_app") {
        return options.appForbidden
          ? { status: 400, body: { code: 99991672, msg: "no permission" } }
          : ok({
              app: {
                app_id: "cli_test_app",
                online_version_id: options.versionId ?? "",
              },
            });
      }
      if (
        path ===
        `/open-apis/application/v6/applications/cli_test_app/app_versions/${options.versionId}`
      ) {
        return ok({
          app_version: {
            events: options.events ?? [],
            ability: options.bot ? { bot: { card_request_url: "" } } : {},
          },
        });
      }
      if (path === "/open-apis/bot/v3/info") {
        return options.bot
          ? { status: 200, body: { code: 0, bot: { open_id: "ou_bot" } } }
          : { status: 400, body: { code: 10003 } };
      }
      return { status: 404 };
    };

  it("reports ready when scopes are granted and events and bot are published", async () => {
    const { impl, calls } = fakeFetch(
      server({
        granted: requirements.scopes,
        versionId: "oav_1",
        events: requirements.events,
        bot: true,
      }),
    );
    expect(await run(checkFeishuAppSetup(app(impl), requirements))).toEqual({
      ready: true,
      bot: true,
      missingScopes: [],
      missingEvents: [],
      problems: [],
    });
    const auth = calls
      .filter((c) => c.url.pathname.startsWith("/open-apis/application"))
      .map((c) => new Headers(c.init.headers).get("authorization"));
    expect(auth.every((a) => a === "Bearer t-test")).toBe(true);
  });

  it("lists missing scopes, events, and the bot ability as fixes", async () => {
    const { impl } = fakeFetch(
      server({
        granted: ["im:message", SELF_MANAGE_SCOPE],
        versionId: "oav_1",
        events: ["im.message.receive_v1"],
      }),
    );
    const report = await run(checkFeishuAppSetup(app(impl), requirements));
    expect(report.ready).toBe(false);
    expect(report.bot).toBe(false);
    expect(report.missingScopes).toEqual([
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:resource",
    ]);
    expect(report.missingEvents).toEqual(["im.message.recalled_v1"]);
    expect(report.problems).toHaveLength(3);
    expect(report.links).toEqual({
      scopes:
        "https://open.feishu.cn/app/cli_test_app/auth?q=" +
        "im%3Amessage.group_at_msg%3Areadonly%2Cim%3Amessage.p2p_msg%3Areadonly" +
        "%2Cim%3Amessage%3Asend_as_bot%2Cim%3Aresource" +
        "&op_from=openapi&token_type=tenant",
      events: "https://open.feishu.cn/app/cli_test_app/event",
      bot: "https://open.feishu.cn/app/cli_test_app/bot",
      publish: "https://open.feishu.cn/app/cli_test_app/version",
    });
  });

  it("links only the console pages for the problems found, on the app's brand", async () => {
    // Lark, one missing scope, events and bot fine.
    const { impl } = fakeFetch(
      server({
        granted: requirements.scopes.filter((s) => s !== "im:resource"),
        versionId: "oav_1",
        events: requirements.events,
        bot: true,
      }),
    );
    const report = await run(
      checkFeishuAppSetup(
        app(impl, "https://open.larksuite.com"),
        requirements,
      ),
    );
    expect(report.missingScopes).toEqual(["im:resource"]);
    expect(report.links).toEqual({
      scopes:
        "https://open.larksuite.com/app/cli_test_app/auth?q=im%3Aresource" +
        "&op_from=openapi&token_type=tenant",
      publish: "https://open.larksuite.com/app/cli_test_app/version",
    });

    // Only the bot ability is missing.
    const noBot = fakeFetch(
      server({
        granted: requirements.scopes,
        versionId: "oav_1",
        events: requirements.events,
        bot: false,
      }),
    );
    expect(
      (await run(checkFeishuAppSetup(app(noBot.impl), requirements))).links,
    ).toEqual({
      bot: "https://open.feishu.cn/app/cli_test_app/bot",
      publish: "https://open.feishu.cn/app/cli_test_app/version",
    });

    // The accounts origin selects the same console; other hosts are refused.
    expect(
      feishuScopeApplyUrl({
        baseUrl: "https://accounts.larksuite.com",
        appId: "cli_x",
        scopes: ["im:resource", "im:message"],
      }),
    ).toBe(
      "https://open.larksuite.com/app/cli_x/auth?q=im%3Aresource%2Cim%3Amessage&op_from=openapi&token_type=tenant",
    );
    expect(() =>
      feishuScopeApplyUrl({
        baseUrl: "https://example.com",
        appId: "cli_x",
        scopes: [],
      }),
    ).toThrow();
  });

  it("reports events as unknown when the version cannot be read", async () => {
    const forbidden = fakeFetch(
      server({
        granted: requirements.scopes.filter((s) => s !== SELF_MANAGE_SCOPE),
        bot: true,
        appForbidden: true,
      }),
    );
    const report = await run(
      checkFeishuAppSetup(app(forbidden.impl), requirements),
    );
    expect(report).toMatchObject({
      ready: false,
      bot: true,
      missingScopes: [SELF_MANAGE_SCOPE],
    });
    expect(report.missingEvents).toBeUndefined();
    expect(report.problems.at(-1)).toContain(SELF_MANAGE_SCOPE);

    const unpublished = fakeFetch(
      server({ granted: requirements.scopes, bot: false }),
    );
    const draft = await run(
      checkFeishuAppSetup(app(unpublished.impl), requirements),
    );
    expect(draft.missingEvents).toBeUndefined();
    expect(draft.problems).toContain("Publish a version of the app.");
  });

  it("asks for im:resource so the bot can download message images", () => {
    expect(feishuAgentSetup().requirements.scopes).toContain("im:resource");
    expect(feishuAgentSetup().addons.scopes?.tenant).toContain("im:resource");
  });

  it("asks for the read-all-group-messages scope only when chosen", () => {
    expect(feishuAgentSetup().requirements.scopes).not.toContain(
      "im:message.group_msg",
    );
    expect(
      feishuAgentSetup({ allGroupMessages: true }).requirements.scopes,
    ).toContain("im:message.group_msg");
  });
});
