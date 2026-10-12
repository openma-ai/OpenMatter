# Connections: linked provider accounts and execution principals

**Status:** proposed (2026-10-12). Not implemented.
**Decision:** OpenMatter provides an optional, storage-free connection kernel
that links work-platform accounts, selects an explicit `ExecutionPrincipal`,
and produces a `CredentialResolver`. Applications own persistence, encryption
keys, HTTP routes, and membership-driven revocation.

## Why this exists

Agents act in work systems on behalf of people. Today OpenMA consumers pass a
static credential into each Session:

- the OpenMA console asks the user to paste a GitHub PAT for every
  `github_repository` resource;
- `@openmatter/project-worker` sends one deployment-wide
  `PROJECT_WORKER_GITHUB_TOKEN` as `authorization_token`
  (`packages/project-worker/src/oma.ts`), so every Thread runs as the owner of
  that token.

The comparable products settle on the same structure. The Cursor and Devin
GitHub integrations both use an organization-level GitHub App plus a per-user
account link:

- Cursor requires each user to link a Git account and limits an agent to
  repositories that user can already reach ("access is inherited, never
  widened").
- Devin links accounts optionally and uses the link for attribution. An
  administrator chooses whether pull requests open as the bot or the user.

In `openma-ai`, 106 Cursor pull requests were opened by the requesting user
through the Cursor GitHub App: `performed_via_github_app = cursor`, commits
authored and committed by `Cursor Agent <cursoragent@cursor.com>` (a regular
User account, not an App bot), signed and shown as Verified, with
`Co-authored-by` the user. Eleven Devin pull
requests were opened as the user, but without a GitHub App marker.

[Bot Identity, Agent Profiles, and Scope](IDENTITY_MODEL.md) already accepts
`ExecutionIdentity` with a "bot/app principal or an explicitly delegated user
principal", and still lists explicit principal selection as missing. This
document specifies that missing piece.

## Scope

In scope:

- a provider-neutral kernel for installation and user links, their lifecycle,
  and token freshness;
- explicit `ExecutionPrincipal` selection with auditable, never implicit,
  fallback;
- a `ConnectionStore` port with written invariants, a conformance suite, and
  an in-memory adapter for tests;
- a GitHub binding built on Octokit's maintained authentication strategies;
- a GitLab binding for gitlab.com and self-managed instances that uses only
  delegated user principals and no bot account;
- a backward-compatible `CredentialRequest` extension.

Not in scope, and deliberately left to applications:

- tables, migrations, and production storage adapters;
- encryption key custody (KMS, root secret, OS keychain);
- HTTP route mounting, redirect pages, and UI;
- tenant membership and the revocation it implies;
- sandbox credential delivery.

This keeps the commitments in [README](../README.md) and
[Credential resolution](CREDENTIALS.md): OpenMatter owns no mandatory
credential service, and `@openmatter/credentials` remains a resolver port.
[Work Profiles](INTEGRATIONS.md) already allows "OAuth installation
callbacks" as explicit, independently packageable custom bindings. These
packages are that kind of binding.

## Layering

```text
@octokit/auth-app, @octokit/auth-oauth-user, @octokit/auth-oauth-device
        provider protocol: App JWT, installation tokens, web and device flow
                │
@openmatter/connection-github
        GitHub binding: install-and-authorize, repository intersection,
        repository-scoped installation tokens, attribution helpers
                │
@openmatter/connections
        kernel: link state machine, token freshness, principal selection,
        audit facts, ports, conformance suite, memory adapter (tests only)
                │  produces
@openmatter/credentials  CredentialResolver (unchanged port, extended request)
────────────────────────────────────────────── application layer
open-managed-agents   SQL adapter, purpose cipher/KMS, routes, console
Backchat              SQLite metadata + OS keychain, device flow UI
self-hosted hosts     their own store, routes, and key custody
```

The connection packages depend only on `effect`, `@openmatter/credentials`,
and Octokit. They do not depend on `@openmatter/core` or the runtime, so a
control plane can adopt them without adopting the Loop.

Provider protocol code is not reimplemented. OpenMA currently hand-writes App
JWT and token exchange in its GitHub integration
(`packages/github/src/oauth/protocol.ts` in open-managed-agents). New code
uses Octokit's strategies, and only the kernel, policy, and ports are
OpenMatter-owned.

## Domain model

```text
ProviderApp            configuration supplied by the application through
                       ProviderAppSource: provider, base URL, link method
                       policy, client id, app id and slug (GitHub),
                       private key and client secret (secret references),
                       CA bundle reference
  ├── Installation     provider installation in one account/org (GitHub)
  │     │              (installation id, account login, repository
  │     │               selection, status)
  │     └── UserLink   one application user ↔ one provider user
  └── UserLink         providers without installations (GitLab)
                       (provider user id, login, method, sealed user
                        token, expiry, refresh lease, status)

ExecutionPrincipal     who performs one external operation
  = { kind: "app",  providerAppId, installationId }
  | { kind: "user", providerAppId, installationId?, userLinkId }
```

- `Installation.status`: `pending` → `active` → `suspended` | `revoked`.
- `UserLink.method`: `oauth` (provider authorization, refreshable) or `pat`
  (a user-supplied personal access token, not refreshable).
- `UserLink.status`: `active` → `refresh_failed` | `expired` |
  `method_disallowed` | `revoked`. Every non-active state keeps the reason
  and requires the user to re-link.
- An application user may hold several UserLinks across installations. The
  provider user id is the stable identity. A login is display data only.
- A GitHub ProviderApp is one `BotResource` in the sense of
  [IDENTITY_MODEL.md](IDENTITY_MODEL.md). Connections never create one App per
  AgentProfile or persona.
- A GitLab ProviderApp represents one instance. It holds an OAuth
  application only when its link method policy enables OAuth. It has no bot
  account and no app principal. Each GitLab instance, including
  gitlab.com, is a separate ProviderApp identified by its canonical origin.

## Principal selection

Each operation states the principal it requires. The kernel resolves it
against a `PrincipalPolicy` configured by the application:

| Policy      | User link present | User link absent or invalid         |
| ----------- | ----------------- | ----------------------------------- |
| `app`       | app principal     | app principal                       |
| `user`      | user principal    | app principal, recorded as fallback |
| `user_only` | user principal    | fails with `link_required`          |

Rules:

1. Fallback happens only when the configured policy names it. The result
   carries `fallback: true` and the reason, and the audit fact records both.
   This satisfies "fallback from bot to user, or user to bot, is never
   implicit".
2. Unattended work (schedules, webhooks, shared channels, service accounts)
   always resolves to the app principal. It never borrows a person's link.
3. A user principal is only usable through a provider mechanism that marks
   the delegation, such as a GitHub App user-to-server token, which shows
   "with `<app>`" and sets `performed_via_github_app`. A plain OAuth token that
   makes output look human-authored is rejected, as IDENTITY_MODEL.md already
   requires.
4. Repository access for a user principal is the intersection of the
   installation's repositories and the user's own access. Selecting a
   principal never widens access.
5. A provider without an app principal (GitLab) accepts only `user_only`.
   Unattended work has no principal there and fails with
   `unattended_unsupported`.

## Link method policy

`LinkMethodPolicy` is configured per ProviderApp. It says how users may link.

| Policy            | Allowed methods                                | Requires             |
| ----------------- | ---------------------------------------------- | -------------------- |
| `pat_only`        | `pat`                                          | nothing              |
| `oauth_only`      | `oauth`                                        | an OAuth application |
| `oauth_preferred` | `oauth`, then `pat` as an explicit alternative | an OAuth application |

GitHub ProviderApps are `oauth_only`. Their user principal must come from the
App's user-to-server authorization, which carries the delegation marker.
GitLab ProviderApps may use any of the three policies.

Rules:

1. The user chooses the method. The link records it, and audit facts carry
   it.
2. A failed refresh never becomes a request for a token on its own. The link
   moves to `refresh_failed`, and the user re-links with an allowed method.
3. At most one active link exists per (tenant, application user,
   ProviderApp, installation). A new link, by either method, revokes the
   previous one first.
4. Narrowing the policy marks links of the removed method
   `method_disallowed` and revokes their tokens.
5. Both methods pass the same validation: an allowed-scope set, the provider
   user ID as the stable key, and an optional identity binding to the
   application's SSO subject. Personal access tokens must also be active and
   carry an expiry within the configured maximum lifetime.
6. After linking, principal selection, credential resolution, and audit do
   not depend on the method.

## Token lifecycle

| Token              | Lifetime (GitHub) | Persisted | Handling                                                                                                               |
| ------------------ | ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| App JWT            | ≤ 10 min          | no        | minted per exchange from the private key reference                                                                     |
| Installation token | 1 h               | **no**    | minted on demand, scoped to the requested repositories and permissions, cached in memory until 5 minutes before expiry |
| User access token  | 8 h               | sealed    | refreshed before expiry under a store lease                                                                            |
| User refresh token | 6 months          | sealed    | rotated on every refresh; a rejected refresh moves the link to `refresh_failed`                                        |

Refresh is single-flight across processes. A caller takes the link's refresh
lease with compare-and-set, refreshes, writes the rotated pair together with
the cipher key id, and releases the lease. Concurrent callers wait for the
lease or read the rotated token. The lease has a short expiry so a crashed
refresher cannot block the link.

A `pat` link has no refresh token and takes no lease. Its expiry comes from
the provider's token metadata. The kernel reports `expiring` inside a
configurable warning window, and moves the link to `expired` at expiry or on
the first authentication failure.

Revocation deletes nothing silently. It writes a tombstone (`revoked`, time,
actor, reason) and asks the provider to revoke the grant where supported. A
late refresh must not resurrect a revoked link.

## Ports

Sketch, not final API:

```ts
interface ProviderAppConfig {
  provider: "github" | "gitlab";
  baseUrl: string; // canonical origin
  linkMethodPolicy: "pat_only" | "oauth_only" | "oauth_preferred";
  maxPatLifetimeDays?: number; // pat only
  identityBinding:
    { kind: "none" } | { kind: "sso_extern_uid"; ssoProvider: string };
  allowedScopes: readonly string[];
  allowUserPrincipalOutput: boolean; // IDENTITY_MODEL opt-in
  oauth?: { clientId: string; clientSecret: SecretRef };
  github?: { appId: string; slug: string; privateKey: SecretRef };
  caBundle?: SecretRef;
}

interface ProviderAppSource {
  // implemented by the application: OMA reads its database,
  // Backchat reads local settings, a self-hosted host reads its config
  get(ref: ProviderAppRef): Effect<ProviderAppConfig, ConfigError>;
}

interface ConnectionStore {
  getInstallation(
    ref: InstallationRef,
  ): Effect<Installation | undefined, StoreError>;
  putInstallation(value: Installation): Effect<void, StoreError>; // idempotent by provider installation id

  getUserLink(ref: UserLinkRef): Effect<UserLink | undefined, StoreError>;
  findUserLink(q: {
    tenantId;
    appUserId;
    installationId;
  }): Effect<UserLink | undefined, StoreError>;
  upsertUserLink(value: UserLinkWrite): Effect<UserLink, StoreError>; // idempotent by (tenant, provider user id, installation)

  acquireRefreshLease(
    id: string,
    owner: string,
    ttlMs: number,
  ): Effect<RefreshLease | "held", StoreError>; // atomic compare-and-set
  commitRefresh(
    id: string,
    lease: RefreshLease,
    sealed: SealedTokens,
  ): Effect<"committed" | "stale_lease" | "revoked", StoreError>; // fenced by lease token
  revokeUserLink(id: string, tombstone: Tombstone): Effect<void, StoreError>;
}

interface SecretCipher {
  seal(
    plaintext: string,
    purpose: string,
  ): Effect<{ keyId: string; ciphertext: string }>;
  open(
    sealed: { keyId: string; ciphertext: string },
    purpose: string,
  ): Effect<string>;
}

interface StateSigner {
  // OAuth state and install state; short-lived, single-use
  sign(claims: LinkState, ttlSeconds: number): Effect<string>;
  verify(token: string): Effect<LinkState, StateError>;
}
```

`Clock` and `HttpClient` are injected so tests and edge hosts control time
and transport.

The application passes its implementations in when it builds the kernel:

```ts
const connections = makeConnections({
  providerApps, // ProviderAppSource
  store, // ConnectionStore
  cipher, // SecretCipher
  state, // StateSigner
});
```

The kernel reads `ProviderAppSource` on every link, validation, and
principal selection, and never caches a policy across operations. An
administrator change therefore applies to the next operation. OpenMatter
provides no API, UI, or storage for this configuration.

Invariants every application adapter must satisfy:

1. Ciphertext and its `keyId` are stored and returned together. Old keys stay
   readable until the application re-seals.
2. `acquireRefreshLease` is atomic. At most one unexpired lease exists per
   link.
3. `commitRefresh` succeeds only with the current lease token, and never
   after revocation.
4. A revoked link stays revoked. Any later `upsertUserLink` for the same
   provider user creates a new link id.
5. Reads are tenant-scoped. A lookup can never return another tenant's row.
6. Plaintext tokens never pass through the store. It receives sealed values
   only.

## Conformance suite

`@openmatter/connections/conformance` exports
`runConnectionStoreConformance(makeStore, makeCipher)`. Each application runs
it against its real adapter in its own CI, against its real database. The
suite covers idempotent upserts, tenant isolation, lease races with parallel
callers, stale-lease commits, revoke-then-refresh, key rotation reads, expiry
boundaries, relinking with the other method, policy narrowing to
`method_disallowed`, and `pat` links that never take a refresh lease.

The memory adapter passes the same suite and is labelled test-only.

## CredentialRequest extension

```ts
interface CredentialRequest {
  readonly integrationId: string;
  readonly authority: string;
  readonly principal?: ExecutionPrincipalRequest; // new, optional
}
```

An absent `principal` keeps today's meaning: the installation credential for
`authority`. Existing resolvers and integrations therefore continue to work.
The Loop sets `principal` from the ScopeBinding and grants. Agent output
cannot set it.

## Audit facts

Every resolution emits one immutable fact. Values are identifiers, never
tokens:

```text
requestingActor      application user or event actor that caused the work
executionPrincipal   app | user, installation id, user link id
policy               app | user | user_only
fallback             false | { reason }
surfaceIdentity      the BotResource that appears on the work surface
operation            provider operation name and resource address
```

This matches the audit separation required by IDENTITY_MODEL.md: visible
author, execution principal, requesting actor, and provider receipt.

## GitHub binding

`@openmatter/connection-github` provides:

- **Install and authorize in one redirect.** The App enables "Request user
  authorization (OAuth) during installation", so the first administrator gets
  an Installation and a UserLink from one flow. Later members only authorize.
- **Web flow and device flow.** Server hosts use the web flow with a signed,
  single-use state. Desktop hosts use the device flow, which needs only the
  client id, so no client secret ships with a desktop app.
- **Repository intersection.** `GET /user/installations/{installation_id}/repositories`
  with the user token returns repositories that both the installation and the
  user can access. Repository pickers use this list.
- **Repository-scoped installation tokens.** `POST /app/installations/{id}/access_tokens`
  with `repositories` and `permissions` narrows a token to the work at hand.
- **Attribution helpers.** These are pure functions an application may use:
  - commit author and committer are the App's bot account:
    `<slug>[bot] <BOT_ID+<slug>[bot]@users.noreply.github.com>`. `BOT_ID` is
    the bot user's ID from `GET /users/<slug>[bot]`, not the App ID. For
    example, `devin-ai-integration[bot]` is user 158243242, while the Devin App
    is 811515. The binding resolves the bot ID once and caches it. A wrong ID
    leaves the commit unlinked from the bot account;
  - each human participant is added as
    `Co-authored-by: <login> <ID+login@users.noreply.github.com>`, where `ID`
    is the GitHub user ID. The ID form still links after a login rename; the
    legacy `login@users.noreply.github.com` form does not;
  - pull requests open with the user principal when policy allows, otherwise
    with the app principal and a "Requested by @login" line.

The binding does not open pull requests by itself. That is a WorkEffect,
granted per Turn like any other.

## GitLab binding

`@openmatter/connection-gitlab` covers gitlab.com and self-managed GitLab.
By requirement it uses no bot: no project or group access token and no
service account, because each of those creates a bot user. Every operation
runs as the linking user.

GitLab facts that shape the binding. These were checked read-only against a
self-managed GitLab 17.1.8 Enterprise (JiHu) instance on 2026-10-12:

- There is no App or installation. OAuth applications are owned by the
  instance, a group, or a single user.
- OIDC discovery lists `authorization_code` (PKCE `S256`) and
  `refresh_token`. GitLab documents device flow from 17.1, but this instance
  lists no `device_authorization_endpoint`, and `POST /oauth/authorize_device`
  returns 404, so the feature is disabled there. Desktop hosts therefore use
  authorization code with PKCE and a loopback redirect, and use device flow
  only where discovery advertises it.
- Scopes apply to the whole account. No scope narrows a user token to one
  project. The test account had Developer access or higher on 825 projects,
  and a `write_repository` token reaches all of them.
- Git over HTTPS accepts the token as the password with any username.
- Path forms vary. Git paths are case-insensitive. A path without `.git`
  answers 301 to the `.git` form. REST accepts a numeric project ID or a
  case-insensitive URL-encoded path, and returns 404 for a `.git` suffix.
  `/api/graphql` serves every project from one endpoint.
- Merge requests carry no field that marks app-mediated or delegated
  creation.

So the GitHub control model is reproduced differently:

| GitHub control                                           | GitLab equivalent                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| repository-scoped, 1 h installation token in the sandbox | the user token stays with the host; the sandbox holds only a fenced Session capability; an application proxy checks every request |
| App permission set                                       | operation classes: `fetch`, `push`, `open_mr`, `comment_mr`                                                                       |
| installation ∩ user repositories                         | `GET /projects?membership=true&min_access_level=30`                                                                               |
| access check at Session creation                         | `GET /projects/:id`, highest of `project_access` and `group_access`                                                               |
| installation and authorization webhooks                  | none; revocation surfaces as refresh or request failure                                                                           |
| "with App" marker and `performed_via_github_app`         | content marker plus audit fact (see below)                                                                                        |
| app principal for unattended work                        | none; unattended GitLab work is unsupported                                                                                       |

Linking follows the ProviderApp's `LinkMethodPolicy`:

- `oauth` uses authorization code with PKCE. Access tokens last 2 hours, and
  each refresh invalidates both the old access token and the old refresh
  token, so the refresh lease is mandatory.
- `pat` accepts a personal access token through a dedicated form. The binding
  validates it with `GET /personal_access_tokens/self`: active, scopes within
  the allowed set, and an expiry within the maximum lifetime. Unlinking calls
  `DELETE /personal_access_tokens/self`.
- Both read `GET /user`. When the application enables identity binding, the
  `extern_uid` of the configured SSO identity must match the application
  user's SSO subject.

The binding exports pure helpers. Applications build their proxies on them:

- `validatePersonalAccessToken(info, policy)` checks token metadata against
  the allowed scopes and maximum lifetime.
- `discoverInstance(origin)` reads OIDC discovery, requires PKCE `S256` and
  `refresh_token`, and records whether device flow exists.
- `classifyGitLabRequest(method, url)` returns
  `{ projectRef, operation } | { deny, reason }` for git smart HTTP and REST.
  Project references are normalized: case is folded, `.git` handling is
  unified, and numeric IDs and paths are treated as one reference. The
  application must resolve each reference to a numeric project ID before it
  authorizes the request. GraphQL, redirects, LFS, and unknown routes are
  denied.
- `parseReceivePackCommands(stream)` reads the pkt-line command list and push
  options without buffering the pack. It lets a proxy enforce ref and
  push-option policy.
- Attribution helpers are pure functions. The commit author is the user's
  GitLab name and `commit_email`. Commits get an `Assisted-by: <app name>
<Session URL>` trailer. Merge requests get a label and a description footer
  that name the application.

Delegated user output without a provider-native marker is allowed only under
the conditions in [IDENTITY_MODEL.md](IDENTITY_MODEL.md#executionidentity).

## Consumers

| Consumer                               | Runs the flow                                               | Store                         | Key custody                                               |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| open-managed-agents                    | yes, web flow                                               | SQL tables via its migrations | `cipherFor(purpose)` / KMS                                |
| Backchat local                         | yes; GitHub device flow, GitLab PKCE with loopback redirect | SQLite for metadata           | OS keychain for tokens                                    |
| Self-hosted OpenMatter                 | yes                                                         | host's choice                 | host's choice                                             |
| `@openmatter/project-worker` on OpenMA | no                                                          | none                          | none. It references an OpenMA connection instead of a PAT |

## Distribution

The packages are not published to a registry. Consumers pin a git tag or
commit SHA, matching how Backchat consumes OpenMatter and how OMA consumes
openma-common:

```jsonc
"@openmatter/connections":
  "github:openma-ai/OpenMatter#<tag-or-sha>&path:/packages/connections",
"@openmatter/connection-gitlab":
  "github:openma-ai/OpenMatter#<tag-or-sha>&path:/packages/connection-gitlab"
```

All `@openmatter/*` packages in one consumer use the same tag or SHA,
including `@openmatter/credentials`. A bump is a reviewed lockfile change in
the consumer.

## Security notes

- The private key and client secret are bootstrap secrets. They are
  referenced, never stored by connections, and never logged.
- User tokens never enter agent input, Context, WorkEvents, receipts, or
  sandboxes. For GitHub, sandboxes receive at most a short-lived,
  repository-scoped installation token through the application's delivery
  mechanism. For GitLab, sandboxes receive no provider token at all.
- GitLab user tokens cover the whole account. A breach of host key custody
  exposes more than the equivalent GitHub token would. Applications should
  request the narrowest scopes. Without `comment_mr`, those are
  `read_user read_api write_repository`.
- OAuth state is signed, short-lived, bound to the initiating application
  user, and single-use.
- Unlinking revokes the provider grant and tombstones the link.

## Delivery plan

Each step is one small PR under the org contribution guide: conventional
title, squash merge, and an evidence report for the current head SHA.

1. `docs: specify connections and execution principals`. This document, plus
   status updates in CREDENTIALS.md and IDENTITY_MODEL.md.
2. `feat(credentials): add optional principal to CredentialRequest`.
3. `feat(connections): add kernel, ports, memory adapter, and conformance suite`.
4. `feat(connection-github): add GitHub App binding on Octokit strategies`.
5. `feat(connection-gitlab): add GitLab binding, request classifier, and
receive-pack parser`.
6. `feat(project-worker): reference an OpenMA connection instead of a PAT`.
   This lands after OpenMA ships connection references.

The OpenMA control plane follows ADR 0009 (GitHub) and ADR 0010
(self-managed GitLab) in open-managed-agents.

## Open questions

- Package names: `connections` and `connection-github`, or one
  `connections-github` package until a second provider exists.
- Which GitLab version is the minimum. Device flow can be disabled per
  instance, so the binding assumes only authorization code with PKCE.

## Unverified

- The GitHub token lifetimes above follow current GitHub documentation. They
  have not been exercised against the OpenMA deployment's App yet.
- Octokit strategy compatibility with the Cloudflare host has not been tested.
- GitLab OAuth token lifetime, refresh rotation, loopback redirect matching,
  `merge_request.*` push options, label auto-creation, token-page prefill,
  and `DELETE /personal_access_tokens/self` with only the allowed scopes have
  not been exercised on the test instance. They need a registered OAuth
  application, a dedicated test token, and a write test.
