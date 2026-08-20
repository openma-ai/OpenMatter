# Slack integration and Claude Tag-style orchestration

| Field                  | Value                           |
| ---------------------- | ------------------------------- |
| Status                 | Executable v0                   |
| Work adapter           | `@openmatter/integration-slack` |
| Built-in orchestration | `@openmatter/orchestration`     |
| Cloud host             | `@openmatter/host-cloudflare`   |
| Local host             | `@openmatter/host-local`        |

This vertical slice intentionally separates four concerns:

```text
Slack HTTP or Socket Mode
          │ native payload
          ▼
@openmatter/integration-slack
          │ immutable WorkEvent
          ▼
Claude Tag preset ── ContextProjection ── AgentDriver
          │
          ▼
Reaction → WorkEffect → Slack Web API
```

The Slack adapter does not choose an Agent or build prompts. The preset does
not know whether its AgentDriver talks ACP, a managed Claude runtime, or an
in-process SDK. The host does not choose Scope or permissions.

## Slack semantic surface

| Slack input                                                                                     | OpenMatter event                                  | Important normalized semantics                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| [`app_mention`](https://docs.slack.dev/reference/events/app_mention/)                           | `slack.message.mentioned`                         | channel activation, root/thread timestamp, author, clean prompt |
| any human [`message`](https://docs.slack.dev/reference/events/message/)                         | `slack.message.received`                          | `direct`, `thread`, or non-activating `observation`             |
| `message_changed` / `message_deleted`                                                           | `slack.message.updated` / `slack.message.deleted` | durable message/thread address and prior content                |
| `reaction_added` / `reaction_removed`                                                           | `slack.reaction.added` / `slack.reaction.removed` | actor, emoji, and addressed message                             |
| slash command                                                                                   | `slack.command.invoked`                           | command, prompt, trigger ID; credential fields are removed      |
| [`block_actions`](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/) | `slack.action.invoked`                            | structured actions, container address, user, and trigger        |
| global or message shortcut                                                                      | `slack.shortcut.invoked`                          | callback, trigger, and optional message provenance              |
| `view_submission` / `view_closed`                                                               | `slack.form.submitted` / `slack.form.closed`      | callback ID, lifecycle, and unflattened structured state        |
| any other subscribed Events API event                                                           | `slack.event.received`                            | lossless portable provider event with `eventType`               |

The generic event is a passthrough fallback, not an automatic Agent activation.
Bot and self-authored messages also use this non-activating observation path, so
they remain auditable and can receive a terminal no-effect Reaction without
creating a reply loop. Applications still choose which event types to handle.

| OpenMatter operation      | Slack API                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.reply`           | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage/) with `thread_ts`                                           |
| `message.post`            | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage/)                                                            |
| `message.ephemeral`       | [`chat.postEphemeral`](https://docs.slack.dev/reference/methods/chat.postephemeral/)                                                        |
| `message.update`          | [`chat.update`](https://docs.slack.dev/reference/methods/chat.update/)                                                                      |
| `message.delete`          | [`chat.delete`](https://docs.slack.dev/reference/methods/chat.delete/)                                                                      |
| `message.schedule`        | [`chat.scheduleMessage`](https://docs.slack.dev/reference/methods/chat.scheduleMessage/)                                                    |
| `message.schedule.cancel` | [`chat.deleteScheduledMessage`](https://docs.slack.dev/reference/methods/chat.deleteScheduledMessage/)                                      |
| `message.react`           | [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add/)                                                                  |
| `message.unreact`         | [`reactions.remove`](https://docs.slack.dev/reference/methods/reactions.remove/)                                                            |
| `view.open` / `view.push` | [`views.open`](https://docs.slack.dev/reference/methods/views.open/) / [`views.push`](https://docs.slack.dev/reference/methods/views.push/) |
| `view.update`             | [`views.update`](https://docs.slack.dev/reference/methods/views.update/)                                                                    |
| `home.publish`            | [`views.publish`](https://docs.slack.dev/reference/methods/views.publish/)                                                                  |
| `file.upload`             | `files.getUploadURLExternal` → upload bytes → `files.completeUploadExternal`                                                                |

Message operations accept portable Block Kit `blocks` while remaining semantic
operations with separate grants. There is deliberately no catch-all
`slack.api.call` capability.

### Explicit Context reads

`makeSlackIntegration()` also returns `slack.context`. These methods materialize
bounded, portable `ContextItem` values only when application code asks for
them:

| Context method      | Slack API               | Result kind             |
| ------------------- | ----------------------- | ----------------------- |
| `thread(...)`       | `conversations.replies` | `slack.thread`          |
| `history(...)`      | `conversations.history` | `slack.channel-history` |
| `conversation(...)` | `conversations.info`    | `slack.conversation`    |
| `user(...)`         | `users.info`            | `slack.user`            |
| `file(...)`         | `files.info`            | `slack.file`            |

Pagination is explicit: a read returns one bounded page plus `hasMore` and
`nextCursor`. The adapter never silently crawls a workspace.

### SDK boundary

This package maps Slack into the SDK's Event, Context, Effect, authority, and
host shapes. It does not reproduce Slack's product SDK. OAuth UI, installation
storage, token rotation scheduling, Block Kit builders, app configuration,
admin/SCIM APIs, and arbitrary Web API calls stay in application or deployment
code. A credential store plugs in through the authority resolver:

```ts
const slack = makeSlackIntegration({
  credentials: (authorityId) => credentialStore.slack(authorityId),
});
```

The same resolver is used for ingress bot identity, Context reads, and Effect
delivery. Tokens are never placed in WorkEvents, Context, Agent input, or
provider receipts. For Slack Connect, authority is the app installation in
`authorizations[0].team_id`, not necessarily the workspace that originated the
message. For an organization-wide installation, authority is its Enterprise ID
and selects the org token. Slack's separate incoming `context_team_id` is the
workspace perspective of the channel; normalized events expose it as
`contextTeamId` only when it differs from authority, and channel operations send
it back as `client_context_team_id`. This follows Slack's
[organization-ready app model](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)
instead of conflating credential ownership with resource location. With static
single-workspace credentials, `botToken` and `botUserId` remain supported
directly.

Slack surfaces that require a synchronous, payload-bearing acknowledgement are
not disguised as durable Agent work. This v0 does not expose external-select
suggestions, modal field-error `response_action`, or other three-second
request/response callbacks. Those belong in an immediate HTTP/Socket handler;
their resulting durable work can still be submitted to OpenMatter afterward.

HTTP ingress reads the raw body once and implements Slack's
[`v0` signing-secret verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/),
including timestamp tolerance. URL verification, JSON Events API envelopes,
URL-encoded slash commands, and interactive `payload` forms are decoded before
they enter `WorkIntegration.ingest`. Slash-command `response_url`, interaction
`response_url`, modal `response_urls`, function `bot_access_token`, function
interactor secrets, and legacy verification `token` fields are stripped before
Queue, WorkEvent, Context, or Agent boundaries; the preset replies through the
bot-authenticated Web API. Successfully accepted ordinary inputs receive an
empty HTTP 200; only URL verification returns a JSON challenge.

## Claude Tag-style preset

`installClaudeTag(app, options)` is application code packaged as a reusable
preset. It is not a second runtime and it does not emulate Claude's mind.

The preset follows these defaults:

| Input           | AgentScope                   | WorkThread                  | Output                    |
| --------------- | ---------------------------- | --------------------------- | ------------------------- |
| channel mention | Slack authority + channel    | Slack root thread           | reply in that thread      |
| direct message  | Slack authority + DM         | shared DM conversation      | post in that conversation |
| threaded DM     | Slack authority + DM         | explicit Slack root thread  | reply in that thread      |
| slash command   | Slack authority + channel/DM | isolated command invocation | private ephemeral message |

The deterministic Scope and WorkThread bindings cause later activations in the
same channel thread—or ordinary messages in the same DM conversation—to reuse
the same durable Agent Session. An explicit Slack thread inside a DM gets a
separate WorkThread. Every Turn receives a new immutable ContextProjection
containing the triggering event plus items returned by the application's
`context` loader. Only the output operation required by that activation is
granted.

```ts
installClaudeTag(app, {
  agentId: "claude",
  // Use "channel" only when command output may be public.
  commandVisibility: "ephemeral",
  context: (work) => {
    const payload = work.event.payload as {
      channelId: string;
      contextTeamId?: string;
      threadTs: string;
    };
    return slack.context
      .thread({
        teamId: work.event.source.authority,
        ...(payload.contextTeamId === undefined
          ? {}
          : { contextTeamId: payload.contextTeamId }),
        channelId: payload.channelId,
        threadTs: payload.threadTs,
        limit: 50,
      })
      .pipe(Effect.map((item) => [item]));
  },
});
```

The preset is inspired by Anthropic's public description of
[`Claude Tag`](https://support.claude.com/en/articles/15594475-what-is-claude-tag):
one shared channel presence, threaded collaboration, channel context, and
replaceable work tools. OpenMatter does not claim API or implementation
compatibility with Anthropic's hosted product. In v0, a channel thread activates
the preset through an explicit mention; an ordinary channel thread message
without a new explicit mention produces a no-effect Reaction rather than waking
the Agent.

## Cloudflare: webhook plus Queue

Cloudflare has a public HTTP endpoint, so the preferred production shape is the
Slack Events API plus a Queue:

```text
Slack ─HTTP→ Worker.fetch
                ├─ verify raw-body signature
                ├─ Queue.send(portable native input)
                └─ return 200
                         │
                         ▼
                   Worker.queue
                         └─ app.acceptFromEffect("slack", input)
```

This keeps Slack acknowledgement latency independent of Agent latency. The
Queue consumer acknowledges a message only when `acceptFromEffect` succeeds;
invalid/non-retryable input is reported and acknowledged, while infrastructure
and busy-lease failures request Queue retry. Busy retries use the Runtime's
`retryAt`; other failures use a configurable backoff. Production Queue config
should set sufficient
[`max_retries`](https://developers.cloudflare.com/queues/configuration/batching-retries/)
and a dead-letter queue instead of relying on Cloudflare's default retry count.
Application construction and the durable Store are injected from the Worker
environment. See the
[Cloudflare example](../examples/slack-cloudflare/src/index.ts).

Provider delivery failures live in the durable outbox after the ingress Queue
message has been acknowledged. Mount the component's `scheduled` method on a
Cloudflare Cron Trigger so those receipts are retried independently of new
Slack traffic:

```ts
export default {
  fetch: worker.fetch,
  queue: worker.queue,
  scheduled: worker.scheduled,
};
```

The Cloudflare host deliberately does not require Durable Objects. A Store
adapter may use D1, Postgres, Redis, or another service as long as it implements
the Store's authoritative-clock, claim, fencing, snapshot, and outbox contract.

The durable outbox gives at-least-once provider delivery, not provider-level
exactly-once. Slack posting, scheduling, modal, and external file-upload methods
do not accept OpenMatter's idempotency key, so a provider success followed by a
receipt-write crash may repeat a post or leave an uncompleted upload ticket.
`reactions.add` and `reactions.remove` treat already-applied terminal states as
idempotent success.

Slack `trigger_id` values are short-lived and single-use. Applications that
open a modal should execute `view.open` on a short ingress path before queuing a
long Agent Turn; exposing the operation does not make a delayed trigger valid.

## Local Node: no webhook

When a laptop, private network, or local server cannot expose a Request URL,
`@openmatter/host-local` uses Slack's official
[`@slack/socket-mode`](https://docs.slack.dev/tools/node-slack-sdk/socket-mode)
client. Socket Mode delivers pre-authenticated envelopes over a reconnecting
WebSocket, so per-request signature verification is neither required nor
performed. The host first validates and persists an immutable snapshot of each
native body through `DurableInbox`, then acknowledges Slack. A supervised
consumer claims pending or expired items, renews fenced leases during long
Agent Turns, and completes or durably reschedules them. The host owns every
processing Fiber and interrupts and releases them during shutdown. It also owns a 30-second
durable-effect recovery interval by default; pass `recoveryIntervalMs: false`
only when an external scheduler calls `service.recover()` instead.

```ts
const inbox = makeSqliteInbox({
  filename: "./data/openmatter-inbox.sqlite",
});

const service = makeLocalSlackService({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  botUserId: process.env.SLACK_BOT_USER_ID!,
  store,
  inbox,
  claude: agentDriver,
});

await service.start();
```

Socket Mode is a local/private-host transport, not the recommended Cloudflare
Worker transport: long-lived outbound WebSockets complicate isolate lifecycle
and billing, while Workers already provide a public HTTP endpoint. Switching
between these hosts does not alter the WorkEvent, Scope, Session, or Reaction
model.

`@openmatter/inbox-sqlite` is the embedded Node adapter; another database or
queue can implement the same `@openmatter/inbox` port. Completed inbox rows are
retained for provider-envelope deduplication. The transport inbox does not
replace `OpenMatterStore`: a crash-safe standalone service needs both on durable
storage. Slack Web API Effects remain at-least-once where Slack exposes no
idempotency key.
