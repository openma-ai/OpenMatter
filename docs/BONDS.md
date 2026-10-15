# Bond: linked provider accounts and execution principals

**Status:** proposed (2026-10-12). The kernel `@openma/matter/bond` and the
GitLab binding `@openma/matter-gitlab/bond` are implemented; the GitHub binding
is not.
**Decision:** OpenMatter provides Bond, an optional, storage-free kernel that
links work-platform accounts, selects an explicit `ExecutionPrincipal`, and
produces a `CredentialResolver`. Applications own persistence, encryption
keys, HTTP routes, and membership-driven revocation.

## Bond and Loop

Work agents need two things from OpenMatter:

| Module | Answers                                                                                                      | Packages                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Bond   | who acts, and with which credential: installations, user links, link methods, principal selection, freshness | `@openma/matter/bond`, `@openma/matter-github/bond`, `@openma/matter-gitlab/bond` |
| Loop   | when the agent acts, and what it does: event and schedule sources, continuity, context, Reactions            | [Loops](LOOPS.md) and `@openma/matter-integration-*`                              |

Comparable products split the same way. Devin separates Integrations (an
organization connection plus personal account links) from Automations
(recurring and event-driven workflows). In OpenMatter an Automation is a
Loop: timers, webhooks, and pollers are already Event sources, so no second
automation concept is introduced.

Bond comes first. A Loop that writes to a provider needs a principal, and
Bond is where that principal comes from. The two meet at one seam: an
operation asks a `CredentialResolver` for the principal it requires, and Bond
resolves it. Loops and integrations never read links or tokens directly.

A Loop states the principal its operations use:

- `app`, the Installation principal. This is the default, and the only choice
  for schedules, webhooks, and other unattended sources.
- `requester`, the user who sent the triggering Event, when that user holds a
  valid UserLink and the tenant's `PrincipalPolicy` for the ProviderApp
  allows it. See [Principal selection](#principal-selection) for every
  combination.

Who created or owns a Loop is management metadata. It never lends the owner's
UserLink to unattended runs.

"Bond" names the durable relationship: an Installation is an app bond, and a
UserLink is a user bond. It is unrelated to the Work Binding and custom
binding terms in [Work Profiles](INTEGRATIONS.md), which name executable
adapter code.

## Why this exists

Agents act in work systems on behalf of people. Today OpenMA consumers pass a
static credential into each Session:

- the OpenMA console asks the user to paste a GitHub PAT for every
  `github_repository` resource;
- `@openma/matter-project-worker` sends one deployment-wide
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
- a `BondStore` port with written invariants, a conformance suite, and
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
credential service, and `@openma/matter/credentials` remains a resolver port.
[Work Profiles](INTEGRATIONS.md) already allows "OAuth installation
callbacks" as explicit, independently packageable custom bindings. These
packages are that kind of binding.

## Layering

```text
@octokit/auth-app, @octokit/auth-oauth-user, @octokit/auth-oauth-device
        provider protocol: App JWT, installation tokens, web and device flow
                │
@openma/matter-bond-github
        GitHub binding: install-and-authorize, repository intersection,
        repository-scoped installation tokens, attribution helpers
                │
@openma/matter/bond
        kernel: link state machine, token freshness, principal selection,
        audit facts, ports, conformance suite, memory adapter (tests only)
                │  produces
@openma/matter/credentials  CredentialResolver (unchanged port, extended request)
────────────────────────────────────────────── application layer
open-managed-agents   SQL adapter, purpose cipher/KMS, routes, console
Backchat              SQLite metadata + OS keychain, device flow UI
self-hosted hosts     their own store, routes, and key custody
```

The Bond packages depend only on `effect`, `@openma/matter/credentials`,
and Octokit. They do not depend on `@openma/matter` or the runtime, so a
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
  ├── Installation     the app principal in one provider account or org,
  │                    owned by exactly one tenant
  │                    (GitHub: App installation id, account login,
  │                     repository selection, status;
  │                     GitLab app mode: bot credential reference and the
  │                     group or project it covers)
  └── UserLink         one application user ↔ one provider user
                       (provider user id, login, method, sealed user
                        token, expiry, refresh lease, status)

ExecutionPrincipal     who performs one external operation
  = { kind: "app",  providerAppId, installationId }
  | { kind: "user", providerAppId, userLinkId, installationId? }
```

- `Installation.status`: `pending` → `active` → `suspended` | `revoked`.
- `UserLink.method`: `oauth` (provider authorization, refreshable) or `pat`
  (a user-supplied personal access token, not refreshable).
- `UserLink.status`: `active` → `refresh_failed` | `expired` |
  `method_disallowed` | `revoked`. Every non-active state keeps the reason
  and requires the user to re-link.
- A UserLink belongs to the ProviderApp, not to an Installation. A GitHub
  user-to-server token is issued per App and reaches every installation of
  that App the user can access. The kernel picks the Installation per
  operation, to bound access and to supply the app principal. One user
  therefore holds one link per ProviderApp, even when the tenant has several
  installations.
- The provider user id is the stable identity. A login is display data only.
- An Installation belongs to exactly one tenant. Claiming one requires proof
  that the claiming user can access it on the provider. For GitHub, that
  proof is `GET /user/installations` with the user's own token. An
  installation id seen in a callback, webhook, or log is never proof by
  itself. Moving an Installation to another tenant requires an explicit
  release by the owning tenant, or a provider-side uninstall followed by a
  new install. Sharing one Installation across tenants needs an explicit
  parent-to-child delegation layer, which is out of scope here.
- A GitHub ProviderApp is one `BotResource` in the sense of
  [IDENTITY_MODEL.md](IDENTITY_MODEL.md). Bond never creates one App per
  AgentProfile or persona.
- A GitLab ProviderApp represents one instance. It holds an OAuth
  application only when its link method policy enables OAuth. By default it
  has no Installation and no app principal. An administrator may register a
  bot credential (group access token, project access token, or service
  account token) as its Installation; that enables the app principal. Each
  GitLab instance, including gitlab.com, is a separate ProviderApp
  identified by its canonical origin.

## Principal selection

Each operation states the principal it requires and whether a person asked
for it. The kernel resolves the request against the `PrincipalPolicy` that the
application configures for the (tenant, ProviderApp) pair. A GitHub
ProviderApp is shared by many tenants, so the policy is a tenant setting, not
an App setting. Bond has no built-in default. OMA defaults GitHub to `user`
(ADR 0009) and GitLab to `user_only` (ADR 0010).

`ProviderAppSource` therefore returns the effective configuration for one
(tenant, ProviderApp) pair. The application may keep these fields per
workspace: `principalPolicy`, `participantsAsPrincipal`,
`allowUserPrincipalOutput`, `linkMethodPolicy`, `allowedScopes`,
`maxPatLifetimeDays`, and `identityBinding`. Provider identity (provider,
origin, OAuth client, GitHub App) is the same for every tenant.

The request (`ExecutionPrincipalRequest`) carries:

- `trigger`: `attended` when a person directly asked for the work in an
  interactive surface, such as a Session message or a chat mention addressed
  to the agent. `unattended` for schedules, webhooks, pollers, and service
  accounts. The host sets it from the Event source. It is never inferred from
  the presence of a user id: a webhook whose actor maps to an application
  user is still unattended.
- `runAs`: `app` or `requester`. `requester` requires `trigger: "attended"`
  and a `requesterId`. A request that breaks this fails with
  `invalid_principal_request`.
- `requesterId`: the application user who sent the triggering Event. With
  `runAs: "app"` it is used for attribution and audit only.

Resolution:

| `runAs`     | Policy      | Result                                                                                                                |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `requester` | `app`       | app principal, with fallback reason `policy_app`                                                                      |
| `requester` | `user`      | user principal when the requester's link is usable; otherwise app principal, with the link's state as fallback reason |
| `requester` | `user_only` | user principal when the link is usable; otherwise fails with `link_required` or the link's state                      |
| `app`       | `app`       | app principal                                                                                                         |
| `app`       | `user`      | app principal                                                                                                         |
| `app`       | `user_only` | fails with `unattended_unsupported` when unattended, `app_disallowed` when attended                                   |

The app principal needs an active Installation. Without one, resolution
fails with `unattended_unsupported` for unattended work and
`app_not_configured` for `runAs: "app"` or the `app` policy. Where the `user`
policy names a fallback and no Installation exists, the link's own failure is
reported instead, such as `link_required`, because that is what the user can
fix.

Rules:

1. Fallback happens only where the table names it. Whenever the resolved
   principal differs from the requested one, the resolution carries the
   reason and the audit fact records it. This satisfies "fallback from bot to
   user, or user to bot, is never implicit". A refresh that the provider
   rejects during the same call counts: under `user` the call falls back to
   the app principal with reason `refresh_failed`. A transport failure never
   changes the principal. It fails as retryable.
2. Unattended work never uses a person's link, under any policy and whether
   or not an Installation exists. Under `user_only`, unattended work fails
   with `unattended_unsupported` even when an Installation is registered.
3. A user principal is only usable for writes through a provider mechanism
   that marks the delegation, such as a GitHub App user-to-server token,
   which shows "with `<app>`" and sets `performed_via_github_app`. A provider
   without a marker, such as GitLab, needs the administrator opt-in
   `allowUserPrincipalOutput` from IDENTITY_MODEL.md. Without it, a
   user-principal write fails with `user_output_disabled`. It does not fall
   back to the app principal, because a silent switch would hide an
   administrator decision. Reads are unaffected.
4. Repository access for a user principal is the intersection of the
   installation's repositories and the user's own access. Selecting a
   principal never widens access.
5. A ProviderApp without an Installation (GitLab by default) offers only the
   user principal. Registering a bot credential as an Installation makes the
   app principal available.
6. The requester is the user who sent the triggering Event. They act as the
   user principal when they are the Session creator. A host that starts a
   Session for an Event records the sender as its creator. Another
   participant, a user who sent input into a Session someone else created,
   acts as principal only when the application enables
   `participantsAsPrincipal`. Otherwise the operation fails with
   `participant_not_allowed`. When the host does not supply the Session
   creator, the requester is treated as another participant. The chosen user
   is recorded in the audit fact.
7. When the tenant owns several active Installations of the ProviderApp, the
   operation must name one. Otherwise it fails with `installation_required`.

## Link method policy

`LinkMethodPolicy` is configured per (tenant, ProviderApp). It says how users
may link.

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
   ProviderApp). A new link, by either method, revokes the previous one
   first.
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
configurable warning window, and moves the link to `expired` at expiry or
when the application reports that the provider rejected the token. For an
OAuth link, such a report forces a refresh under the lease instead.

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
  // returns the effective configuration for one (tenant, ProviderApp) pair
  get(q: { tenantId; providerAppId }): Effect<ProviderAppConfig, ConfigError>;
}

interface BondStore {
  getInstallation(
    ref: InstallationRef,
  ): Effect<Installation | undefined, StoreError>;
  listInstallations(q: {
    tenantId;
    providerAppId;
  }): Effect<readonly Installation[], StoreError>;
  claimInstallation(
    value: Installation,
  ): Effect<"claimed" | "already_owned" | "owned_elsewhere", StoreError>; // unique by (provider app, provider installation id)
  updateInstallationCredential(q: {
    tenantId;
    installationId;
    credential: Sealed;
    credentialExpiresAt?;
  }): Effect<"updated" | "not_found", StoreError>; // owning tenant, active only
  releaseInstallation(
    ref: InstallationRef,
    actor: string,
  ): Effect<void, StoreError>;

  getUserLink(ref: UserLinkRef): Effect<UserLink | undefined, StoreError>;
  findUserLink(q: {
    tenantId;
    appUserId;
    providerAppId;
  }): Effect<UserLink | undefined, StoreError>;
  findUserLinkByProviderUser(q: {
    tenantId;
    providerAppId;
    providerUserId;
  }): Effect<UserLink | undefined, StoreError>;
  listUserLinks(q: {
    tenantId;
    providerAppId;
    status?;
  }): Effect<readonly UserLink[], StoreError>;
  upsertUserLink(
    value: UserLinkWrite,
  ): Effect<UserLink | "provider_user_taken", StoreError>; // idempotent by (tenant, provider user id, provider app)
  updateUserLinkStatus(q: {
    tenantId;
    linkId;
    status;
    reason;
  }): Effect<void, StoreError>; // never leaves revoked

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
  releaseRefreshLease(
    id: string,
    lease: RefreshLease,
  ): Effect<void, StoreError>;
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
  // used by provider bindings and application routes, not the kernel:
  // OAuth state and install state; short-lived, single-use
  sign(claims: LinkState, ttlSeconds: number): Effect<string>;
  verify(token: string): Effect<LinkState, StateError>;
}
```

`Clock` and `HttpClient` are injected so tests and edge hosts control time
and transport.

The application passes its implementations in when it builds the kernel:

```ts
const bond = makeBond({
  providerApps, // ProviderAppSource
  store, // BondStore
  cipher, // SecretCipher
  providers: { gitlab, github }, // BondProvider from each binding
  audit, // optional sink for audit facts
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
   An Installation has exactly one owning tenant. `claimInstallation`
   returns `owned_elsewhere` and changes nothing when another tenant owns it.
6. Plaintext tokens never pass through the store. It receives sealed values
   only.

## Conformance suite

`@openma/matter/bond` exports `bondStoreConformanceCases({ makeStore })`. It
returns framework-neutral cases that throw on failure, so each application
runs them in its own test runner, against its real adapter and database. The
suite covers idempotent upserts, ciphertext stored with its key id, tenant
isolation, a provider user held by another application user, lease races
with parallel callers (run concurrently, so a real adapter must serialize
them), expired-lease takeover and stale-lease commits, revoke-then-refresh,
status changes such as `method_disallowed`, one owning tenant per
Installation with release then claim, one link serving two Installations of
the same ProviderApp, `pat` links without refresh material, relinking the
same provider user with the other method in place, the newest active link
winning during a relink, and tenant-scoped replacement of an Installation
credential. Expiry and policy decisions are kernel logic and are covered by
the kernel tests, not by the store suite.

The memory adapter passes the same suite and is labelled test-only.

## CredentialRequest extension

```ts
type ExecutionPrincipalRequest =
  | {
      tenantId: string;
      trigger: "attended" | "unattended";
      runAs: "app";
      requesterId?: string; // attribution and audit only
    }
  | {
      tenantId: string;
      trigger: "attended";
      runAs: "requester";
      requesterId: string;
    };

interface CredentialRequest {
  readonly integrationId: string;
  readonly authority: string;
  readonly principal?: ExecutionPrincipalRequest; // new, optional
}
```

An absent `principal` keeps today's meaning for existing resolvers: the
installation credential for `authority`. Existing resolvers and integrations
therefore continue to work. A Bond-backed resolver requires `principal` and
fails closed without it. `staticCredentialResolver` holds one installation
credential, so it rejects `runAs: "requester"` instead of answering with the
installation credential. The Loop sets `principal` from the ScopeBinding,
the grants, and the Event source. Agent output cannot set it.

## Audit facts

Every credential resolution emits one immutable fact, whether it is granted
or denied. Values are identifiers, never tokens:

```text
outcome              granted | denied
denial               failure reason, when denied
requestingActor      application user or event actor that caused the work
trigger              attended | unattended
executionPrincipal   app | user, installation id, user link id; when granted
method               oauth | pat, for a user principal
policy               app | user | user_only
fallback             false | { reason }
access               read | write
operation            provider operation name
resource             resource address, such as a project path
```

Denials such as `link_required`, `unattended_unsupported`,
`participant_not_allowed`, and `user_output_disabled` are audited like
grants. Bond records who executed and why. It does not know which identity
appears on the work surface: the integration that writes the output records
the visible author and the provider receipt, keyed by the same operation.
Together they give the audit separation required by IDENTITY_MODEL.md:
visible author, execution principal, requesting actor, and provider receipt.

## GitHub binding

`@openma/matter-bond-github` provides:

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

`@openma/matter-gitlab/bond` covers gitlab.com and self-managed GitLab.
By default it uses no bot, and every operation runs as the linking user.
Project access tokens, group access tokens, and service accounts each create
a bot user. An administrator may still register one of them as the
ProviderApp's Installation, which enables the `app` and `user` principal
policies. A group access token is preferred because it covers the group's
projects.

GitLab facts that shape the binding. These were checked read-only against a
self-managed GitLab 17.1.8 instance on 2026-10-12:

- There is no App or installation. OAuth applications are owned by the
  instance, a group, or a single user.
- OIDC discovery lists `authorization_code` (PKCE `S256`) and
  `refresh_token`. GitLab documents device flow from 17.1, but this instance
  lists no `device_authorization_endpoint`, and `POST /oauth/authorize_device`
  returns 404, so the feature is disabled there. Desktop hosts therefore use
  authorization code with PKCE and a loopback redirect, and use device flow
  only where discovery advertises it.
- Scopes apply to the whole account. No scope narrows a user token to one
  project. The test account had Developer access or higher on hundreds of projects,
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
| app principal for unattended work                        | none by default; a registered bot credential (Installation) when the administrator enables app mode                               |

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

- `discoverInstance(origin)` reads OIDC discovery, requires PKCE `S256`,
  `refresh_token`, and an issuer equal to the origin, and records whether
  device flow exists. It returns no endpoints: OAuth calls always use the
  fixed `/oauth/*` paths under the canonical origin.
- `createPkce`, `authorizationUrl`, `exchangeCode`, `refreshAccessToken`, and
  `revokeToken` implement authorization code with PKCE. They never follow
  redirects.
- `readUser` and `readTokenInfo` read `GET /user` and
  `GET /personal_access_tokens/self`. `validatePersonalAccessToken(info, user,
policy)` and `validateBotCredential(info, user, policy)` return every
  problem: inactive, revoked, no expiry, expired, lifetime exceeded, scope
  outside the allowed set, token metadata and user that belong to different
  accounts, and a bot or human owner where the other is required.
- `classifyGitLabRequest(method, url)` returns
  `{ allow: true, projectRef, operation, surface } | { allow: false, reason }`
  for git smart HTTP and REST. Project references are normalized: case is
  folded, `.git` handling is unified, and numeric IDs and paths are treated as
  one reference. The application must resolve each reference to a numeric
  project ID before it authorizes the request, and forward a URL rebuilt from
  that ID and the returned `restTail`, never the raw path. REST reads are
  matched by exact shape, and encoded dots or backslashes are denied.
  GraphQL, LFS, archives, and unknown routes are denied. GitLab lets a merge
  request body name another project in `target_project_id`, so for `open_mr`
  the proxy also calls `mergeRequestBodyProblem(body, projectId)`.
- `makeReceivePackHeadParser(limits)` reads the pkt-line command list and
  push options incrementally from the request body, without reading the
  pack, in linear time. Capabilities are the union over every command line,
  as in git's `read_head`, so `push-options` cannot be hidden behind a later
  line. Decoding is strict UTF-8, ref names follow a strict subset of
  `git check-ref-format`, and the head size, command count, and option count
  are bounded. `parseReceivePackHead(bytes)` is the one-shot form. `evaluatePush(head, policy)` denies tags, deletions, the default
  branch, push options outside the merge request allow-list, and merge
  requests without the required label.
- Attribution helpers are pure functions. The commit author is the user's
  GitLab name and `commit_email`. Commits get an `Assisted-by: <app name>
<Session URL>` trailer. Merge requests get a label and a description footer
  that name the application, and "Requested by @user" with the app principal.
- `makeGitLabBondProvider` plugs the binding into the kernel: OAuth refresh
  and revocation, `DELETE /personal_access_tokens/self` for personal access
  tokens, and the stored bot credential as the app principal. Only OAuth
  `invalid_grant` ends a link. `invalid_client`, a missing OAuth
  application, and a client secret without `resolveSecret` are configuration
  errors that never mark links `refresh_failed`.

Delegated user output without a provider-native marker is allowed only under
the conditions in [IDENTITY_MODEL.md](IDENTITY_MODEL.md#executionidentity).

### GitLab bot accounts

A GitLab Installation is a bot credential that an administrator creates and
registers. Bond never creates one. These steps were checked on the
self-managed 17.1.8 instance:

1. Create the token. As a Maintainer of the project (Owner of the group),
   open Settings > Access tokens > Add new token. Choose the Developer role,
   the scopes `read_api` and `write_repository`, and an expiry date. These
   cover fetch, push, and merge requests opened by push options. By default
   Developer cannot push to protected branches. REST writes such as `comment_mr` need
   `api`, which grants every API write, so add it only when needed. GitLab
   shows the token once; put it in the host's secret store.
2. Validate it. `readTokenInfo` and `readUser` read the token and its bot
   user. `validateBotCredential(info, user, policy)` must return no problems.
3. Register it. Use the bot user's ID as `providerInstallationId`; it
   survives rotation. `tokenExpiryInstant` converts GitLab's date to the
   instant Bond stores.

   ```ts
   await bond.claimInstallation({
     tenantId,
     providerAppId,
     providerInstallationId: user.id,
     actor,
     verified: true,
     credential: { token, expiresAt: tokenExpiryInstant(info.expiresAt) },
   });
   ```

4. Choose the ProviderApp's principal policy. `app` always uses the bot,
   `user` uses the user's link and falls back to the bot, and `user_only`
   never uses it. Unattended work needs `app` or `user`.
5. Rotate before expiry. On 17.1.8 the bot cannot rotate its own token, so a
   human Maintainer calls `POST /projects/:id/access_tokens/:token_id/rotate`
   (or the `groups/` form) with `expires_at`. The bot user stays the same,
   the new token gets a new token ID, and the old token stops working at
   once. Register the new token by calling `claimInstallation` again with the
   same `providerInstallationId`; it returns `already_owned` and replaces the
   stored credential. `replaceInstallationCredential` does the same by
   Installation ID. Both drop the cached token.
6. Retire it. Revoking the token returns 401 for every later call, blocks the
   bot user, and removes it from the project. Call `releaseInstallation` so
   Bond stops selecting it.

The live lane in `examples/gitlab-bond-local` runs steps 2 to 5 in bot mode,
without a browser. Step 5 runs when it is given a Maintainer token.

## Consumers

| Consumer                                  | Runs the flow                                               | Store                         | Key custody                                               |
| ----------------------------------------- | ----------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| open-managed-agents                       | yes, web flow                                               | SQL tables via its migrations | `cipherFor(purpose)` / KMS                                |
| Backchat local                            | yes; GitHub device flow, GitLab PKCE with loopback redirect | SQLite for metadata           | OS keychain for tokens                                    |
| Self-hosted OpenMatter                    | yes                                                         | host's choice                 | host's choice                                             |
| `@openma/matter-project-worker` on OpenMA | no                                                          | none                          | none. It references an OpenMA connection instead of a PAT |

## Distribution

The kernel, including the Bond kernel, is published to npm as
`@openma/matter`; each provider is a separate package such as
`@openma/matter-gitlab`. All are released at one version with provenance
(docs/RELEASING.md). Consumers install exact versions:

```jsonc
"@openma/matter": "0.1.0",
"@openma/matter-gitlab": "0.1.0"
```

`@openma/matter` and every `@openma/matter-*` package in one consumer use the
same version. A bump is a reviewed lockfile change in the consumer. Git
dependencies on this repository are not supported, because some build
environments cannot download GitHub archives.

## Security notes

- The private key and client secret are bootstrap secrets. They are
  referenced, never stored by Bond, and never logged.
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

1. `docs: specify bond and execution principals`. This document, plus
   status updates in CREDENTIALS.md, IDENTITY_MODEL.md, and LOOPS.md.
2. `feat(credentials): add optional principal to CredentialRequest`.
3. `feat(bond): add kernel, ports, memory adapter, and conformance suite`.
4. `feat(bond-gitlab): add GitLab binding, request classifier, and
receive-pack parser`, with an opt-in live lane against a self-managed
   instance.
5. `feat(bond-github): add GitHub App binding on Octokit strategies`.
6. `feat(runtime): declare the execution principal of a Loop`.
7. `feat(project-worker): reference an OpenMA connection instead of a PAT`.
   This lands after OpenMA ships connection references.

The OpenMA control plane follows ADR 0009 (GitHub) and ADR 0010
(self-managed GitLab) in open-managed-agents.

## Open questions

- Which GitLab version is the minimum. Device flow can be disabled per
  instance, so the binding assumes only authorization code with PKCE.
- Whether shared Slack or Linear user linking should reuse UserLink, or stay
  installation-only until a concrete need appears. Both fit the same model:
  - Linear OAuth with `actor=app` installs the app in a workspace, and its
    token acts as the app. The default actor acts as the user.
    `createAsUser` renders app actions as "user (via application)";
  - Slack separates the workspace bot token from per-user tokens.

## Unverified

- The GitHub token lifetimes above follow current GitHub documentation. They
  have not been exercised against the OpenMA deployment's App yet.
- Octokit strategy compatibility with the Cloudflare host has not been tested.
- GitLab token-page prefill, `DELETE /personal_access_tokens/self` with only
  the allowed scopes, and exact matching for HTTPS redirect URIs have not been
  exercised on the test instance.
- Verified on the test instance by a prototype proxy (ADR 0010 in
  open-managed-agents, "Prototype results"): `merge_request.*` push options
  create a merge request, the missing label is created automatically, and
  receive-pack command parsing enforces ref and push-option policy.
- Also verified there, with OAuth: access tokens last 7200 s; a refresh
  rotates the pair and invalidates the old access token; reusing a
  rotated-out refresh token is refused but does not revoke the current pair,
  so the refresh lease is the only concurrency guard; loopback redirect URIs
  are matched without the port (RFC 8252).
- Verified there on 2026-10-13 with `examples/gitlab-bond-local` and the
  packages in this repository. OAuth, 14 of 14 checks: PKCE exchange, sealed
  storage, one refresh for six parallel callers, the old access token
  rejected after refresh, a relink of the same account updated in place,
  revoking the previous token left the new token valid (401 and 200), and
  unlink revoked the token. Bot, 6 of 6 checks: `validateBotCredential`,
  unattended work as the bot, fallback with `no_link` under `user`, and a
  Maintainer rotation that kept the bot user, invalidated the old token, and
  replaced the stored one.
