// Live lane: link a GitLab account through Bond on a desktop-style host and
// exercise the full lifecycle against a real instance. Opt-in and manual.
//
//   GITLAB_ORIGIN=https://gitlab.example.com \
//   GITLAB_OAUTH_FILE=~/.config/<app>/oauth.env \   # line 1 client id, line 2 secret
//   OUT_DIR=/tmp/bond-live \
//   npx unrun examples/gitlab-bond-local/src/index.ts
//
// The OAuth application must list http://127.0.0.1:18766/callback as a
// redirect URI. The script writes the authorization URL to
// $OUT_DIR/authorize_url and waits for the callback. Tokens are never printed.

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
} from "@openmatter/bond";
import {
  authorizationUrl,
  createPkce,
  discoverInstance,
  exchangeCode,
  makeGitLabBondProvider,
  readUser,
} from "@openmatter/bond-gitlab";

const PORT = 18766;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ["read_user", "read_api", "write_repository"];
const origin = process.env.GITLAB_ORIGIN ?? "";
const outDir = process.env.OUT_DIR ?? "/tmp/bond-live";
const oauthFile = (process.env.GITLAB_OAUTH_FILE ?? "").replace(
  /^~/,
  homedir(),
);
if (!origin || !oauthFile)
  throw new Error("GITLAB_ORIGIN and GITLAB_OAUTH_FILE are required");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const [clientId, clientSecret] = readFileSync(oauthFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
if (!clientId || !clientSecret)
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
const config: ProviderAppConfig = {
  id: "gitlab-live",
  provider: "gitlab",
  baseUrl: instance.origin,
  linkMethodPolicy: "oauth_preferred",
  principalPolicy: "user_only",
  allowedScopes: SCOPES,
  identityBinding: { kind: "none" },
  allowUserPrincipalOutput: true,
  oauth: { clientId, clientSecret: { ref: "file" } },
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
console.log(
  `authorize URL written to ${outDir}/authorize_url; waiting for the callback`,
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
      ok ? "Linked. You can close this tab." : "Authorization was not granted.",
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

const client = { origin: instance.origin, clientId, clientSecret };
const grant = await Effect.runPromise(
  exchangeCode(client, {
    code,
    redirectUri: REDIRECT,
    codeVerifier: pkce.verifier,
  }),
);
check("code exchange with PKCE", true, {
  scopes: grant.scopes,
  expiresAt: grant.accessExpiresAt,
});
const user = await Effect.runPromise(
  readUser(instance.origin, grant.accessToken),
);

let bond = makeKernel();
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

const principal = {
  tenantId: "local",
  trigger: "attended",
  runAs: "requester",
  requesterId: "me",
} as const;
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
const unlinked = await Effect.runPromise(
  bond.unlink({
    tenantId: "local",
    linkId: link.id,
    actor: "me",
    reason: "live lane cleanup",
  }),
);
check("unlink revoked the grant at GitLab", unlinked.providerRevoked);
const afterRevoke = (
  await fetch(`${instance.origin}/api/v4/user`, {
    headers: { authorization: `Bearer ${refreshed}` },
  })
).status;
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

writeFileSync(
  `${outDir}/results.json`,
  `${JSON.stringify(results, null, 2)}\n`,
);
const failed = results.filter((r) => !r.ok).length;
console.log(`passed=${results.length - failed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
