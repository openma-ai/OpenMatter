# Design: `@openma/matter-feishu`

| Field  | Value                                                                    |
| ------ | ------------------------------------------------------------------------ |
| Status | Proposed design, no code                                                 |
| Scope  | Feishu / Lark Bond binding and Work Integration: ingress, egress, models |
| Mirror | `@openma/matter-gitlab` (`packages/gitlab/src/bond/`), `packages/slack`  |

Paths without a prefix are in this repository. Paths prefixed `OMA` are in
`open-managed-agents`. Feishu API facts come from the Feishu Open Platform
documentation (links inline). Anything marked **(verify)** was not confirmed
from a primary source or a live tenant.

## 1. Summary

- `@openma/matter-feishu/bond` holds a **Binding** (manifest, resource
  catalog, token protocol, app provisioning) and an **Integration**
  (`ingest`, `deliver`, a context reader, agent tools, the `feishu-chat` Loop
  template). The Integration depends only on the credentials port.
- **Ingress** is one normalizer behind two transports: an HTTP webhook
  decoder (`HttpEndpoint`, isolate-safe, zero dependencies) and a
  long-connection adapter in a separate Node-only subpath
  (`/long-connection`) that wraps the Lark SDK's `WSClient`.
- **Egress** is a `FeishuEffectOperation` union delivered through
  `im/v1` with `uuid` idempotency, plus read-only context calls and an agent
  tool set gated by Bond grants.
- Three app models are supported with **one credential shape**: customer
  self-built app (pasted), auto-provisioned self-built app (one-click,
  device-flow style registration), and a shared marketplace app (store app,
  `app_ticket`). `ingest`/`deliver` are written once; the models differ in
  Binding creation and in how the credentials port mints `tenant_access_token`.
- **Bot identity** (`tenant_access_token`) and **user identity**
  (`user_access_token` from a Feishu user link) are kept apart everywhere;
  every egress row names the identity it uses.
- **Decision: customers always bring their own self-built app.** OpenMA
  does not publish a marketplace app (§10 item 12). Defaults: long
  connection; rollout pasted self-built → auto-provisioned self-built. The
  marketplace analysis below is kept for reference only.

## 2. Current OMA Feishu implementation inventory

OMA branch read: `feat/auth-store-avatar-url`. OMA's own write-up is
`OMA docs/integrations/feishu-current-architecture.md`; where it disagrees
with the code, the code is cited.

| Path                                                                                | Role                   | Transport                                     | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMA apps/main-node/src/lib/ws-feishu-runner.ts`                                    | ingress, lifecycle     | long connection via `@larksuiteoapi/node-sdk` | Production ingest. One `WSClient` per `app_id` (`:279-296`), opt-in `FEISHU_WS_RUNNER` (`OMA apps/main-node/src/config.ts:306`), single replica. Registers only `im.message.receive_v1` (`:532-537`). Rebuilds the envelope from the SDK's flattened payload and keeps only `sender`/`message`/`chat` (`:491-506`).                                                   |
| same, `handleMessage`                                                               | dedup, dispatch        | —                                             | `recordIfNew(event.deliveryId, …)` (`:406-413`) then `provider.dispatchEvent` (`:417`). The handler is `void`-ed (`:284`), so the SDK acks before anything is durable; a crash loses the event.                                                                                                                                                                       |
| `OMA apps/main-node/src/lib/feishu-egress-writer.ts`                                | egress (auto reply)    | REST                                          | One-shot writer on the in-process event hub: first `agent.message` only (`:84-94`), `replyText` under the inbound `message_id` (`:103-104`), 120 s timeout (`:59`), failures logged and dropped (`:117-126`). No delivery record.                                                                                                                                     |
| `OMA apps/main-node/src/lib/feishu-agent-tools.ts`                                  | agent tools            | REST                                          | Two AI-SDK tools: `mcp__feishu__im_message_send` (`:80-97`), `mcp__feishu__im_chat_read` (`:98-112`). Bot identity, plain text only. Resolved per Session from `sessions.metadata.publicationId` (`:123-140`).                                                                                                                                                        |
| `OMA packages/feishu/src/api/client.ts`                                             | egress, credentials    | REST                                          | `FeishuApiClient`: `sendText` (`:96-109`, `receive_id_type=chat_id`), `replyText` (`:119-131`), `updateText` PUT (`:134-142`), `getChatName` (`:145-158`), `addReaction` (`:161-169`), `removeReaction` (`:172-179`). Base URL hard-coded to `open.feishu.cn` (`:47`).                                                                                                |
| same, token                                                                         | credentials            | REST                                          | `auth/v3/tenant_access_token/internal` (`:187-243`), in-memory cache with 60 s skew and single-flight (`:71-81`), refresh-once on HTTP 401 (`:313-320`). Internal (self-built) apps only.                                                                                                                                                                             |
| `OMA packages/feishu/src/webhook/parse.ts`                                          | ingress (normalize)    | both                                          | `parseWebhook` / `parseWsFrame` (`:118-145`). Kinds: `url_verification`, `im.message.receive_v1`, `im.message.reaction.created_v1`, `bot_added`, `bot_removed` (`:21-26`); only the message kind is dispatched. Dedup key = `message_id ?? event_id ?? synthetic` (`:179-182`). No `encrypt` handling.                                                                |
| `OMA packages/feishu/src/webhook/signature.ts`                                      | ingress (verification) | webhook                                       | `detectSigningMode` (`:23-27`). `computeEncryptKeyChallenge` returns HMAC-SHA256 of "" keyed by the challenge (`:35-44`), which is not the documented Feishu protocol (see §3.1). No `X-Lark-Signature` check anywhere in `OMA packages/feishu/src`.                                                                                                                  |
| `OMA packages/feishu/src/provider.ts`                                               | ingress, sessions      | webhook                                       | `handleWebhook` (`:309-396`): URL verification looks the publication up by verification token, but `findPublicationByVerificationToken` always returns `null` (`:553-567`), so the HTTP challenge cannot succeed. `dispatchEvent` (`:464-549`) creates or resumes Sessions as the publication owner (`:513`) and attaches the Feishu MCP server URL (`:504`, `:517`). |
| `OMA packages/feishu/src/scope.ts`                                                  | sessions               | —                                             | `scopeKeyFor`: `chat:<id>` or `chat:<id>:user:<open_id>` (`:27-49`); no thread scope.                                                                                                                                                                                                                                                                                 |
| `OMA packages/feishu/src/config.ts`                                                 | manifest-ish           | —                                             | Capability keys (`:18-30`), default bot scopes (`:64-84`), subscribed events = `im.message.receive_v1` only (`:92-94`).                                                                                                                                                                                                                                               |
| `OMA packages/feishu/src/oauth/credentials.ts`                                      | credentials            | —                                             | Format checks for `app_id` (`cli_` prefix), `app_secret`, optional verification token and encrypt key (`:43-90`).                                                                                                                                                                                                                                                     |
| `OMA packages/feishu/src/signal.ts`                                                 | agent prompt           | —                                             | `<oma_signal>` protocol prompt (`:12-27`).                                                                                                                                                                                                                                                                                                                            |
| `OMA packages/http-routes/src/integrations/gateway.ts`                              | ingress (route)        | webhook                                       | `POST /feishu/webhook/pub/:pubId` (`:630`), challenge returned as `text/plain` (`:538-541`, `:581-584`), deferred dispatch via `waitUntil`. Setup landing page `/feishu-setup/:token` (`:426`).                                                                                                                                                                       |
| `OMA apps/main-node/src/modules/node-http.ts`                                       | wiring                 | —                                             | Boots the runner and agent tools when `feishuWsRunner` is set (`:655-700`).                                                                                                                                                                                                                                                                                           |
| `OMA apps/integrations/src/routes/feishu/{publications,setup-page}.ts`              | install                | HTTP                                          | `start-a1`, `credentials`, `publications/*`; credentials validated by minting a tenant token.                                                                                                                                                                                                                                                                         |
| `OMA packages/db-schema/src/cf-integrations/feishu.ts` (+ `node-pg`, `node-sqlite`) | storage                | —                                             | `feishu_publications` holds `app_secret_cipher`, `verification_token_cipher`, `encrypt_key_cipher` (`:108-110`); `feishu_webhook_events.delivery_id` PK (`:125-128`); `feishu_thread_sessions (publication_id, scope_key)` (`:176-188`). Migrations `OMA apps/main/migrations-integrations/0008_*.sql`, `OMA apps/main-node/migrations-sqlite/0003_*.sql`.            |
| `OMA packages/integrations-adapters-cf/src/d1/feishu/*`                             | storage                | —                                             | Installation, publication, session-scope, setup-link and webhook-event repos.                                                                                                                                                                                                                                                                                         |
| `OMA apps/console/src/integrations/pages/IntegrationsFeishu*.tsx`                   | UI                     | —                                             | List, workspace, 3-step publish wizard (paste four secrets).                                                                                                                                                                                                                                                                                                          |
| `OMA apps/main/src/routes/oauth.ts:349-364`                                         | user identity (MCP)    | OAuth                                         | Generic MCP OAuth with a Feishu preset: the official Feishu MCP server needs a pre-registered app (`FEISHU_OAUTH_CLIENT_ID/SECRET`). The registry entry is disabled (`OMA apps/console/src/data/mcp-registry.ts:49-59`). This is the only user-identity path in OMA today and it is separate from the bot.                                                            |

Defects worth not porting: wrong encrypt-key challenge, no decrypt and no
signature check, challenge lookup that always misses, ack before durable
write, `removeReaction` without a `reaction_id` (the API needs
`DELETE …/reactions/:reaction_id`,
[doc](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete)),
first-reply-only egress with no receipt, hard-coded `open.feishu.cn`, and
the rate limiter described in OMA's architecture doc does not exist in
`client.ts`.

## 3. Ingress catalogue

### 3.1 Verification, per transport

| Transport                | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook, encrypt key set | `X-Lark-Signature == hex(sha256(X-Lark-Request-Timestamp + X-Lark-Request-Nonce + encrypt_key + raw_body))`, checked before parsing. Body is `{ "encrypt": "<base64>" }`: AES-256-CBC, key = `sha256(encrypt_key)`, IV = first 16 bytes. After decrypt, `header.token` must equal the verification token. All of it is WebCrypto ([doc](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case)). Timestamp window: 5 min, our choice (Feishu documents none) **(verify)**. |
| Webhook, no encrypt key  | Plaintext `header.token` (v2) or `token` (v1) compared in constant time with the verification token. The doc calls this lower security; recommend requiring an encrypt key for webhook Bonds (§10).                                                                                                                                                                                                                                                                                                                                                               |
| URL verification         | `{ type: "url_verification", challenge, token }`, possibly inside `encrypt`. Check the token, then answer `200 {"challenge": "<challenge>"}` as JSON within 1 s **(verify the 1 s budget)**. No HMAC is involved.                                                                                                                                                                                                                                                                                                                                                 |
| Long connection          | None in our code. The SDK obtains a connection URL with `app_id`/`app_secret` and the channel is authenticated and encrypted by the platform ([doc](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)). Self-built apps only; up to 50 connections per app; each event goes to one random connection ("cluster mode").                                                                                                                                                           |

Delivery semantics for both transports: ack within 3 s (HTTP 200, or the SDK
handler returns without throwing), otherwise Feishu retries at 15 s, 5 min,
1 h, 6 h, at most 4 times
([doc](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)).
For messages Feishu says to dedup by `message_id`, not `event_id`
([doc](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)).

### 3.2 Catalogue

Status: **OMA** = handled today, **v1** = proposed for the first release,
**later**, **out** = out of scope. Authority = the Bond installation id the
host resolves; see "Tenant resolution" below.

| #   | Name                    | Mechanism                                | Feishu event type(s)                                                                              | Status                                                       | Dedup key           | Normalized `WorkEvent.type`                                                                                          | Loop can subscribe                                                                      |
| --- | ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Message received        | event v2, webhook or long connection     | `im.message.receive_v1`                                                                           | OMA (text only); v1 all types                                | `message_id`        | `feishu.message.received`; `feishu.message.mentioned` when the bot's `open_id` is in `mentions` or the chat is `p2p` | yes                                                                                     |
| 2   | Message recalled        | event v2                                 | `im.message.recalled_v1`                                                                          | v1                                                           | `event_id`          | `feishu.message.recalled`                                                                                            | yes                                                                                     |
| 3   | Reaction added/removed  | event v2                                 | `im.message.reaction.created_v1`, `im.message.reaction.deleted_v1`                                | parsed by OMA, not dispatched; v1                            | `event_id`          | `feishu.reaction.added`, `feishu.reaction.removed`                                                                   | yes                                                                                     |
| 4   | Bot added/removed       | event v2                                 | `im.chat.member.bot.added_v1`, `im.chat.member.bot.deleted_v1`                                    | parsed by OMA as `bot_added/bot_removed`, not subscribed; v1 | `event_id`          | `feishu.chat.bot_added`, `feishu.chat.bot_removed`                                                                   | yes; the host also uses it to refresh the resource catalog                              |
| 5   | P2P chat opened         | event v2                                 | `im.chat.access_event.bot_p2p_chat_entered_v1` **(verify name)**                                  | later                                                        | `event_id`          | `feishu.chat.p2p_entered`                                                                                            | yes                                                                                     |
| 6   | Chat disbanded          | event v2                                 | `im.chat.disbanded_v1`                                                                            | later                                                        | `event_id`          | `feishu.chat.disbanded`                                                                                              | yes                                                                                     |
| 7   | Bot menu                | event v2                                 | `application.bot.menu_v6`                                                                         | v1                                                           | `event_id`          | `feishu.menu.invoked` (`activation: "command"`)                                                                      | yes                                                                                     |
| 8   | Card action             | callback v2, webhook or long connection  | `card.action.trigger`                                                                             | v1                                                           | `event_id`          | `feishu.card.action` (`activation: "action"`)                                                                        | yes; the synchronous 3 s response is produced by the endpoint, not the Loop (see below) |
| 9   | URL verification        | HTTP challenge                           | `url_verification`                                                                                | OMA (broken); v1                                             | none                | none, answered in `http.ts`                                                                                          | no                                                                                      |
| 10  | `app_ticket`            | event v1, **webhook only**, about hourly | `app_ticket` (body `{ type: "event_callback", uuid, event: { app_id, app_ticket } }`)             | marketplace model only                                       | `uuid`              | none: stored through the credentials port                                                                            | no                                                                                      |
| 11  | Marketplace lifecycle   | event, webhook                           | first enable (`app_open`), status change, uninstall **(verify names)**                            | marketplace model only                                       | `event_id` / `uuid` | none: Binding installation create / suspend / revoke                                                                 | no                                                                                      |
| 12  | User OAuth callback     | browser redirect                         | `GET <redirect_uri>?code&state`                                                                   | v1 (marketplace) / alt.                                      | `state`             | none: Bond user link                                                                                                 | no                                                                                      |
| 13  | Device-flow poll        | outbound polling (not a push)            | `POST accounts…/oauth/v1/device_authorization` + token poll; app registration poll                | v1                                                           | `device_code`       | none: Bond user link / Binding creation                                                                              | no                                                                                      |
| 14  | Other subscribed events | event v2                                 | `drive.file.*`, `approval_instance`, `calendar.calendar.event.changed_v4`, `contact.user.*_v3`, … | out (passthrough)                                            | `event_id`          | `feishu.event.received` with `eventType`                                                                             | yes, raw only                                                                           |

Rows 10–13 never become `WorkEvent`s. They are Binding / credentials input,
so they live in the Binding half of the package and are routed by the host to
the Bond service, as GitLab's OAuth callback is. Rows 1–8 and 14 go through
`WorkIntegration.ingest`.

**Normalized Event.** `id = idempotencyKey = feishu:<authority>:<dedup key>`.
`source = { provider: "feishu", authority, conversationId: chat_id, threadId:
thread_id ?? root_id ?? message_id, messageId: message_id }`. `raw` keeps the
decrypted v2 envelope with credential-shaped keys (`token`, `encrypt`,
`app_secret`, `tenant_access_token`) removed, as `withoutGitLabCredentials`
does (`packages/gitlab/src/bond/integration/shared.ts:22-32`). Payload shapes
are in §6.

**Tenant resolution.** Self-built Bond: one app = one tenant, so the route
(`/v1/oma/bonds/{bondId}/events`) or the long-connection runner fixes the
authority; `header.app_id` must match the Binding's `appId`, else 401.
Marketplace Bond: one shared route; the host maps `(header.app_id,
header.tenant_key)` → installation, then decodes with that app's encrypt key.
Unknown `tenant_key` → 200 and drop (no retry storm), audited.

**Card action response.** Feishu requires an answer within 3 s that may carry
a toast or a replacement card
([doc](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)).
A Loop cannot be awaited inside that budget. The endpoint enqueues the event
and returns a static response chosen by the host option
(`cardActionResponse`, default `{}`); the Loop then updates the card through
the `card.update` Effect, which may use the callback's `token` (valid 30 min,
at most 2 updates) or the message id.

### 3.3 Webhook vs long connection

| Concern           | Webhook (`HttpEndpoint`)                                             | Long connection                                                                               |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Fits OpenMatter   | Directly: `HttpEndpoint` (`packages/matter/src/http/index.ts:10-14`) | Needs a host-owned socket, like Slack Socket Mode in `packages/host-local/src/index.ts:31-59` |
| Public ingress    | required                                                             | not required (outbound only); good for private deployments                                    |
| App models        | all three                                                            | self-built (models 2 and 3) only                                                              |
| Runtime           | Node, Workers, any isolate                                           | Node (SDK uses `ws` and protobuf)                                                             |
| Verification code | ours (WebCrypto)                                                     | SDK                                                                                           |
| Replicas          | any                                                                  | ≤ 50 connections per app; each event to one random connection                                 |

Proposed exports:

```text
@openma/matter-feishu/bond              isolate-safe, no runtime deps beyond @openma/matter
  decodeFeishuHttpRequest(request, { authority, appId, encryptKey, verificationToken?, botOpenId? })
    → FeishuEventInput | FeishuChallenge
  makeFeishuHttpEndpoint({ ...the same, submit, cardActionResponse? }) → HttpEndpoint
  normalizeFeishuEvents(input) → WorkEvent[]
  makeFeishuIntegration({ credentials }) → { integration, context, tools }
@openma/matter-feishu/long-connection   Node only, optional peer @larksuiteoapi/node-sdk
  makeFeishuLongConnectionSource({ baseUrl, appId, appSecret, authority, botOpenId?,
    cardActionResponse?, onState? }) → LongConnectionSource (host-local runtime)
```

Both transports produce the same `FeishuEventInput` (`{ kind: "feishu.event",
authority, transport, botOpenId?, envelope }`; `botOpenId` comes from
`inspectFeishuApp` and decides mentions), and `ingest` never knows which one
delivered it. The long-connection source hands the SDK's full v2 envelope
over unparsed (OMA drops everything except `sender`/`message`/`chat`,
`OMA ws-feishu-runner.ts:491-506`) and answers Feishu only after the host
runtime stored the event and called `ack`; otherwise it throws and Feishu
redelivers. The 3 s budget therefore covers one inbox write only.

Two ids, on purpose: the inbox item id is per delivery
(`feishuDeliveryId`, `feishu:<authority>:event:<event_id>`) and the Event id
is per message (`feishuEventId`, `feishu:<authority>:<message_id>`). Feishu
may push one message under several event ids with different envelopes; an
inbox refuses a reused key with a different body, so each delivery is
stored once and the runtime claims the Event once.

**Recommendation:** long connection is the default for self-built Bonds
(models 2 and 3, today's OMA behavior, no public URL); webhook is required
for the marketplace app and for Cloudflare-hosted deployments. Both ship in
v1.

## 4. Egress catalogue

Base URL is `https://open.feishu.cn/open-apis` or
`https://open.larksuite.com/open-apis`, chosen by the Binding's `brand`.
Identity: **bot** = `tenant_access_token`; **user** = `user_access_token` of
a linked user. Rate limits quoted are per API and per app
**(verify per-tenant vs per-app)**; message APIs document 1000/min and 50/s
([send](https://open.feishu.cn/document/server-docs/im-v1/message/create)).

### 4.1 Effects (`WorkIntegration.deliver`)

```ts
export const FEISHU_OPERATIONS = [
  "message.send",
  "message.reply",
  "message.update",
  "message.recall",
  "card.send",
  "card.reply",
  "card.update",
  "reaction.add",
  "reaction.remove",
] as const;
export type FeishuEffectOperation = (typeof FEISHU_OPERATIONS)[number];
```

**Implemented in v1** (`makeFeishuIntegration`, `makeFeishuDelivery`):
`message.send` `{ chatId, text | card }`, `message.reply`
`{ messageId, text | card, inThread? }`, `reaction.add`
`{ messageId, emoji }`, and `card.update` `{ messageId, card }`. A send or
reply takes exactly one of `text` and `card`, so `card.send` and
`card.reply` are not separate operations; `feishuMarkdownCard(markdown)`
wraps an Agent reply in a Card JSON 2.0 markdown card. The uuid is the first
32 hex digits of SHA-256 of the idempotency key. Ids are checked against
`oc_` / `om_` and `[A-Za-z0-9_-]` before any call. All run as the bot;
`openId` targets, `message.update`, `message.recall`, `reaction.remove`, and
callback-token card updates follow later. The table below is the full
design.

Every input carries `authority`; `principal` is optional (`"app"` default,
or `"requester"` when the Loop runs as the requester, resolved by Bond).

| Operation         | Feishu API                                                                                                            | Identity          | Input (beyond `authority`)                                      | Idempotency                                                                             | Limits / failures                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.send`    | `POST /im/v1/messages?receive_id_type=chat_id\|open_id`                                                               | bot               | `chatId` or `openId`, `text` or `post`                          | `uuid` = first 50 chars of a hash of `WorkEffect.idempotencyKey`; Feishu dedups for 1 h | text body ≤ 150 KB, post ≤ 30 KB; `230020` rate limit → retryable; `230025` too long → terminal; `230034` bad receive id → terminal                                                    |
| `message.reply`   | `POST /im/v1/messages/:message_id/reply`                                                                              | bot               | `messageId`, `text`/`post`, `replyInThread?`                    | `uuid`, same rule                                                                       | as above; `reply_in_thread: true` starts or continues a topic ([doc](https://open.feishu.cn/document/server-docs/im-v1/message/reply))                                                 |
| `message.update`  | `PUT /im/v1/messages/:message_id`                                                                                     | bot (own message) | `messageId`, `text`/`post`                                      | naturally idempotent                                                                    | text and post only; edit window and per-message edit cap **(verify)**; terminal on "too old"                                                                                           |
| `message.recall`  | `DELETE /im/v1/messages/:message_id`                                                                                  | bot (own message) | `messageId`                                                     | idempotent; "already recalled" treated as success **(verify code)**                     | recall window **(verify)**                                                                                                                                                             |
| `card.send`       | `POST /im/v1/messages` with `msg_type: "interactive"`                                                                 | bot               | `chatId`/`openId`, `card` (JSON 2.0) or `templateId`            | `uuid`                                                                                  | ≤ 30 KB including template data                                                                                                                                                        |
| `card.reply`      | `POST /im/v1/messages/:message_id/reply`, `interactive`                                                               | bot               | `messageId`, `card`, `replyInThread?`                           | `uuid`                                                                                  | ≤ 30 KB                                                                                                                                                                                |
| `card.update`     | `PATCH /im/v1/messages/:message_id` or `POST /interactive/v1/card/update` with the callback `token` **(verify path)** | bot               | `messageId` or `callbackToken`, `card`                          | idempotent (full replace)                                                               | `update_multi: true` required; messages ≤ 14 days old (`230031` terminal) ([doc](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)); callback token 30 min, 2 uses |
| `reaction.add`    | `POST /im/v1/messages/:message_id/reactions`                                                                          | bot or user       | `messageId`, `emojiType`                                        | duplicate reaction treated as success **(verify code)**                                 | receipt stores `reactionId`                                                                                                                                                            |
| `reaction.remove` | `DELETE /im/v1/messages/:message_id/reactions/:reaction_id`                                                           | same as add       | `messageId`, `reactionId` (or `emojiType`, resolved by listing) | idempotent ("not found" = success)                                                      | fixes the OMA bug in `client.ts:172-179`                                                                                                                                               |

Receipts: `{ messageId, threadId?, reactionId? }`. Failure classification
follows `packages/gitlab/src/bond/integration/client.ts:171-215`: HTTP 429,
5xx and Feishu rate-limit codes are retryable (`retryAt` from
`x-ogw-ratelimit-reset` when present **(verify header)**); invalid-token
codes (`99991663`, `99991668` **(verify)**) trigger one forced token re-mint
in the credentials port, then retryable; everything else is terminal. Feishu
returns HTTP 200 with a non-zero `code` for most failures, so `code` is the
source of truth (`OMA client.ts:327-336` already coerces string `"0"`).

`user` identity for `message.*` is deliberately not offered in v1: Feishu
lets a user token send as the user **(verify)**, which makes Agent output
look human-authored. That would need `allowUserPrincipalOutput`
(`docs/BONDS.md`, "Principal selection").

Not Effects in v1: file and image upload (`POST /im/v1/images`,
`POST /im/v1/files`, multipart; an Effect input must be portable JSON, so
this needs a blob-reference convention first), ephemeral cards, CardKit
streaming cards.

### 4.2 Context reads (Integration `context` reader, like `SlackContextReader`)

| Reader               | Feishu API                                                             | Identity                                                    |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `message`            | `GET /im/v1/messages/:message_id`                                      | bot                                                         |
| `thread` / `history` | `GET /im/v1/messages?container_id_type=chat\|thread&container_id=…`    | bot (needs history read scope)                              |
| `chat`               | `GET /im/v1/chats/:chat_id`                                            | bot                                                         |
| `user`               | `GET /contact/v3/users/:open_id?user_id_type=open_id`                  | bot (contact scope, visibility range applies)               |
| `resource`           | `GET /im/v1/messages/:message_id/resources/:file_key?type=image\|file` | bot                                                         |
| `doc`                | `GET /docx/v1/documents/:id/raw_content`, wiki `get_node` → docx       | **user** by default; bot only sees docs shared with the app |

### 4.3 Agent tools and the egress proxy

The Integration exports tools named by operation (`feishu.message.send`,
`feishu.message.reply`, `feishu.chat.read`, `feishu.history.read`,
`feishu.user.read`, `feishu.doc.read`); the host offers a tool only when the
agent's `bond_grants` cover its Bond operation (OMA ADR 0011, "Access rule").
They call the same client as `deliver` but are not Effects: a tool call is
part of the Agent Turn. For hosts that run an egress proxy instead
(OMA ADR 0007), the Binding exports `classifyFeishuRequest(method, path)` →
`{ operation, resource, identity }`, the counterpart of
`packages/gitlab/src/bond/classify.ts:9-35`, and the proxy injects the right
token. The agent never sees `app_secret` or a raw token.

### 4.4 Token endpoints (credentials port, not Effects)

| Call                                                                                               | Model       | Notes                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/v3/tenant_access_token/internal` `{ app_id, app_secret }`                              | self-built  | ≤ 2 h; a new token is issued when < 30 min remain; cache until 5 min before `expire`                                       |
| `POST /auth/v3/app_access_token` `{ app_id, app_secret, app_ticket }`                              | marketplace | ≤ 2 h ([doc](https://open.feishu.cn/document/server-docs/authentication-management/access-token/app_access_token))         |
| `POST /auth/v3/tenant_access_token` `{ app_access_token, tenant_key }`                             | marketplace | per tenant ([doc](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token)) |
| `POST /auth/v3/app_ticket/resend` `{ app_id, app_secret }`                                         | marketplace | when no ticket is stored (cold start)                                                                                      |
| `POST accounts…/oauth/v3/token` (form) `grant_type=authorization_code\|refresh_token\|device_code` | user link   | §6.4; client credentials in the body only (a Basic header as well answers 20070)                                           |
| `GET /bot/v3/info`                                                                                 | all         | bot `open_id` for mention detection, cached on the installation **(verify path)**                                          |

## 5. App models

### 5.1 Comparison

Model 1 is analysed for completeness but **not pursued** (§10 item 12). The
credential shape keeps `kind` so it can be added later without a migration.

| Aspect              | 1. Shared OpenMA marketplace app (应用商店应用)                                                 | 2. Customer self-built app (企业自建应用)                                                                                                          | 3. Auto-provisioned self-built app                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Install flow        | Tenant admin installs from the Feishu app store; first-enable event creates the installation    | Customer creates the app in the developer console, enables bot, adds scopes and events, publishes a version, pastes `app_id`/`app_secret` (+ keys) | One click: OpenMA starts an app-registration device flow, the user confirms in Feishu, OpenMA receives `client_id`/`client_secret` |
| Token acquisition   | `app_ticket` (pushed ~hourly) → `app_access_token` → per-`tenant_key` `tenant_access_token`     | `tenant_access_token/internal`                                                                                                                     | same as 2                                                                                                                          |
| Ingress shape       | One webhook for all tenants, routed by `tenant_key`; long connection not available              | Per-app webhook or long connection                                                                                                                 | Long connection (no encrypt key or callback URL is issued, see §5.3)                                                               |
| Permission / review | OpenMA's listing passes Feishu review; adding a scope needs a new version and tenant re-consent | Customer's admin approves the app version in their tenant                                                                                          | Depends on tenant policy for self-built apps **(verify)**; scopes preset by Feishu for the archetype **(verify)**                  |
| Bot identity        | One bot name and avatar for every customer ("OpenMA")                                           | Customer's own bot name, avatar, persona                                                                                                           | Generated name, for example "`<user>`的飞书 CLI" in lark-cli's case; renameable **(verify)**                                       |
| Public ingress      | required                                                                                        | optional                                                                                                                                           | not needed                                                                                                                         |
| Best fit            | Hosted SaaS at scale, low-friction installs                                                     | Private deployments, enterprises that want their own bot, today's OMA                                                                              | Individuals and small teams, trials, "connect Feishu" in under a minute                                                            |

### 5.2 One credential shape (evaluation of the proposed direction)

Keep the direction, with three changes. Proposed:

```ts
type FeishuAppKind = "self_built" | "marketplace";

/** Bond ProviderApp config (setupSchema), sealed fields marked x-secret. */
interface FeishuAppConfig {
  kind: FeishuAppKind;
  brand: "feishu" | "lark"; // change 1: selects open.feishu.cn vs open.larksuite.com
  appId: string;
  appSecret: string; // x-secret
  encryptKey?: string; // x-secret; required for webhook ingress
  verificationToken?: string; // x-secret
  ingress: "long_connection" | "webhook";
  provisioning?: { method: "paste" | "app_registration"; ownerOpenId?: string };
}

/** Bond Installation, one per tenant. */
interface FeishuInstallation {
  tenantKey: string; // change 2: per installation, not per app config
  botOpenId?: string; // cached from /bot/v3/info
}
```

- **Agree:** models 2 and 3 are the same `self_built` kind; they differ only
  in how the Binding is created (paste vs `app_registration`), recorded in
  `provisioning`. Model 1 adds `app_ticket` ingress and a per-`tenant_key`
  token cache. `ingest`/`deliver` are written once against a resolved
  credential and never branch on the kind.
- **Change 1 – `brand`:** OMA hard-codes `open.feishu.cn`; lark-cli's
  registration returns `tenant_brand` and switches domains
  (`internal/auth/app_registration.go` in `larksuite/cli`). Brand belongs in
  the credential.
- **Change 2 – split app and installation:** for model 1 `appSecret` is
  OpenMA's single ISV secret, held by the deployment, not copied into every
  customer's Bond; `tenantKey` is the installation key. For self-built apps
  the split is 1:1 and invisible. This matches the Bond kernel's
  ProviderApp / Installation split (`docs/BONDS.md`, "Domain model").
- **Change 3 – the Integration never sees this shape.** The credentials port
  resolves, per `CredentialRequest` (`packages/matter/src/credentials/index.ts:32-37`):

  ```ts
  interface FeishuCredentials {
    baseUrl: string; // from brand
    accessToken: string; // tenant_access_token (app) or user_access_token (requester)
    identity: "bot" | "user";
    botOpenId?: string;
  }
  ```

  like `GitLabCredentials { baseUrl, token }`
  (`packages/gitlab/src/bond/integration/client.ts:15-19`). The webhook
  decoder gets `encryptKey`/`verificationToken` from a host `lookup`, as
  `decodeGitLabHttpRequest` gets `webhookToken`.

Rollout **2 → 3 → 1** is right: 2 is OMA parity and unblocks the migration;
3 is a Binding-creation add-on to 2 with no new runtime path; 1 needs a
public webhook, an ISV listing and review, the `app_ticket` store, and
lifecycle events, and only pays off for hosted SaaS.

### 5.3 Model 3: how one-click provisioning works

Read from `larksuite/cli` source (MIT), not from Feishu documentation, which
does not describe this endpoint publicly as far as found **(verify)**:

- `lark-cli config init --new` calls
  `POST https://accounts.feishu.cn/oauth/v1/app/registration` (form-encoded)
  with `action=begin`, `archetype=PersonalAgent`, `auth_method=client_secret`,
  `request_user_info=open_id tenant_brand` (`internal/auth/app_registration.go`,
  `internal/auth/paths.go`). The response is device-flow shaped:
  `device_code`, `user_code`, `verification_uri`, `expire_in` (default 600 s),
  `interval` (default 5 s).
- The user opens `https://open.feishu.cn/page/cli?user_code=…` and confirms.
- The client polls the same endpoint with `action=poll&device_code=…`;
  `authorization_pending`, `slow_down`, `access_denied`, `expired_token`
  follow RFC 8628. Success returns `client_id` (the `app_id`),
  `client_secret` (the `app_secret`), and `user_info { open_id,
tenant_brand }`. A Lark-brand tenant switches polling to
  `accounts.larksuite.com` once.
- No encrypt key, verification token, or event-callback URL comes back, so a
  provisioned app should use the long connection. Whether the `PersonalAgent`
  archetype pre-subscribes `im.message.receive_v1`, enables the bot, and
  which scopes it grants is unknown **(verify)**; lark-cli's `event consume`
  command suggests events are usable on such apps **(verify)**.
- `lark-cli config bind --identity bot-only | user-default` shows the same app
  is meant to carry both identities.

Risks: undocumented endpoint, an archetype named for a personal agent, terms
of use for a third party calling it **(verify)**. Ship behind a deployment
flag, and fall back to model 2 if registration fails. In OpenMatter this is
`beginFeishuAppRegistration()` / `pollFeishuAppRegistration()` in the
Binding; the host persists the result as a `self_built` ProviderApp with
`provisioning.method = "app_registration"` and links the confirming user
(`ownerOpenId`).

## 6. Binding & credentials

### 6.1 Kernel gaps to close first

- `BondProvider.provider` is `"github" | "gitlab"`
  (`packages/matter/src/bond/ports.ts:195`); add `"feishu"` or widen to
  `string`.
- `LinkMethod` is `"oauth" | "pat"` (`packages/matter/src/bond/types.ts:10`).
  Feishu user links are OAuth (redirect or device code); app installs are
  "paste" or "app_registration", which are Binding-creation methods, not
  link methods. Add `"device"` as a link method, or treat device flow as an
  `oauth` variant **(decision, §10)**.
- `appCredential(config, installation, storedCredential)`
  (`ports.ts:225-232`) fits self-built apps (mint from `appSecret`), which
  are the only model pursued. A marketplace app would also need an
  `AppTicketStore` port for the latest `app_ticket`; not needed (§10 item 12).

### 6.2 Manifest

`feishuManifest: BondManifest` with `provider: "feishu"`, `setupSchema` =
`FeishuAppConfig` (secrets `x-secret`), `linkMethods: ["device", "oauth"]`, and:

| Resource kind | Id               | Operations (access)                                                        | Principal        |
| ------------- | ---------------- | -------------------------------------------------------------------------- | ---------------- |
| `chat`        | `chat:<chat_id>` | `im_read` (read), `im_send` (write), `im_react` (write), `im_card` (write) | app              |
| `doc`         | `doc:<token>`    | `docs_read` (read)                                                         | requester (user) |

Operation names use underscores because the kernel requires
`^[a-z][a-z0-9_]*$`. The first release declares only `chat`; `doc` follows
with the user-principal reads.

`chat_id` (`oc_…`) is stable across renames, as BONDS.md requires for
resource ids. `chat:*` in a grant covers every chat the bot is in.

Bot scopes the app needs (self-built: configured by the customer; model 1:
in the listing): `im:message.p2p_msg:readonly`,
`im:message.group_at_msg:readonly`, `im:message:send_as_bot`,
`im:message` (update, recall, reply), `im:message.reactions:write_only`
**(verify exact name)**, `im:chat:readonly`, `contact:user.base:readonly`,
`im:resource` (download). Optional and sensitive: `im:message.group_msg`
(every group message, not only mentions). User scopes for the user link:
`offline_access` (refresh token), `docx:document:readonly`,
`wiki:wiki:readonly`, `drive:drive:readonly` **(verify names)**. The
manifest lists them so a console can show a checklist; `validate` cannot
read granted scopes for a self-built app without a user token
**(verify `application/v6/applications/:app_id`)**.

### 6.3 Resource catalog

- `list`: `GET /im/v1/chats` (chats the bot is in) with `page_token`, bot
  identity.
- `validate`: `GET /im/v1/chats/:chat_id` must succeed with the bot token;
  write operations also fail when the chat is announcement-only for bots
  **(verify field)**. `doc:` resources are validated with the requester's
  user token (`GET /docx/v1/documents/:id`).

### 6.4 Two identities

| Identity | Token                                 | Obtained by                                                                                                                                                                          | Used for                                                                                                 | Stored                                                                |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bot      | `tenant_access_token`                 | §4.4, from the app config (+ `app_ticket`, `tenant_key` for model 1)                                                                                                                 | every Effect in §4.1, chat/history/user reads, catalog                                                   | never persisted; memory cache per `(appId, tenantKey)`, single-flight |
| User     | `user_access_token` + `refresh_token` | user OAuth on **the same app**: redirect (`accounts…/open-apis/authen/v1/authorize`, PKCE) or device flow (`accounts…/oauth/v1/device_authorization`, used by `lark-cli auth login`) | docs/wiki/drive reads, acting for the requester; the official Feishu MCP server uses the same token type | sealed on a Bond **UserLink** under the app's Binding                 |

A user link is a per-user credential under the Feishu Binding: Bond
`UserLink { bondId, providerUserId: open_id, tokens }`. `open_id` is
per-app, so the link key is `(appId, open_id)`; the inbound sender's
`open_id` matches because the event and the OAuth come from the same app
(ADR 0011 lists this as unverified; **verify on a live tenant**). The host maps
a sender to an OMA user with `findUserLinkByProviderUser` (ADR 0011).

Refresh (BONDS.md "Token lifecycle"): `user_access_token` lives about 2 h,
`refresh_token` about 7 days and only with `offline_access`; both values come
from the response, not constants
([doc](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)).
Refresh tokens are **single-use and rotate**
([doc](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token)),
so the kernel's refresh lease (compare-and-set, write the rotated pair
together) is mandatory. A rejected refresh moves the link to
`refresh_failed`; the user relinks. `revokeUserToken` →
`POST accounts…/oauth/v1/revoke` (as lark-cli does) **(verify for
third-party apps)**.

Redirect vs device flow: the redirect URL must be allowlisted in each app's
security settings, which customers of model 2 must do by hand and model 3
apps may not allow at all **(verify)**. Device flow needs no redirect.
Decision: device flow by default (§10 item 7).

Principal policy: messages to the bot (p2p or @mention) are `attended`;
everything else, including card actions from a user who did not address the
bot, is decided by the host from the event source (BONDS.md "Principal
selection"). Default policy for Feishu: `user` (fall back to app when the
sender has no link), with `allowUserPrincipalOutput: false`, so replies are
always posted by the bot even when reads use the user token.

## 7. Loop surface

Event types (`FEISHU_EVENT_TYPES`): `feishu.message.received`,
`feishu.message.mentioned`, `feishu.message.recalled`,
`feishu.reaction.added`, `feishu.reaction.removed`, `feishu.chat.bot_added`,
`feishu.chat.bot_removed`, `feishu.menu.invoked`, `feishu.card.action`,
`feishu.event.received`. Payloads (all also carry `authority`, `tenantKey`,
`resource: "chat:<chat_id>"`, `actor`):

```ts
interface FeishuActor {
  openId: string;
  unionId?: string;
  type: "user" | "bot" | "app";
}

interface FeishuMessagePayload {
  // message.received / message.mentioned
  activation: "mention" | "direct" | "observation";
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  messageType: string; // text, post, image, file, interactive, …
  text?: string; // plain text; @mentions replaced by names
  mentions: { key: string; openId?: string; name: string; isBot: boolean }[];
  fileKeys?: string[];
}
interface FeishuReactionPayload {
  messageId: string;
  emojiType: string;
  reactionId?: string;
}
interface FeishuChatPayload {
  chatId: string;
  operator?: FeishuActor;
}
interface FeishuMenuPayload {
  eventKey: string;
  chatId?: string;
}
interface FeishuCardActionPayload {
  activation: "action";
  messageId?: string;
  chatId?: string;
  action: {
    tag: string;
    value: JsonValue;
    name?: string;
    formValue?: JsonValue;
  };
  callbackToken: string; // for card.update, 30 min, 2 uses
}
```

Effect operations: §4.1. Template `feishu-chat` (replaces an OMA
publication): config `agentId`, `chats` (`x-oma-widget: "bond-resources"`,
`x-bond-provider: "feishu"`, or all), `session: "per_chat" |
"per_chat_user" | "per_thread"` (default `per_chat_user` for parity), and
`instructions`.

```ts
export const feishuMention = defineLoop(
  {
    id: "feishu-mention",
    version: VERSION,
    description: "Reply in thread when the bot is mentioned",
    spec: {
      sources: ["feishu.message.mentioned"],
      workThread: "feishu.thread",
      session: "per-work-thread",
      reaction: "effects",
    },
    runAs: "requester", // falls back to app per policy
    requiredBonds: [{ provider: "feishu", operations: ["im_read", "im_send"] }],
    configSchema: {
      type: "object",
      properties: { agentId: agentField, chats: chatsField },
      required: ["agentId"],
    },
  },
  (app) =>
    app.on("feishu.message.mentioned", async (work) => {
      const p = fields(work.event);
      if (p.actor?.type !== "user") return work.react.none("Not from a user");
      if (!watched(work.config, work.event))
        return work.react.none("Chat not watched");
      const authority = work.event.source.authority;
      const thread = String(p.threadId ?? p.rootId ?? p.messageId);
      const binding = {
        scopeId: `feishu:${authority}:chat:${p.chatId}`,
        workThreadId: `thread:${thread}`,
        privacyPartition: `feishu:${authority}:chat:${p.chatId}`,
      };
      const context = await work.context.project({
        ...binding,
        items: [work.context.event()],
        grants: ["feishu.message.reply"],
      });
      const turn = await work
        .agent(String(work.config.agentId))
        .session(binding)
        .turn({ context, allow: ["feishu.message.reply"] });
      const text = typeof turn.output === "string" ? turn.output.trim() : "";
      if (turn.outcome !== "completed" || text === "")
        return work.react.none(`Turn ${turn.outcome}`);
      const reply = await work.effect(context, {
        integrationId: "feishu",
        operation: "message.reply",
        input: {
          authority,
          messageId: String(p.messageId),
          text,
          replyInThread: true,
        },
      });
      return work.react.effects([reply]);
    }),
);
```

The bot's own messages never produce `feishu.message.mentioned` (the
normalizer drops events whose sender is the bot's `open_id`), so a reply
cannot trigger another reply.

**Implemented in v1** (`feishuAgent`, `feishuTemplates`): the sketches above
became one template, `feishu-agent`. It answers a direct message or a group
@mention with the configured Agent and posts the Agent's output as the bot's
reply.

- **What the template owns, and what it does not.** The template owns
  ingress (which chats and messages it answers), the Session binding, and
  egress (the reply). The Agent owns behaviour and tools: its instructions
  and skills, and its own Bond grants, such as read access to some GitLab
  projects. A bug-triage bot is a triage Agent bound by this template; the
  template has no `instructions` or GitLab fields. A tool and an Effect can be
  the same Bond operation; the difference is who calls it. The Agent calls a
  tool during the Turn, under its grant. The Loop delivers an Effect after the
  Turn, under its `requiredBonds`, so `requiredBonds` lists only the reply.
- **Identity.** The Loop declares `runAs: "requester"`: the Session acts for
  the person who asked, so the Agent's tools see only what they can. The
  Feishu Bond declares `runAs: "app"`, so the reply is always the bot's. A
  mention is an attended event, which is what `requester` needs.
- **Config.** `agentId` (`x-oma-widget: "agent"`), `chats` (`bond-resources`
  for `feishu`; empty means every group the bot is in, and direct messages
  are always answered), and `sessionScope` (`thread` default, `chat`,
  `chat_user`; `select`).
- **Context.** The template adds only facts: who asked, whether in a group or
  a direct chat, and that the output is posted as Feishu markdown.
- **Skips** a group outside `chats`, a message from an app, and a bare
  mention with no text.
- **Reply.** One `message.reply` with a markdown card; in a group it goes to
  the message's topic (`inThread: true`), in a direct chat it does not.
  Effects are delivered after the Turn ends, so the template adds no
  "received" reaction: it would arrive together with the answer.
- **Sessions.** `scopeId` `feishu:<authority>:chat:<chatId>`; `workThreadId`
  `thread:<threadId or messageId>`, `chat`, or `user:<openId>`.
- **Next.** The reply moves from a post-Turn Effect to a tool the Agent calls,
  checked against newer messages under a configurable freshness policy, with
  a conflict returned to the Agent. See
  [Turn tool calls and conversation writes](./TURN_TOOLS.md).

## 8. Package layout

```text
packages/feishu/                         @openma/matter-feishu (public, Apache-2.0)
  src/bond/
    index.ts                             Binding + Integration exports
    manifest.ts                          feishuManifest, scopes, FEISHU_OPERATIONS_BY_KIND
    resources.ts                         makeFeishuResourceCatalog, makeFeishuBinding
    provider.ts                          makeFeishuBondProvider: appCredential, refresh, revoke
    tokens.ts                            tenant/app/user token calls, AppTicketStore port
    oauth.ts                             authorize URL (PKCE), code exchange, device flow
    registration.ts                      app-registration begin/poll (model 3)
    classify.ts                          classifyFeishuRequest for egress proxies
    http.ts                              brand → base URL, fetch helpers
    integration/
      client.ts                          makeFeishuClient, makeFeishuCredentialsFor, code→retry mapping
      crypto.ts                          verifyFeishuSignature, decryptFeishuEnvelope (WebCrypto)
      http.ts                            decodeFeishuHttpRequest, makeFeishuHttpEndpoint, challenge
      events.ts                          FEISHU_EVENT_TYPES, normalizeFeishuEvents
      delivery.ts                        FEISHU_OPERATIONS, makeFeishuDelivery
      context.ts                         makeFeishuContextReader
      tools.ts                           agent tool descriptors + executors
      templates.ts                       feishu-agent (imports only @openma/matter-loop)
      shared.ts                          guards, withoutFeishuCredentials, feishuSource
      integration.ts / index.ts
  src/long-connection/index.ts           makeFeishuLongConnectionSource (Node only)
```

Exports `./bond` and `./long-connection`. Dependencies: `@openma/matter`,
`@openma/matter-loop`; peer `effect`, as `@openma/matter-gitlab`
(`packages/gitlab/package.json`). `/bond` needs no SDK: REST is plain
`fetch`, signature is SHA-256 and decrypt is AES-CBC, both in WebCrypto, so
it runs in Workers and Loop isolates. `@larksuiteoapi/node-sdk` is an
**optional peer dependency used only by `/long-connection`**, the same way
`host-local` depends on `@slack/socket-mode`. Reimplementing the
long-connection protocol (endpoint request, protobuf frames, fragment
reassembly, ping/pong, per-frame ack) would remove the SDK but is an
undocumented wire format **(verify)**; defer.

## 9. Migration from OMA

Order, matching ADR 0011's delivery plan:

1. OpenMatter: kernel widening (§6.1). `feat(feishu): app installation,
user link, resource catalog` (model 2 paste + user OAuth/device flow).
2. OpenMatter: `feat(feishu): ingest, long-connection source, delivery,
tools, feishu-chat`. Parity fixtures recorded from OMA's
   `parse.test.ts` and live events.
3. OMA: register the Feishu provider; the host runs
   `makeFeishuLongConnectionSource` per installation under a lease and the
   generic `/v1/oma/bonds/{bondId}/events` route for webhooks.
4. OMA: migrate `feishu_publications` → Bond ProviderApp + Installation
   (`kind: "self_built"`, `ingress: "long_connection"`) + a `feishu-chat`
   instance with the stored granularity.
5. OMA: delete the legacy pieces one release later.
6. OpenMatter: model 3 (`registration.ts`) behind a flag. Model 1 is not
   planned (§10 item 12).

| OMA today                                                                           | Replaced by                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/feishu/*` (client, parse, signature, scope, config, credentials)          | `@openma/matter-feishu/bond`                               |
| `ws-feishu-runner.ts`                                                               | `makeFeishuLongConnectionSource` + OMA host lease runner   |
| `feishu-egress-writer.ts`                                                           | `feishu-chat` Loop + `message.reply` Effect with a receipt |
| `feishu-agent-tools.ts`                                                             | Integration `tools`, gated by `bond_grants`                |
| `feishu_webhook_events` dedup                                                       | WorkEvent idempotency key in the OpenMatter store          |
| `feishu_thread_sessions`                                                            | WorkThread → Session binding                               |
| gateway `/feishu/webhook/pub/:pubId`, setup page, `apps/integrations` Feishu routes | `/v1/oma/bonds/{bondId}/events`, generic Bond install form |
| Feishu console pages, `feishu_*` tables, CF adapters                                | generic Matter pages, `bond_*`, `loop_*`, `matter_*`       |

Stays in OMA: SQL storage and sealing of Bond secrets, the lease runner that
runs `makeFeishuLongConnectionSource`, routes, console, the one-off migration,
and the generic MCP OAuth (`OMA apps/main/src/routes/oauth.ts:349-364`)
until the Feishu user link replaces it (§10 item 7).

## 10. Decisions

Recorded after review with the maintainer. Items marked **(verify)** still
need a live tenant or confirmation from Feishu.

1. **Default ingress.** Long connection; webhook (with `encryptKey`) for
   deployments that prefer an inbound URL, such as Workers-only hosts. Both
   ship in v1.
2. **Long connection.** Use `@larksuiteoapi/node-sdk` as an optional peer of
   `/long-connection` only; `/bond` stays SDK-free.
3. **Connections per app.** Allow up to N (default 2) connections per app;
   inbox dedup makes a single-holder lease unnecessary.
4. **Credential shape.** One shape with `kind` and `brand`; `tenantKey` and
   `botOpenId` live on the Installation; Integration credentials never carry
   `appSecret` (§5.2).
5. **Model 3.** Behind a deployment flag with model 2 as fallback, after
   Feishu confirms third parties may call `oauth/v1/app/registration`.
6. **Webhook encryption.** Required: `ingress: "webhook"` without
   `encryptKey` is rejected.
7. **User link.** Device flow, which needs no redirect allowlisting in the
   customer's app. Redirect stays available for customers who configure it.
   The same link supplies the token for the official Feishu MCP server, so the
   separate MCP OAuth preset can be removed.
8. **Link method.** Add `"device"` to `LinkMethod`.
9. **Group messages without a mention.** Off by default; enabling it needs
   the sensitive `im:message.group_msg` scope.
10. **Session granularity.** `per_chat_user` default; `per_thread` added.
11. **User-identity output.** Built-in Loops never write as the user. Custom
    Loops may, only when the administrator enables `allowUserPrincipalOutput`;
    Feishu shows no delegation marker on user-token messages **(verify)**.
12. **No marketplace app.** OpenMA does not apply for Feishu ISV status or
    publish a store app. Every tenant brings its own self-built app: model 2
    (paste) first, then model 3 (one-click) as the low-friction path. Cloud
    and private deployments show the same entry. `app_ticket`,
    `AppTicketStore`, the shared webhook and lifecycle events are out of
    scope.
13. **Several apps per tenant.** Supported by the existing kernel: many
    ProviderApps per tenant, Installations unique by
    `(providerAppId, providerInstallationId)`, UserLinks keyed by
    `(tenant, ProviderApp, provider user)`. `open_id` differs per app and
    `union_id` per developer, so links from different apps are joined through
    the application user, not through a Feishu id.
14. **Incremental scopes.** A user link requests only the scopes the current
    operation needs, within `allowedScopes`. When an operation needs a scope
    missing from `UserLink.scopes`, the host asks the user to authorize again
    for that scope and merges the result. The kernel needs an operation to
    required-scope check before resolving a user principal.
15. **Identity per operation in built-in Loops.** Replies, reactions, cards
    and chat reads use the app. Reads of the requester's private data (docs,
    wiki, drive, calendar free/busy, message search) use the requester,
    read-only, with a link prompt when no link exists. This needs `runAs` per
    operation rather than per Loop.

## 11. User experience

**Administrator.** The console's "Connect Feishu" asks for the app the
tenant owns. Model 3 is the quick path: scan a code, confirm in Feishu, and
the app is created. Model 2 is the manual path: create a self-built app, paste
`app_id`/`app_secret`, and follow the console's checklist of scopes and
events; ingress defaults to long connection, so no public URL is needed. A
Feishu administrator still approves the app version in their tenant. The
administrator then binds the bot to Agents and sets the identity policy (§10
items 11 and 14). A tenant that wants one bot per Agent creates one app per
Agent.

**Group default Agent.** When one bot serves several Agents, the bot
posts a setup card when it joins a chat ("Which Agent handles this chat?").
A chat owner picks once; the console can change it. `@bot /<agent> ...`
overrides it for one message. The reply card title names the Agent.

**Member.** `@bot` in a chat or thread. The bot adds a reaction, replies in
the thread with a card that updates with progress and has "View session" and
"Stop" buttons, and mentions the requester with a summary when done. Replies
in the thread continue the same Session.

**Member authorization.** Only when an operation needs the member's own data
does the bot send a direct authorization card for the minimum scopes. The
grant is refreshed silently, also serves the official Feishu MCP server, and
can be revoked in the member's settings. An optional member setting, "ask me
before acting as me", turns every user-principal write into a confirmation
card.

**Built-in Loop page.** Each built-in Loop shows, read-only, which identity
each operation will use after the administrator policy is applied, and why a
Loop cannot be enabled (for example, no app credential).

**Session view.** Each action shows whether it ran as the bot or as a
member, and the reason for any fallback.

## 12. Out of scope

Bitable, Sheets, approval, calendar, task, OKR and meeting events and write
APIs; drive file events beyond passthrough; file/image upload Effects until a
blob-reference convention exists; ephemeral and CardKit streaming cards;
mini-program and web-app identities; contact sync; message search; the marketplace app (model 1: ISV listing, `app_ticket`, shared webhook,
lifecycle events); and the Lark SDK's long-connection wire
format.
