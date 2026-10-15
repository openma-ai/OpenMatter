import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ProviderError,
  makeBond,
  manifestProblems,
  makeMemoryBondStore,
  type ProviderAppConfig,
} from "../packages/matter/src/bond/index.js";
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
  isValidRefName,
  gitlabManifest,
  makeGitLabBinding,
  makeGitLabBondProvider,
  makeGitLabResourceCatalog,
  makeReceivePackHeadParser,
  mergeRequestBodyProblem,
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
} from "../packages/gitlab/src/bond/index.js";

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
    expect(instance).toEqual({ origin: ORIGIN, deviceFlow: false });
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
    expect(
      validatePersonalAccessToken(info({ userId: "2402" }), bot, policy),
    ).toEqual(["is_a_bot"]);
    // Token metadata and user from two different tokens prove nothing.
    expect(validatePersonalAccessToken(info(), bot, policy)).toEqual([
      "user_mismatch",
      "is_a_bot",
    ]);
  });

  it("accepts only bot users as an app credential", () => {
    expect(
      validateBotCredential(info({ userId: "2402" }), bot, policy),
    ).toEqual([]);
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
        get: ({ providerAppId: id }) =>
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
        principal: {
          tenantId: "t1",
          trigger: "attended",
          runAs: "requester",
          requesterId: "u1",
        },
        sessionCreatorId: "u1",
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

describe("receive-pack against hostile input", () => {
  const policy: PushPolicy = {
    defaultBranch: "main",
    requiredMergeRequestLabel: "openma",
    allowMergeRequestOptions: true,
  };
  const enc = (text: string) => new TextEncoder().encode(text);

  it("unions capabilities across command lines, as git does", () => {
    // Reported bypass: push-options on the first line only, then a later
    // line with other capabilities. git still applies the options.
    const bytes = enc(
      pkt(`${OLD} ${NEW} refs/heads/feat\0report-status push-options\n`) +
        pkt(`${OLD} ${NEW} refs/heads/feat2\0report-status\n`) +
        "0000" +
        pkt("merge_request.create\n") +
        pkt("ci.skip\n") +
        "0000",
    );
    const r = parseReceivePackHead(bytes);
    expect(r._tag).toBe("Complete");
    if (r._tag !== "Complete") return;
    expect(r.head.options).toEqual(["merge_request.create", "ci.skip"]);
    expect(evaluatePush(r.head, policy)).toBe(
      "push option ci.skip is not allowed",
    );
  });

  it("bounds commands, options, and head size", () => {
    const many = (n: number) =>
      enc(
        pkt(`${OLD} ${NEW} refs/heads/b0\0report-status\n`) +
          Array.from({ length: n }, (_, i) =>
            pkt(`${OLD} ${NEW} refs/heads/b${i + 1}\n`),
          ).join("") +
          "0000",
      );
    expect(parseReceivePackHead(many(5), { maxCommands: 3 })).toEqual({
      _tag: "Malformed",
      reason: "too many receive-pack commands",
    });
    const opts = enc(
      pkt(`${OLD} ${NEW} refs/heads/b\0push-options\n`) +
        "0000" +
        Array.from({ length: 4 }, () => pkt("merge_request.draft\n")).join(""),
    );
    expect(parseReceivePackHead(opts, { maxOptions: 3 })).toEqual({
      _tag: "Malformed",
      reason: "too many push options",
    });
    // A client that withholds the flush cannot grow the buffer without bound.
    const endless = many(50).subarray(0, -4);
    expect(parseReceivePackHead(endless, { maxHeadBytes: 1024 })).toEqual({
      _tag: "Malformed",
      reason: "receive-pack head is too large",
    });
  });

  it("parses a head fed in small chunks in linear time", () => {
    const commands = Array.from(
      { length: 999 },
      (_, i) => `${OLD} ${NEW} refs/heads/b${i}`,
    );
    const bytes = head(commands);
    const parser = makeReceivePackHeadParser();
    const started = performance.now();
    let result: ReturnType<typeof parser.push> = { _tag: "Incomplete" };
    // After Complete the proxy forwards remainder() and streams the rest.
    for (let i = 0; i < bytes.length && result._tag === "Incomplete"; i += 7) {
      result = parser.push(bytes.subarray(i, i + 7));
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result._tag).toBe("Complete");
    if (result._tag !== "Complete") return;
    expect(result.head.commands).toHaveLength(999);
    expect(result.head.headLength).toBe(bytes.length - "PACK...".length);
    expect(
      "PACK...".startsWith(new TextDecoder().decode(parser.remainder())),
    ).toBe(true);
  });

  it("rejects invalid UTF-8 and ref names git would not accept", () => {
    const nonUtf8Ref = new Uint8Array([
      ...enc(
        (OLD.length + NEW.length + 2 + 14 + 4).toString(16).padStart(4, "0"),
      ),
      ...enc(`${OLD} ${NEW} refs/heads/`),
      0xc3,
      0x28,
      ...enc("x\n"),
      ...enc("0000"),
    ]);
    expect(parseReceivePackHead(nonUtf8Ref)).toEqual({
      _tag: "Malformed",
      reason: "pkt-line is not valid UTF-8",
    });
    for (const ref of [
      "refs/heads/a..b",
      "refs/heads/x.lock",
      "refs/heads/.hidden",
      "refs/heads/a b",
      "refs/heads/a\x01",
      "refs/heads/a@{1}",
      "refs/heads/a/",
      "refs/heads/a.",
      "refs/heads//a",
      "heads/main",
    ]) {
      expect(isValidRefName(ref), ref).toBe(false);
    }
    expect(isValidRefName("refs/heads/feature/x-1.2")).toBe(true);
    expect(
      parseReceivePackHead(head([`${OLD} ${NEW} refs/heads/a..b`])),
    ).toEqual({ _tag: "Malformed", reason: "invalid ref name" });
  });
});

describe("classifyGitLabRequest hardening", () => {
  const c = (method: string, path: string) =>
    classifyGitLabRequest(method, `${ORIGIN}${path}`);

  it("treats /api/ case-insensitively and denies encoded traversal", () => {
    for (const [m, p] of [
      ["POST", "/API/v4/projects/42/repository/files/x/git-receive-pack"],
      ["GET", "/Api/v4/projects/42/repository/files/a"],
      ["GET", "/api/v4/projects/42/repository/branches/a%2F..%2Fb"],
      ["GET", "/api/v4/projects/42/repository/branches/%2e%2e"],
      ["GET", "/api/v4/projects/42/merge_requests/3/%2e%2e/notes"],
      ["GET", "/api/v4/projects/42/merge_requests/3/raw"],
      ["GET", "/api/v4/projects/42/repository/commits/main"],
    ] as const) {
      expect(c(m, p), `${m} ${p}`).toMatchObject({ allow: false });
    }
  });

  it("denies a query string on writes, so it cannot carry target_project_id", () => {
    for (const p of [
      "/api/v4/projects/42/merge_requests?target_project_id=7",
      "/api/v4/projects/42/merge_requests/3/notes?confidential=true",
    ]) {
      expect(c("POST", p), p).toEqual({
        allow: false,
        reason: "query parameters on a write",
      });
    }
    expect(
      c("GET", "/api/v4/projects/42/merge_requests?state=opened"),
    ).toMatchObject({ allow: true, operation: "read" });
  });

  it("returns the validated REST tail to rebuild the upstream URL", () => {
    expect(
      c("GET", "/api/v4/projects/42/repository/branches/feature%2Fx"),
    ).toEqual({
      allow: true,
      projectRef: { kind: "id", id: 42 },
      operation: "read",
      surface: "rest",
      restTail: "/repository/branches/feature%2Fx",
    });
    expect(c("POST", "/api/v4/projects/42/merge_requests/")).toMatchObject({
      allow: true,
      operation: "open_mr",
      restTail: "/merge_requests",
    });
  });

  it("checks that a merge request body targets the classified project", () => {
    expect(mergeRequestBodyProblem({ title: "x" }, 42)).toBeUndefined();
    expect(
      mergeRequestBodyProblem({ target_project_id: 42 }, 42),
    ).toBeUndefined();
    expect(
      mergeRequestBodyProblem(
        new URLSearchParams({ target_project_id: "42" }),
        42,
      ),
    ).toBeUndefined();
    expect(mergeRequestBodyProblem({ target_project_id: 7 }, 42)).toBe(
      "target_project_id names another project",
    );
    expect(
      mergeRequestBodyProblem(
        new URLSearchParams({ target_project_id: "7" }),
        42,
      ),
    ).toBe("target_project_id names another project");
    expect(
      mergeRequestBodyProblem({ target_project_id: "group/other" }, 42),
    ).toBe("target_project_id is not a project ID");
    expect(mergeRequestBodyProblem("raw", 42)).toBe(
      "merge request body is not an object",
    );
    // Repeated or variant keys: parsers disagree on which value wins.
    expect(
      mergeRequestBodyProblem(
        new URLSearchParams([
          ["target_project_id", "42"],
          ["target_project_id", "7"],
        ]),
        42,
      ),
    ).toBe("target_project_id appears more than once");
    expect(
      mergeRequestBodyProblem(
        new URLSearchParams({ "target_project_id[]": "7" }),
        42,
      ),
    ).toBe("target_project_id has an unsupported form");
    expect(mergeRequestBodyProblem({ "target_project_id[]": 7 }, 42)).toBe(
      "target_project_id has an unsupported form",
    );
    expect(mergeRequestBodyProblem({ target_project_id: [7] }, 42)).toBe(
      "target_project_id is not a project ID",
    );
  });
});

describe("GitLab provider configuration errors", () => {
  const config = {
    id: "gl",
    provider: "gitlab",
    baseUrl: ORIGIN,
    linkMethodPolicy: "oauth_only",
    principalPolicy: "user_only",
    allowedScopes: ["read_user"],
    identityBinding: { kind: "none" },
    allowUserPrincipalOutput: true,
    oauth: { clientId: "cid", clientSecret: { ref: "vault:gitlab" } },
  } as const;

  it("fails on a client secret without a resolver instead of acting as a public client", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const provider = makeGitLabBondProvider({ fetch: impl });
    const r = await run(
      Effect.either(provider.refreshUserToken(config, "refresh")),
    );
    expect(Either.isLeft(r) && r.left.rejected).toBe(false);
    expect(Either.isLeft(r) && r.left.message).toContain("resolveSecret");
    expect(calls).toHaveLength(0);
  });

  it("does not treat invalid_client or other 4xx as a rejected grant", async () => {
    for (const [status, error] of [
      [401, "invalid_client"],
      [400, "invalid_request"],
      [403, undefined],
    ] as const) {
      const { impl } = fakeFetch(() => ({
        status,
        ...(error === undefined ? {} : { body: { error } }),
      }));
      const provider = makeGitLabBondProvider({
        fetch: impl,
        resolveSecret: () => Effect.succeed("secret"),
      });
      const r = await run(
        Effect.either(provider.refreshUserToken(config, "refresh")),
      );
      expect(Either.isLeft(r) && r.left.rejected, `${status} ${error}`).toBe(
        false,
      );
    }
  });
});

describe("GitLab manifest and resource catalog", () => {
  const config: ProviderAppConfig = {
    id: "gl",
    provider: "gitlab",
    baseUrl: ORIGIN,
    linkMethodPolicy: "pat_only",
    principalPolicy: "user_only",
    allowedScopes: ["read_api"],
    identityBinding: { kind: "none" },
    allowUserPrincipalOutput: false,
  };

  type Reply = {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  };
  const fake = (handler: (url: URL) => Reply) => {
    const calls: { url: URL; auth: string | null }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      const { status, body, headers } = handler(url);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    }) as typeof fetch;
    return { impl, calls };
  };

  const project = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: `p${id}`,
    path_with_namespace: `group/p${id}`,
    web_url: `${ORIGIN}/group/p${id}`,
    ...extra,
  });
  const access = (project: number, group = 0) => ({
    permissions: {
      project_access: project === 0 ? null : { access_level: project },
      group_access: group === 0 ? null : { access_level: group },
    },
  });

  it("declares a valid manifest and wires the binding", () => {
    expect(manifestProblems(gitlabManifest)).toEqual([]);
    expect(gitlabManifest.resourceKinds.map((k) => k.kind)).toEqual([
      "project",
    ]);
    expect(
      gitlabManifest.resourceKinds[0]!.operations.map(
        (o) => `${o.name}:${o.access}`,
      ),
    ).toEqual([
      "fetch:read",
      "read:read",
      "push:write",
      "open_mr:write",
      "comment_mr:write",
    ]);
    const binding = makeGitLabBinding();
    expect(binding.manifest).toBe(gitlabManifest);
    expect(binding.provider.provider).toBe("gitlab");
  });

  it("lists member projects with Reporter access, page by page", async () => {
    const { impl, calls } = fake((url) =>
      url.searchParams.get("page") === "1"
        ? {
            status: 200,
            body: [project(1), { id: "bad" }, project(2)],
            headers: { "x-next-page": "2" },
          }
        : { status: 200, body: [project(3)], headers: { "x-next-page": "" } },
    );
    const catalog = makeGitLabResourceCatalog({ fetch: impl });
    const first = await run(
      catalog.list({ config, token: "tok", query: "  api ", limit: 500 }),
    );
    expect(first).toEqual({
      items: [
        {
          id: "project:1",
          kind: "project",
          title: "group/p1",
          url: `${ORIGIN}/group/p1`,
        },
        {
          id: "project:2",
          kind: "project",
          title: "group/p2",
          url: `${ORIGIN}/group/p2`,
        },
      ],
      nextCursor: "2",
    });
    const params = Object.fromEntries(calls[0]!.url.searchParams);
    expect(calls[0]!.url.pathname).toBe("/api/v4/projects");
    expect(params).toEqual({
      membership: "true",
      min_access_level: "20",
      simple: "true",
      order_by: "last_activity_at",
      per_page: "100",
      page: "1",
      search: "api",
    });
    expect(calls[0]!.auth).toBe("Bearer tok");
    const second = await run(
      catalog.list({ config, token: "tok", cursor: first.nextCursor! }),
    );
    expect(second).toEqual({
      items: [
        {
          id: "project:3",
          kind: "project",
          title: "group/p3",
          url: `${ORIGIN}/group/p3`,
        },
      ],
    });
    await run(catalog.list({ config, token: "tok", cursor: "../x" }));
    expect(calls[2]!.url.searchParams.get("page")).toBe("1");
    expect(calls[2]!.url.searchParams.get("per_page")).toBe("20");
    expect(calls[2]!.url.searchParams.has("search")).toBe(false);
  });

  it("fails a list on an HTTP error without marking the grant rejected", async () => {
    const { impl } = fake(() => ({
      status: 401,
      body: { message: "401 Unauthorized" },
    }));
    const result = await run(
      Effect.either(
        makeGitLabResourceCatalog({ fetch: impl }).list({ config, token: "t" }),
      ),
    );
    expect(Either.isLeft(result) && result.left).toBeInstanceOf(ProviderError);
    expect(Either.isLeft(result) && result.left.rejected).toBe(false);
    expect(Either.isLeft(result) && result.left.status).toBe(401);
  });

  it("validates each operation against the token's access level", async () => {
    const levels: Record<string, Reply> = {
      "/api/v4/projects/1": { status: 200, body: project(1, access(30)) },
      "/api/v4/projects/2": { status: 200, body: project(2, access(20)) },
      "/api/v4/projects/3": { status: 200, body: project(3, access(10, 40)) },
      "/api/v4/projects/4": {
        status: 404,
        body: { message: "404 Project Not Found" },
      },
      "/api/v4/projects/5": {
        status: 200,
        body: project(5, { ...access(40), archived: true }),
      },
      "/api/v4/projects/6": { status: 200, body: project(6, access(0)) },
    };
    const { impl, calls } = fake(
      (url) => levels[url.pathname] ?? { status: 500 },
    );
    const catalog = makeGitLabResourceCatalog({ fetch: impl });
    const validate = (resource: string, operations: string[]) =>
      run(catalog.validate({ config, token: "tok", resource, operations }));

    expect(await validate("project:1", ["fetch", "push", "open_mr"])).toEqual({
      ok: true,
      resource: {
        id: "project:1",
        kind: "project",
        title: "group/p1",
        url: `${ORIGIN}/group/p1`,
      },
    });
    expect(await validate("project:2", ["fetch"])).toMatchObject({ ok: true });
    expect(await validate("project:2", ["fetch", "push"])).toEqual({
      ok: false,
      reason: "insufficient_access",
      message: "Needs GitLab access level 30; the token holds 20",
    });
    expect(await validate("project:3", ["push"])).toMatchObject({ ok: true });
    expect(await validate("project:4", ["fetch"])).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await validate("project:5", ["read"])).toMatchObject({ ok: true });
    expect(await validate("project:5", ["push"])).toEqual({
      ok: false,
      reason: "insufficient_access",
      message: "Project 5 is archived",
    });
    expect(await validate("project:6", ["fetch"])).toMatchObject({
      ok: false,
      reason: "insufficient_access",
    });
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("rejects malformed IDs and unknown operations without calling GitLab", async () => {
    const { impl, calls } = fake(() => ({ status: 500 }));
    const catalog = makeGitLabResourceCatalog({ fetch: impl });
    const validate = (resource: string, operations: string[]) =>
      run(catalog.validate({ config, token: "t", resource, operations }));
    expect(await validate("project:group%2Fp1", ["fetch"])).toMatchObject({
      ok: false,
      reason: "malformed_id",
    });
    expect(await validate("project:0", ["fetch"])).toMatchObject({
      ok: false,
      reason: "malformed_id",
    });
    expect(await validate("group:1", ["fetch"])).toMatchObject({
      ok: false,
      reason: "unknown_kind",
    });
    expect(await validate("project:1", ["merge"])).toMatchObject({
      ok: false,
      reason: "unknown_operation",
    });
    expect(calls).toHaveLength(0);
  });

  it("fails validation on server errors and on a different project in the reply", async () => {
    const { impl } = fake((url) =>
      url.pathname.endsWith("/7")
        ? { status: 200, body: project(8, access(40)) }
        : { status: 502 },
    );
    const catalog = makeGitLabResourceCatalog({ fetch: impl });
    for (const resource of ["project:7", "project:9"]) {
      const result = await run(
        Effect.either(
          catalog.validate({
            config,
            token: "t",
            resource,
            operations: ["fetch"],
          }),
        ),
      );
      expect(Either.isLeft(result) && result.left).toBeInstanceOf(
        ProviderError,
      );
    }
  });
});
