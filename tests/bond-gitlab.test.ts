import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  makeBond,
  makeMemoryBondStore,
  type ProviderAppConfig,
} from "../packages/bond/src/index.js";
import {
  assistedByTrailer,
  authorizationUrl,
  canonicalOrigin,
  classifyGitLabRequest,
  coAuthoredByTrailer,
  commitAuthor,
  createPkce,
  discoverInstance,
  evaluatePush,
  exchangeCode,
  makeGitLabBondProvider,
  mergeRequestFooter,
  mergeRequestPushOptions,
  parseReceivePackHead,
  readTokenInfo,
  readUser,
  refreshAccessToken,
  validateBotCredential,
  validatePersonalAccessToken,
  type GitLabTokenInfo,
  type GitLabUser,
  type PushPolicy,
  type ReceivePackHead,
} from "../packages/bond-gitlab/src/index.js";

const ORIGIN = "https://gitlab.example.com";
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

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

describe("GitLab instance and OAuth", () => {
  it("normalizes origins and rejects unsafe instance URLs", () => {
    expect(canonicalOrigin("https://GitLab.Example.com/")).toBe(ORIGIN);
    expect(() => canonicalOrigin("http://gitlab.example.com")).toThrow("https");
    expect(() => canonicalOrigin("https://gitlab.example.com/group")).toThrow(
      "path",
    );
    expect(() => canonicalOrigin("https://u:p@gitlab.example.com")).toThrow();
    expect(canonicalOrigin("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  const discovery = (over: Record<string, unknown> = {}) => ({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    revocation_endpoint: `${ORIGIN}/oauth/revoke`,
    code_challenge_methods_supported: ["plain", "S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    ...over,
  });

  it("discovers an instance and records that device flow is absent", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: discovery() }));
    const instance = await run(discoverInstance(ORIGIN, impl));
    expect(instance.tokenEndpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(instance.deviceAuthorizationEndpoint).toBeUndefined();
  });

  it("rejects an instance without PKCE S256, refresh tokens, or a matching issuer", async () => {
    const attempt = async (over: Record<string, unknown>) => {
      const { impl } = fakeFetch(() => ({
        status: 200,
        body: discovery(over),
      }));
      const r = await run(Effect.either(discoverInstance(ORIGIN, impl)));
      return Either.isLeft(r) ? r.left.message : "ok";
    };
    expect(
      await attempt({ code_challenge_methods_supported: ["plain"] }),
    ).toContain("S256");
    expect(
      await attempt({ grant_types_supported: ["authorization_code"] }),
    ).toContain("refresh_token");
    expect(await attempt({ issuer: "https://evil.example" })).toContain(
      "issuer",
    );
  });

  it("builds a PKCE authorization URL", async () => {
    const pkce = await run(createPkce());
    expect(pkce.verifier).toMatch(/^[\w-]{43,128}$/);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(pkce.verifier),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(pkce.challenge);
    const url = new URL(
      authorizationUrl({
        origin: ORIGIN,
        clientId: "cid",
        redirectUri: "https://oma.example/cb",
        scopes: ["read_user", "write_repository"],
        state: "s1",
        codeChallenge: pkce.challenge,
      }),
    );
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("read_user write_repository");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code and computes expiry from created_at and expires_in", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 7200,
        created_at: 1_800_000_000,
        scope: "read_user write_repository",
      },
    }));
    const grant = await run(
      exchangeCode(
        { origin: ORIGIN, clientId: "cid", clientSecret: "sec", fetch: impl },
        { code: "c", redirectUri: "https://oma.example/cb", codeVerifier: "v" },
      ),
    );
    expect(grant).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: new Date((1_800_000_000 + 7200) * 1000).toISOString(),
      scopes: ["read_user", "write_repository"],
    });
    expect(formBody(calls[0]!.init)).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: "v",
      client_secret: "sec",
    });
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("marks invalid_grant on refresh as a rejected grant", async () => {
    const { impl } = fakeFetch(() => ({
      status: 400,
      body: { error: "invalid_grant" },
    }));
    const r = await run(
      Effect.either(
        refreshAccessToken(
          { origin: ORIGIN, clientId: "cid", fetch: impl },
          "old",
        ),
      ),
    );
    expect(Either.isLeft(r) && r.left.rejected).toBe(true);
    expect(Either.isLeft(r) && r.left.message).toContain("invalid_grant");
    const down = fakeFetch(() => ({ status: 502 }));
    const r2 = await run(
      Effect.either(
        refreshAccessToken(
          { origin: ORIGIN, clientId: "cid", fetch: down.impl },
          "old",
        ),
      ),
    );
    expect(Either.isLeft(r2) && r2.left.rejected).toBe(false);
  });
});

describe("GitLab token and user validation", () => {
  const now = "2026-10-12T00:00:00.000Z";
  const policy = {
    allowedScopes: ["read_user", "read_api", "write_repository"],
    maxLifetimeDays: 90,
    now,
  };
  const info = (over: Partial<GitLabTokenInfo> = {}): GitLabTokenInfo => ({
    id: "1",
    name: "openma",
    active: true,
    revoked: false,
    scopes: ["read_user", "write_repository"],
    expiresAt: "2026-11-01",
    userId: "42",
    ...over,
  });
  const human: GitLabUser = {
    id: "42",
    username: "alice",
    name: "Alice",
    commitEmail: "alice@example.com",
    bot: false,
    identities: [],
  };
  const bot: GitLabUser = {
    ...human,
    id: "2402",
    username: "project_1_bot_x",
    bot: true,
  };

  it("reads the user and token metadata", async () => {
    const { impl } = fakeFetch((url) =>
      url.pathname === "/api/v4/user"
        ? {
            status: 200,
            body: {
              id: 42,
              username: "alice",
              name: "Alice",
              commit_email: "alice@example.com",
              bot: false,
              identities: [{ provider: "corp", extern_uid: "alice@corp" }],
            },
          }
        : {
            status: 200,
            body: {
              id: 7,
              name: "t",
              active: true,
              revoked: false,
              scopes: ["read_user"],
              expires_at: "2026-11-01",
              user_id: 42,
            },
          },
    );
    expect(await run(readUser(ORIGIN, "t", impl))).toEqual({
      id: "42",
      username: "alice",
      name: "Alice",
      commitEmail: "alice@example.com",
      bot: false,
      identities: [{ provider: "corp", externUid: "alice@corp" }],
    });
    expect((await run(readTokenInfo(ORIGIN, "t", impl))).expiresAt).toBe(
      "2026-11-01",
    );
  });

  it("accepts a bounded personal access token and lists every problem otherwise", () => {
    expect(validatePersonalAccessToken(info(), human, policy)).toEqual([]);
    const { expiresAt: _e, ...noExpiry } = info();
    expect(validatePersonalAccessToken(noExpiry, human, policy)).toEqual([
      "no_expiry",
    ]);
    expect(
      validatePersonalAccessToken(info({ scopes: ["api"] }), human, policy),
    ).toEqual(["scope_not_allowed"]);
    expect(
      validatePersonalAccessToken(
        info({ expiresAt: "2027-06-01" }),
        human,
        policy,
      ),
    ).toEqual(["lifetime_exceeded"]);
    expect(
      validatePersonalAccessToken(
        info({ expiresAt: "2026-10-11" }),
        human,
        policy,
      ),
    ).toEqual(["expired"]);
    expect(
      validatePersonalAccessToken(
        info({ active: false, revoked: true }),
        human,
        policy,
      ),
    ).toEqual(["revoked", "inactive"]);
    expect(validatePersonalAccessToken(info(), bot, policy)).toEqual([
      "is_a_bot",
    ]);
  });

  it("accepts only bot users as an app credential", () => {
    expect(validateBotCredential(info(), bot, policy)).toEqual([]);
    expect(validateBotCredential(info(), human, policy)).toEqual(["not_a_bot"]);
  });
});

describe("classifyGitLabRequest", () => {
  const c = (method: string, path: string) =>
    classifyGitLabRequest(method, `${ORIGIN}${path}`);

  it("normalizes git project paths across case and .git", () => {
    const a = c(
      "GET",
      "/Data/Managed-Agents.git/info/refs?service=git-upload-pack",
    );
    const b = c(
      "GET",
      "/data/managed-agents/info/refs?service=git-upload-pack",
    );
    expect(a).toEqual({
      allow: true,
      projectRef: { kind: "path", path: "data/managed-agents" },
      operation: "fetch",
      surface: "git",
    });
    expect(b).toEqual(a);
    expect(
      c("POST", "/data/managed-agents.git/git-receive-pack"),
    ).toMatchObject({ allow: true, operation: "push" });
  });

  it("treats numeric and encoded REST project references as references", () => {
    expect(c("GET", "/api/v4/projects/42")).toMatchObject({
      allow: true,
      projectRef: { kind: "id", id: 42 },
      operation: "read",
    });
    expect(
      c("POST", "/api/v4/projects/data%2FManaged-Agents/merge_requests"),
    ).toMatchObject({
      allow: true,
      projectRef: { kind: "path", path: "data/managed-agents" },
      operation: "open_mr",
    });
    expect(
      c("POST", "/api/v4/projects/42/merge_requests/3/notes"),
    ).toMatchObject({ allow: true, operation: "comment_mr" });
  });

  it("denies GraphQL, LFS, wrong methods, unknown services, and other REST", () => {
    for (const [m, p] of [
      ["POST", "/api/graphql"],
      ["POST", "/data/managed-agents.git/info/lfs/objects/batch"],
      ["POST", "/data/managed-agents.git/info/refs?service=git-upload-pack"],
      ["GET", "/data/managed-agents.git/info/refs?service=git-upload-archive"],
      ["DELETE", "/api/v4/projects/42"],
      ["PUT", "/api/v4/projects/42/merge_requests/3"],
      ["GET", "/api/v4/user"],
      ["GET", "/api/v4/projects/42/repository/files/a"],
      ["GET", "/-/archive/main.zip"],
    ] as const) {
      expect(c(m, p), `${m} ${p}`).toMatchObject({ allow: false });
    }
    // URL parsing already resolves literal "..". Decoded traversal is denied.
    expect(c("GET", "/api/v4/projects/data%2F..%2Fother")).toMatchObject({
      allow: false,
    });
  });
});

const pkt = (line: string) => {
  const body = new TextEncoder().encode(line);
  return [(body.length + 4).toString(16).padStart(4, "0"), line].join("");
};
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ZERO = "0".repeat(40);
const head = (commands: string[], options: string[] = []) => {
  const [first, ...rest] = commands;
  const caps =
    options.length > 0 ? "report-status push-options" : "report-status";
  return new TextEncoder().encode(
    [
      pkt(`${first}\0${caps}\n`),
      ...rest.map((r) => pkt(`${r}\n`)),
      "0000",
      ...(options.length > 0
        ? [...options.map((o) => pkt(`${o}\n`)), "0000"]
        : []),
      "PACK...",
    ].join(""),
  );
};

describe("receive-pack head and push policy", () => {
  const policy: PushPolicy = {
    defaultBranch: "main",
    requiredMergeRequestLabel: "openma",
    allowMergeRequestOptions: true,
  };
  const parse = (bytes: Uint8Array): ReceivePackHead => {
    const r = parseReceivePackHead(bytes);
    if (r._tag !== "Complete") throw new Error(r._tag);
    return r.head;
  };

  it("parses commands, capabilities, and push options without reading the pack", () => {
    const bytes = head(
      [`${OLD} ${NEW} refs/heads/feature`],
      ["merge_request.create", "merge_request.label=openma"],
    );
    const h = parse(bytes);
    expect(h.commands).toEqual([
      { oldId: OLD, newId: NEW, ref: "refs/heads/feature" },
    ]);
    expect(h.capabilities).toContain("push-options");
    expect(h.options).toEqual([
      "merge_request.create",
      "merge_request.label=openma",
    ]);
    expect(new TextDecoder().decode(bytes.subarray(h.headLength))).toBe(
      "PACK...",
    );
  });

  it("asks for more bytes until the head is complete and rejects malformed input", () => {
    const bytes = head([`${OLD} ${NEW} refs/heads/feature`]);
    expect(parseReceivePackHead(bytes.subarray(0, 10))._tag).toBe("Incomplete");
    expect(parseReceivePackHead(new TextEncoder().encode("zzzz"))._tag).toBe(
      "Malformed",
    );
    expect(
      parseReceivePackHead(
        new TextEncoder().encode(pkt("not a command\n") + "0000"),
      )._tag,
    ).toBe("Malformed");
  });

  it("allows a labelled merge request push to a feature branch", () => {
    const h = parse(
      head(
        [`${OLD} ${NEW} refs/heads/feature`],
        mergeRequestPushOptions({
          target: "main",
          title: "T",
          description: "line one\nline two",
          label: "openma",
        }).slice(),
      ),
    );
    expect(evaluatePush(h, policy)).toBeUndefined();
    expect(h.options).toContain("merge_request.description=line one line two");
  });

  it("denies tags, deletions, the default branch, unknown options, and unlabelled merge requests", () => {
    const reason = (cmds: string[], opts: string[] = [], p = policy) =>
      evaluatePush(parse(head(cmds, opts)), p);
    expect(reason([`${ZERO} ${NEW} refs/tags/v1`])).toContain("not a branch");
    expect(reason([`${OLD} ${ZERO} refs/heads/feature`])).toContain("deleting");
    expect(reason([`${OLD} ${NEW} refs/heads/main`])).toContain(
      "default branch",
    );
    expect(reason([`${OLD} ${NEW} refs/heads/feature`], ["ci.skip"])).toContain(
      "ci.skip",
    );
    expect(
      reason([`${OLD} ${NEW} refs/heads/feature`], ["merge_request.create"]),
    ).toContain("label=openma");
    expect(
      reason(
        [`${OLD} ${NEW} refs/heads/feature`],
        ["merge_request.create", "merge_request.label=openma"],
        { ...policy, allowMergeRequestOptions: false },
      ),
    ).toContain("not allowed");
    expect(
      reason([`${OLD} ${NEW} refs/heads/x`], [], {
        ...policy,
        branchPrefix: "openma/",
      }),
    ).toContain("outside");
  });
});

describe("attribution", () => {
  it("formats author, trailers, and footers", () => {
    expect(
      commitAuthor({
        name: "Alice",
        username: "alice",
        commitEmail: "a@example.com",
      }),
    ).toEqual({ name: "Alice", email: "a@example.com" });
    expect(() => commitAuthor({ name: "A", username: "a" })).toThrow(
      "commit email",
    );
    expect(assistedByTrailer("OpenMA", "https://oma/s/1")).toBe(
      "Assisted-by: OpenMA <https://oma/s/1>",
    );
    expect(coAuthoredByTrailer({ name: "Alice", email: "a@example.com" })).toBe(
      "Co-authored-by: Alice <a@example.com>",
    );
    expect(
      mergeRequestFooter({
        appName: "OpenMA",
        sessionUrl: "https://oma/s/1",
        requestedBy: "alice",
      }),
    ).toContain("Requested by @alice via OpenMA");
  });
});

describe("GitLab BondProvider with the Bond kernel", () => {
  it("refreshes through /oauth/token and revokes OAuth and PAT links the GitLab way", async () => {
    let now = Date.parse("2026-10-12T00:00:00.000Z");
    let issued = 0;
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.pathname === "/oauth/token") {
        issued++;
        const body = formBody(init);
        expect(body.grant_type).toBe("refresh_token");
        expect(body.client_secret).toBe("resolved-secret");
        return {
          status: 200,
          body: {
            access_token: `at-${issued}`,
            refresh_token: `rt-${issued}`,
            expires_in: 7200,
            created_at: Math.floor(now / 1000),
          },
        };
      }
      if (url.pathname === "/oauth/revoke") return { status: 200, body: {} };
      if (url.pathname === "/api/v4/personal_access_tokens/self")
        return { status: 204 };
      return { status: 404 };
    });
    const config: ProviderAppConfig = {
      id: "gl",
      provider: "gitlab",
      baseUrl: ORIGIN,
      linkMethodPolicy: "oauth_preferred",
      principalPolicy: "user_only",
      allowedScopes: ["read_user", "write_repository"],
      identityBinding: { kind: "none" },
      allowUserPrincipalOutput: true,
      oauth: { clientId: "cid", clientSecret: { ref: "vault:gl" } },
    };
    const clock = () => new Date(now).toISOString();
    const bond = makeBond({
      providerApps: {
        get: (id) =>
          id === "gl"
            ? Effect.succeed(config)
            : Effect.fail(new ConfigError({ message: "x", providerAppId: id })),
      },
      store: makeMemoryBondStore({ nowMs: () => now }),
      cipher: {
        seal: (p) => Effect.succeed({ keyId: "k", ciphertext: p }),
        open: (s) => Effect.succeed(s.ciphertext),
      },
      providers: {
        gitlab: makeGitLabBondProvider({
          fetch: impl,
          clock,
          resolveSecret: () => Effect.succeed("resolved-secret"),
        }),
      },
      clock,
    });
    const link = await run(
      bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "oauth",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "at-0",
          refreshToken: "rt-0",
          accessExpiresAt: new Date(now + 7200_000).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    now += 7200_000;
    const { credential } = await run(
      bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { tenantId: "t1", runAs: "requester", requesterId: "u1" },
        access: "write",
      }),
    );
    expect(credential.token).toBe("at-1");
    await run(
      bond.unlink({
        tenantId: "t1",
        linkId: link.id,
        actor: "u1",
        reason: "unlink",
      }),
    );
    const revoke = calls.find((c) => c.url.endsWith("/oauth/revoke"));
    expect(formBody(revoke!.init).token).toBe("at-1");

    await run(
      bond.link({
        tenantId: "t1",
        appUserId: "u1",
        providerAppId: "gl",
        method: "pat",
        providerUser: { id: "42", login: "alice" },
        grant: {
          accessToken: "glpat-1",
          accessExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
          scopes: ["read_user"],
        },
        actor: "u1",
      }),
    );
    const patLink = await run(
      bond.credential({
        tenantId: "t1",
        providerAppId: "gl",
        principal: { tenantId: "t1", runAs: "requester", requesterId: "u1" },
        access: "read",
      }),
    );
    await run(
      bond.unlink({
        tenantId: "t1",
        linkId:
          patLink.resolution.principal.kind === "user"
            ? patLink.resolution.principal.userLinkId
            : "",
        actor: "u1",
        reason: "unlink",
      }),
    );
    const del = calls.find((c) =>
      c.url.endsWith("/personal_access_tokens/self"),
    );
    expect(del?.init.method).toBe("DELETE");
    expect((del?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer glpat-1",
    );
  });
});
