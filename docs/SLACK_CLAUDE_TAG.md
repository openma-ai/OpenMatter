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

| Slack input                                                                      | OpenMatter event          | Important normalized semantics                                  |
| -------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| [`app_mention`](https://docs.slack.dev/reference/events/app_mention/)            | `slack.message.mentioned` | channel activation, root/thread timestamp, author, clean prompt |
| direct or threaded [`message`](https://docs.slack.dev/reference/events/message/) | `slack.message.received`  | `direct` or `thread` activation; bot/self messages are ignored  |
| slash command                                                                    | `slack.command.invoked`   | command, prompt, trigger ID; credential fields are removed      |
| `view_submission`                                                                | `slack.form.submitted`    | callback ID and unflattened structured form state               |

| OpenMatter operation | Slack API                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `message.reply`      | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage/) with `thread_ts` |
| `message.post`       | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage/)                  |
| `message.ephemeral`  | [`chat.postEphemeral`](https://docs.slack.dev/reference/methods/chat.postephemeral/)              |
| `message.react`      | [`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add/)                        |
| `view.open`          | [`views.open`](https://docs.slack.dev/reference/methods/views.open/)                              |

HTTP ingress reads the raw body once and implements Slack's
[`v0` signing-secret verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/),
including timestamp tolerance. URL verification, JSON Events API envelopes,
URL-encoded slash commands, and interactive `payload` forms are decoded before
they enter `WorkIntegration.ingest`. Slash-command `response_url`, modal
`response_urls`, and legacy verification `token` fields are stripped before
Queue, WorkEvent, Context, or Agent boundaries; the preset replies through the
bot-authenticated Web API.

## Claude Tag-style preset

`installClaudeTag(app, options)` is application code packaged as a reusable
preset. It is not a second runtime and it does not emulate Claude's mind.

The preset follows these defaults:

| Input           | AgentScope                   | WorkThread                  | Output                    |
| --------------- | ---------------------------- | --------------------------- | ------------------------- |
| channel mention | Slack workspace + channel    | Slack root thread           | reply in that thread      |
| direct message  | Slack workspace + DM         | DM root thread              | reply in that DM thread   |
| slash command   | Slack workspace + channel/DM | isolated command invocation | private ephemeral message |

The deterministic Scope and WorkThread bindings cause later activations in the
same thread to reuse the same durable Agent Session. Every Turn receives a new
immutable ContextProjection containing the triggering event plus items returned
by the application's `context` loader. Only the output operation required by
that activation is granted.

```ts
installClaudeTag(app, {
  agentId: "claude",
  // Use "channel" only when command output may be public.
  commandVisibility: "ephemeral",
  context: (work) => [
    work.context.value({
      kind: "channel-memory",
      value: { repository: "openma-ai/OpenMatter" },
      provenance: [
        { sourceType: "application-config", sourceId: "workspace-policy" },
      ],
    }),
  ],
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

The Cloudflare host deliberately does not require Durable Objects. A Store
adapter may use D1, Postgres, Redis, or another service as long as it implements
the Store's authoritative-clock, claim, fencing, snapshot, and outbox contract.

The durable outbox gives at-least-once provider delivery, not provider-level
exactly-once. Slack posting and modal methods do not accept OpenMatter's
idempotency key, so a provider success followed by a receipt-write crash may
repeat a post. `reactions.add` treats Slack's `already_reacted` response as an
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
performed. The host acknowledges each envelope before passing an immutable
snapshot of its native body through the same Slack integration. It retries
typed busy and infrastructure failures in-process, owns every processing Fiber,
and interrupts and waits for them during shutdown.

```ts
const service = makeLocalSlackService({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  botUserId: process.env.SLACK_BOT_USER_ID!,
  store,
  claude: agentDriver,
});

await service.start();
```

Socket Mode is a local/private-host transport, not the recommended Cloudflare
Worker transport: long-lived outbound WebSockets complicate isolate lifecycle
and billing, while Workers already provide a public HTTP endpoint. Switching
between these hosts does not alter the WorkEvent, Scope, Session, or Reaction
model.

Because Socket Mode is acknowledged before durable acceptance, a local process
crash in that gap can lose an envelope. The built-in local host is therefore a
best-effort development/private transport, not durability-equivalent to the
HTTP-plus-Queue host. A production local deployment that requires durable
ingress should place its own durable queue before `acceptFromEffect`.
