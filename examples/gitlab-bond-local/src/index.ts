// Live lane: exercise Bond against a real GitLab instance. Opt-in and manual.
// Set GITLAB_ORIGIN plus at least one of the two modes below. Tokens are
// never printed.
//
//   cd examples/gitlab-bond-local
//   GITLAB_ORIGIN=https://gitlab.example.com \
//   GITLAB_OAUTH_FILE=~/.config/<app>/oauth.env \        # user mode
//   GITLAB_BOT_TOKEN_FILE=~/.config/<app>/bot-token \    # bot mode
//   OUT_DIR=/tmp/bond-live \
//   ../../node_modules/.bin/unrun src/index.ts
//
// User mode (GITLAB_OAUTH_FILE: line 1 client id, line 2 secret). The OAuth
// application must list http://127.0.0.1:18766/callback as a redirect URI.
// The script writes the authorization URL to $OUT_DIR/authorize_url and waits
// for the callback twice: once to link, once to relink the same account.
//
// Bot mode (GITLAB_BOT_TOKEN_FILE: a project or group access token). Needs no
// browser. Create the token as a Maintainer of the project or group:
//   Settings > Access tokens > Add new token, role Developer, scopes
//   `read_api` and `write_repository`, and an expiry date.
// The lane registers the bot as the Installation and checks unattended use and
// the fallback of policy `user`. See docs/BONDS.md, "GitLab bot accounts".
//
// Optional rotation check in bot mode: GITLAB_ROTATE_WITH_FILE holds a token of
// a human Maintainer (scope `api`) and GITLAB_BOT_TOKEN_PATH is the token's
// API path, `projects/<id>/access_tokens/<token id>` or
// `groups/<id>/access_tokens/<token id>`. The lane rotates the bot token,
// re-registers it, writes the new token back to GITLAB_BOT_TOKEN_FILE and the
// new token id to $OUT_DIR/rotated_token_id.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { Effect } from "effect";
import {
  ConfigError,
  makeBond,
  makeMemoryBondStore,
  type ProviderAppConfig,
  type SecretCipher,
} from "@openma/matter/bond";
import {
  authorizationUrl,
  createPkce,
  discoverInstance,
  exchangeCode,
  makeGitLabBondProvider,
  readTokenInfo,
  readUser,
  tokenExpiryInstant,
  validateBotCredential,
} from "@openma/matter-gitlab/bond";

const PORT = 18766;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ["read_user", "read_api", "write_repository"];
const origin = process.env.GITLAB_ORIGIN ?? "";
const outDir = process.env.OUT_DIR ?? "/tmp/bond-live";
const pathFromEnv = (name: string) =>
  (process.env[name] ?? "").replace(/^~/, homedir());
const oauthFile = pathFromEnv("GITLAB_OAUTH_FILE");
const botFile = pathFromEnv("GITLAB_BOT_TOKEN_FILE");
if (!origin || (!oauthFile && !botFile))
  throw new Error(
    "GITLAB_ORIGIN and at least one of GITLAB_OAUTH_FILE or GITLAB_BOT_TOKEN_FILE are required",
  );
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const [clientId = "", clientSecret = ""] = oauthFile
  ? readFileSync(oauthFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  : [];
if (oauthFile && (!clientId || !clientSecret))
  throw new Error("GITLAB_OAUTH_FILE needs a client id and secret");

const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({
    check: name,
    ok,
    ...(detail === undefined ? {} : { detail }),
  });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
  );
};

// AES-GCM cipher with a process-local key: ciphertext only ever reaches the store.
const key = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);
const cipher: SecretCipher = {
  seal: (plaintext, purpose) =>
    Effect.promise(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(purpose),
        },
        key,
        new TextEncoder().encode(plaintext),
      );
      return {
        keyId: "local-1",
        ciphertext: `${Buffer.from(iv).toString("base64")}.${Buffer.from(data).toString("base64")}`,
      };
    }),
  open: (sealed, purpose) =>
    Effect.promise(async () => {
      const [iv, data] = sealed.ciphertext.split(".");
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(iv ?? "", "base64"),
          additionalData: new TextEncoder().encode(purpose),
        },
        key,
        Buffer.from(data ?? "", "base64"),
      );
      return new TextDecoder().decode(plain);
    }),
};

// Count token-endpoint calls to prove single-flight refresh.
let tokenCalls = 0;
const countingFetch: typeof fetch = (input, init) => {
  if (String(input).endsWith("/oauth/token")) tokenCalls++;
  return fetch(input, init);
};

const instance = await Effect.runPromise(discoverInstance(origin));
check(
  "discovery: PKCE S256 and refresh_token supported, issuer matches",
  true,
  {
    deviceFlow: instance.deviceFlow,
  },
);

let refreshSkewMs = 5 * 60_000;
let config: ProviderAppConfig = {
  id: "gitlab-live",
  provider: "gitlab",
  baseUrl: instance.origin,
  linkMethodPolicy: "oauth_preferred",
  principalPolicy: "user_only",
  allowedScopes: SCOPES,
  identityBinding: { kind: "none" },
  allowUserPrincipalOutput: true,
  ...(oauthFile ? { oauth: { clientId, clientSecret: { ref: "file" } } } : {}),
};
const store = makeMemoryBondStore();
const makeKernel = () =>
  makeBond({
    providerApps: {
      get: ({ providerAppId: id }) =>
        id === config.id
          ? Effect.succeed(config)
          : Effect.fail(
              new ConfigError({ message: "unknown", providerAppId: id }),
            ),
    },
    store,
    cipher,
    providers: {
      gitlab: makeGitLabBondProvider({
        fetch: countingFetch,
        resolveSecret: () => Effect.succeed(clientSecret),
      }),
    },
    refreshSkewMs,
    leaseRetryMs: 50,
  });

const client = { origin: instance.origin, clientId, clientSecret };

/**
 * One authorization round: writes the URL to $OUT_DIR/authorize_url (and the
 * step name to $OUT_DIR/authorize_step), waits for the loopback callback,
 * and exchanges the code. GitLab skips the consent page when the same
 * application asks again for the same scopes.
 */
const authorize = async (step: string) => {
  const pkce = await Effect.runPromise(createPkce());
  const state = crypto.randomUUID();
  const url = authorizationUrl({
    origin: instance.origin,
    clientId,
    redirectUri: REDIRECT,
    scopes: SCOPES,
    state,
    codeChallenge: pkce.challenge,
  });
  writeFileSync(`${outDir}/authorize_url`, `${url}\n`, { mode: 0o600 });
  writeFileSync(`${outDir}/authorize_step`, `${step}\n`, { mode: 0o600 });
  console.log(
    `[${step}] authorize URL written to ${outDir}/authorize_url; waiting for the callback`,
  );
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const got = u.searchParams.get("code");
      if (u.searchParams.get("state") !== state) {
        // A stale tab or a forged request. Refuse it and keep waiting.
        console.log("ignored a callback with a stale or unknown state");
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("This authorization link is stale. Use the newest link.");
        return;
      }
      const ok = got !== null;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" });
      res.end(
        ok
          ? "Linked. You can close this tab."
          : "Authorization was not granted.",
      );
      server.close();
      ok
        ? resolve(got)
        : reject(new Error(u.searchParams.get("error") ?? "no code"));
    });
    server.listen(PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the callback"));
    }, 60 * 60_000).unref();
  });
  return Effect.runPromise(
    exchangeCode(client, {
      code,
      redirectUri: REDIRECT,
      codeVerifier: pkce.verifier,
    }),
  );
};

const status = async (token: string) =>
  (
    await fetch(`${instance.origin}/api/v4/user`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;

const principal = {
  tenantId: "local",
  trigger: "attended",
  runAs: "requester",
  requesterId: "me",
} as const;
let bond = makeKernel();

if (oauthFile) {
  const grant = await authorize("link");
  check("code exchange with PKCE", true, {
    scopes: grant.scopes,
    expiresAt: grant.accessExpiresAt,
  });
  const user = await Effect.runPromise(
    readUser(instance.origin, grant.accessToken),
  );

  const link = await Effect.runPromise(
    bond.link({
      tenantId: "local",
      appUserId: "me",
      providerAppId: config.id,
      method: "oauth",
      providerUser: {
        id: user.id,
        login: user.username,
        identities: user.identities,
      },
      grant,
      actor: "me",
    }),
  );
  check(
    "link stored sealed tokens",
    !link.access.ciphertext.includes(grant.accessToken.slice(0, 8)),
    {
      method: link.method,
      health: bond.linkHealth(link),
    },
  );

  const first = await Effect.runPromise(
    bond.credential({
      tenantId: "local",
      providerAppId: config.id,
      principal,
      sessionCreatorId: "me",
      access: "write",
      operation: "probe",
    }),
  );
  const me = await Effect.runPromise(
    readUser(instance.origin, first.credential.token),
  );
  check(
    "credential resolves to the linked user",
    me.id === user.id && first.credential.principal.kind === "user",
  );

  // Force a refresh: treat any token with less than 3 hours left as expiring.
  refreshSkewMs = 3 * 60 * 60_000;
  bond = makeKernel();
  const before = tokenCalls;
  const parallel = await Promise.all(
    Array.from({ length: 6 }, () =>
      Effect.runPromise(
        bond.credential({
          tenantId: "local",
          providerAppId: config.id,
          principal,
          sessionCreatorId: "me",
          access: "read",
        }),
      ),
    ),
  );
  const refreshed = parallel[0]?.credential.token ?? "";
  check(
    "parallel callers caused exactly one refresh",
    tokenCalls - before === 1,
    { tokenCalls: tokenCalls - before },
  );
  check(
    "all callers received the rotated token",
    parallel.every((p) => p.credential.token === refreshed) &&
      refreshed !== first.credential.token,
  );
  const oldStatus = (
    await fetch(`${instance.origin}/api/v4/user`, {
      headers: { authorization: `Bearer ${first.credential.token}` },
    })
  ).status;
  check(
    "the pre-refresh access token is invalid after rotation",
    oldStatus === 401,
    { status: oldStatus },
  );
  const newUser = await Effect.runPromise(readUser(instance.origin, refreshed));
  check("the rotated token works", newUser.id === user.id);

  refreshSkewMs = 5 * 60_000;
  bond = makeKernel();

  // Relink the same account by OAuth. Bond stores the new token in place and
  // then revokes the previous one; GitLab must not invalidate the new token.
  const second = await authorize("relink");
  const relinked = await Effect.runPromise(
    bond.link({
      tenantId: "local",
      appUserId: "me",
      providerAppId: config.id,
      method: "oauth",
      providerUser: {
        id: user.id,
        login: user.username,
        identities: user.identities,
      },
      grant: second,
      actor: "me",
    }),
  );
  check(
    "relink of the same account updates the link in place",
    relinked.id === link.id,
    {
      revision: relinked.revision,
    },
  );
  const previousAfterRelink = await status(refreshed);
  const newAfterRelink = await status(second.accessToken);
  check(
    "relink revoked only the previous token; the new token still works",
    previousAfterRelink === 401 && newAfterRelink === 200,
    { previous: previousAfterRelink, current: newAfterRelink },
  );
  const viaBond = await Effect.runPromise(
    bond.credential({
      tenantId: "local",
      providerAppId: config.id,
      principal,
      sessionCreatorId: "me",
      access: "read",
    }),
  );
  check(
    "Bond hands out the new token after relink",
    viaBond.credential.token === second.accessToken,
  );

  const unlinked = await Effect.runPromise(
    bond.unlink({
      tenantId: "local",
      linkId: link.id,
      actor: "me",
      reason: "live lane cleanup",
    }),
  );
  check("unlink revoked the grant at GitLab", unlinked.providerRevoked);
  const afterRevoke = await status(second.accessToken);
  check("the token is rejected after unlink", afterRevoke === 401, {
    status: afterRevoke,
  });
  const gone = await Effect.runPromise(
    Effect.either(
      bond.credential({
        tenantId: "local",
        providerAppId: config.id,
        principal,
        sessionCreatorId: "me",
        access: "read",
      }),
    ),
  );
  check(
    "Bond reports link_required after unlink",
    gone._tag === "Left" && gone.left.reason === "link_required",
  );
}

if (botFile) {
  const botToken = readFileSync(botFile, "utf8").trim();
  const [info, botUser] = await Promise.all([
    Effect.runPromise(readTokenInfo(instance.origin, botToken)),
    Effect.runPromise(readUser(instance.origin, botToken)),
  ]);
  const problems = validateBotCredential(info, botUser, {
    allowedScopes: ["read_api", "write_repository"],
    maxLifetimeDays: 365,
    now: new Date().toISOString(),
  });
  check(
    "bot credential validates as a bot with allowed scopes",
    problems.length === 0,
    {
      problems,
      bot: botUser.bot,
      scopes: info.scopes,
    },
  );
  config = { ...config, principalPolicy: "user" };
  bond = makeKernel();
  await Effect.runPromise(
    bond.claimInstallation({
      tenantId: "local",
      providerAppId: config.id,
      providerInstallationId: botUser.id,
      actor: "me",
      verified: true,
      credential: {
        token: botToken,
        ...(info.expiresAt === undefined
          ? {}
          : { expiresAt: tokenExpiryInstant(info.expiresAt) }),
      },
    }),
  );
  const unattended = await Effect.runPromise(
    bond.credential({
      tenantId: "local",
      providerAppId: config.id,
      principal: {
        tenantId: "local",
        trigger: "unattended",
        runAs: "app",
        requesterId: "me",
      },
      access: "write",
    }),
  );
  const asBot = await Effect.runPromise(
    readUser(instance.origin, unattended.credential.token),
  );
  check(
    "unattended work resolves to the bot, even with a known actor",
    unattended.credential.principal.kind === "app" && asBot.bot,
  );
  // The user link was removed above, so `user` falls back with a reason.
  const fallback = await Effect.runPromise(
    bond.credential({
      tenantId: "local",
      providerAppId: config.id,
      principal,
      sessionCreatorId: "me",
      access: "write",
    }),
  );
  check(
    "policy user without a link falls back to the bot with a recorded reason",
    fallback.credential.principal.kind === "app" &&
      fallback.resolution.fallback !== false &&
      fallback.resolution.fallback.reason === "no_link",
    { fallback: fallback.resolution.fallback },
  );

  // Rotation: a bot cannot rotate its own token on every GitLab version, so a
  // human Maintainer rotates it and the host re-registers the new token.
  const rotateWithFile = pathFromEnv("GITLAB_ROTATE_WITH_FILE");
  const tokenPath = process.env.GITLAB_BOT_TOKEN_PATH ?? "";
  if (rotateWithFile && tokenPath) {
    const maintainer = readFileSync(rotateWithFile, "utf8").trim();
    const res = await fetch(`${instance.origin}/api/v4/${tokenPath}/rotate`, {
      method: "POST",
      headers: {
        "private-token": maintainer,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        info.expiresAt === undefined ? {} : { expires_at: info.expiresAt },
      ),
    });
    const rotated = (await res.json()) as {
      id?: number;
      token?: string;
      expires_at?: string;
    };
    if (!res.ok || !rotated.token || rotated.id === undefined)
      throw new Error(`rotation failed with HTTP ${res.status}`);
    // Keep the file pointing at the live token, so cleanup still works.
    writeFileSync(botFile, `${rotated.token}\n`, { mode: 0o600 });
    writeFileSync(`${outDir}/rotated_token_id`, `${rotated.id}\n`, {
      mode: 0o600,
    });
    const reclaimed = await Effect.runPromise(
      bond.claimInstallation({
        tenantId: "local",
        providerAppId: config.id,
        providerInstallationId: botUser.id,
        actor: "me",
        verified: true,
        credential: {
          token: rotated.token,
          ...(rotated.expires_at === undefined
            ? {}
            : { expiresAt: tokenExpiryInstant(rotated.expires_at) }),
        },
      }),
    );
    const [oldBot, rotatedUser] = await Promise.all([
      status(botToken),
      Effect.runPromise(readUser(instance.origin, rotated.token)),
    ]);
    check(
      "rotation keeps the bot user and invalidates the previous token",
      rotatedUser.id === botUser.id && oldBot === 401,
      { previous: oldBot, sameUser: rotatedUser.id === botUser.id },
    );
    const afterRotation = await Effect.runPromise(
      bond.credential({
        tenantId: "local",
        providerAppId: config.id,
        principal: {
          tenantId: "local",
          trigger: "unattended",
          runAs: "app",
        },
        access: "write",
      }),
    );
    check(
      "re-registering the bot replaces the stored token",
      reclaimed === "already_owned" &&
        afterRotation.credential.token === rotated.token,
      { claim: reclaimed },
    );
  }
}

writeFileSync(
  `${outDir}/results.json`,
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok).length;
console.log(`passed=${results.length - failed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
