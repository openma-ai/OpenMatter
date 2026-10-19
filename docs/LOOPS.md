# Loops

| Field  | Value                                                           |
| ------ | --------------------------------------------------------------- |
| Status | Executable v0                                                   |
| API    | `Loop`, `defineLoop()`, `app.loop()`, and `@openma/matter-loop` |

A Loop is a built-in or user-defined process definition that keeps an Agent
present in a work environment. It repeatedly associates subscribed Events with
work continuity, projects authorized Context, optionally runs an Agent Turn,
and commits exactly one terminal Reaction for each accepted Event.

```text
Event source
    ↓
Loop activation and association
    ↓
AgentScope / WorkThread
    ↓
ContextProjection
    ↓
Agent Session / Turn
    ↓
Reaction / Effects
    ↓
wait for the next Event
```

The Loop does not prescribe the Agent's reasoning or tool-use sequence. It
orchestrates the world around the Agent: subscriptions, context, continuity,
grants, reactions, and recovery.

## User-defined Loop

```ts
import { defineLoop } from "@openma/matter/runtime";

const issueTriage = defineLoop(
  {
    id: "issue-triage",
    version: "0.1.0",
    description: "Triage issue updates with an Agent",
    spec: {
      sources: ["linear.issue.updated"],
      workThread: "linear.issue",
      session: "per-work-thread",
    },
  },
  (app) =>
    app.on("linear.issue.updated", (work) => {
      return work.react.none("No action required");
    }),
);

app.loop(issueTriage);
```

`loop.definition` is portable JSON. `loop.install` is executable application
code and is intentionally separate: standard definitions can be inspected and
visualized without pretending arbitrary TypeScript can be serialized.

## Configuration

A definition may declare `configSchema`, a small JSON Schema subset that a
host renders as a form, so one Loop serves many configured instances:

```ts
const review = defineLoop(
  {
    id: "mr-review",
    configSchema: {
      type: "object",
      properties: {
        projects: { type: "array", items: { type: "string" }, minItems: 1 },
        skipDrafts: { type: "boolean", default: true },
      },
      required: ["projects"],
    },
    requiredBonds: [
      { provider: "gitlab", operations: ["fetch", "comment_mr"] },
    ],
    runAs: "app",
  },
  (app, { config }) =>
    app.on("gitlab.merge_request.opened", (work) =>
      work.react.none(`watching ${String(config.projects)}`),
    ),
);

app.loop(review, { projects: ["project:42"] });
```

- Field types are `string` (with `enum`, `minLength`, `maxLength`),
  `number` and `integer` (with `minimum`, `maximum`), `boolean`, and `array`
  of one of those (with `minItems`, `maxItems`). Each may carry `title`,
  `description`, `default`, and host hints whose names start with `x-`.
  Anything else is rejected when the Loop is defined.
- `app.loop(loop, config)` validates the configuration, rejects unknown
  fields, fills defaults, and passes the result to `install` as
  `context.config`. An invalid configuration throws a TypeError listing every
  problem, and nothing is installed. A Loop without a schema accepts only an
  absent or empty configuration.
- Configuration holds no secrets. Provider credentials come from Bond.
- `resolveLoopConfig` and `loopConfigSchemaProblems` are exported so a host
  can validate a form before installing.

`requiredBonds` lists the provider accounts the Loop uses and the operations
it performs there. The runtime only checks its shape; a host compares it with
what the configured agent is granted before enabling an instance.

## Observed events and freshness

`spec.observes` lists event types the Loop records in their conversation
without handling them, such as chat messages that do not mention the bot.
The runtime records them through the Integration's `observe` before any
handler runs; handled types are recorded too. A conversation write the Agent
makes during its Turn, such as a reply, is checked against them
([Turn tool calls and conversation writes](./TURN_TOOLS.md)).

`freshnessField()` is the matching config field: one string with the presets
`thread` (default), `thread_requester`, `conversation`, and `off`, rendered by
a console as one control (`x-oma-widget: "freshness"`). `freshnessPolicy`
turns the configured value into the policy the Loop passes to the Turn:

```ts
const answer = defineLoop(
  {
    id: "chat-answer",
    spec: { sources: ["chat.mention"], observes: ["chat.message"] },
    configSchema: {
      type: "object",
      properties: { freshness: freshnessField() },
    },
  },
  (app) =>
    app.on("chat.mention", async (work) => {
      // ...project the context
      await work
        .agent("assistant")
        .session(binding)
        .turn({
          context,
          allow: ["chat.reply"],
          freshness: freshnessPolicy(work.config.freshness),
        });
      return work.react.none();
    }),
);
```

A Loop written as code may pass any `FreshnessPolicy`, including a list of
sender ids.

## Guest Loops

`@openma/matter-loop` is the package Loop code imports when it should run
outside the application process, for example in an isolate with no network.
It has no dependencies, not even Effect, so a Loop bundle carries nothing but
its own code.

```ts
import { defineLoop } from "@openma/matter-loop";

export default defineLoop(
  {
    id: "chat-reply",
    configSchema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    runAs: "app",
  },
  (app, { config }) =>
    app.on("chat.message.received", async (work) => {
      const context = await work.context.project({
        scopeId: "scope-1",
        workThreadId: work.event.id,
        items: [work.context.event()],
        grants: ["chat.message.reply"],
      });
      const turn = await work
        .agent(String(config.agentId))
        .session({
          scopeId: "scope-1",
          workThreadId: work.event.id,
          privacyPartition: "team",
        })
        .turn({ context, allow: ["chat.message.reply"] });
      const reply = await work.effect(context, {
        integrationId: "chat",
        operation: "message.reply",
        input: { text: turn.output ?? null },
      });
      return work.react.effects([reply]);
    }),
);
```

The handler API mirrors the native one with Promises instead of Effects.
Everything a guest handler can do goes through a `LoopHost`: five capabilities
(`projectContext`, `createEffect`, `acknowledge`, `agentTurn`, `agentCancel`)
whose arguments and results are portable JSON. The guest records (`WorkEvent`,
`ContextProjection`, `WorkEffect`, and the rest) are written out in the
package; `@openma/matter/runtime` checks at compile time that each one is
identical to its core or runtime counterpart.

- `work.acknowledge(context, input)` delivers an operation now, before the
  Reaction, such as a reaction that tells the sender their message was picked
  up. It is authorized like `work.effect` (the context must grant
  `<integrationId>.<operation>`, and it may not carry a `mutation`), but it is
  not durable: it is not in the outbox, it cannot be part of a Reaction, and a
  retried Event may deliver it again under the same idempotency key
  (`<event key>:ack:<n>`, counted apart from Effects). A delivery failure is
  returned as `{ status: "failed" | "uncertain", reason }`, never thrown, so
  the handler goes on. Use it only for an idempotent, low-stakes operation.
- `app.loop()` accepts a guest Loop as well as a native one and runs it in
  process. Configuration is validated the same way.
- `loadLoop(loop, config)` validates the configuration, runs `install` once,
  and returns a `LoadedLoop` with the registered Event types and a
  `handle(event, host)` function. It throws if the Loop registers no handler.
- A host that runs Loop code in an isolate loads the bundle there, wraps the
  isolate's `handle` in a `LoadedLoop`, and registers it with
  `installLoadedLoop(app, loaded)`. The runtime passes each Event's
  capabilities as `makeLoopHost(work)`; the host serves that object to the
  isolate as its RPC stub.
- A refused capability rejects with an `Error` whose `name` is the runtime
  error's tag (for example `AuthorizationError`), so it survives structured
  cloning.
- An Agent Turn returns an `AgentTurnSummary`: Session and Turn ids, outcome,
  output, and the Agent events as JSON. The full records stay in the host's
  store.

Native Loops from `@openma/matter/runtime` stay available for trusted code that
wants Effect directly, such as the built-in Loops below.

## Built-in Loop

```ts
import { claudeTag } from "@openma/matter-orchestration";

app.loop(
  claudeTag({
    agentId: "claude",
    commandVisibility: "ephemeral",
  }),
);
```

Built-in and user-defined Loops implement the same interface. `app.on()` remains
the low-level escape hatch used to build both. Scope, WorkThread, Session, Turn,
Reaction, and Effect retain their existing durable meanings; there is no
separate `LoopRun`, workflow graph, or hidden process runtime.

## Proactive Loops

A timer, queue, webhook, poller, or user action is an Event source. Proactive
behavior therefore uses the same Loop and Reaction lifecycle instead of a
special scheduler embedded in OpenMatter:

```ts
const patrol = defineLoop(
  {
    id: "issue-patrol",
    spec: { sources: ["schedule.issue-patrol.tick"] },
  },
  (app) =>
    app.on("schedule.issue-patrol.tick", (work) =>
      work.react.none("Nothing requires attention"),
    ),
);
```

The host owns timer registration, wake-up, overlap, and transport retries. The
Loop owns what a tick means once it becomes a WorkEvent.

## Execution principal

A Loop that writes to a provider acts as some principal. The principal comes
from [Bond](BONDS.md), not from the Loop. The Loop declares `runAs`, and the
host marks each WorkEvent `attended` or `unattended` from its source:

- `app`, the Installation principal, is the default. It is the only choice
  for timers, webhooks, pollers, and other unattended sources.
- `requester` runs an operation as the user who sent the triggering Event.
  It applies only to attended Events, such as a Session message or a chat
  mention addressed to the agent. A webhook whose actor maps to an
  application user is still unattended.

The tenant's principal policy for the provider then decides the outcome:

| `runAs`     | `app` policy                       | `user` policy                                            | `user_only` policy                                                       |
| ----------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `requester` | app principal, reason `policy_app` | the requester's link; app principal as recorded fallback | the requester's link, or `link_required`                                 |
| `app`       | app principal                      | app principal                                            | `unattended_unsupported` when unattended, `app_disallowed` when attended |

The requester acts as principal when they are the Session creator. Another
participant needs the application's `participantsAsPrincipal` opt-in. A Loop
that starts a Session for an Event records the sender as its creator.

Owning or configuring a Loop never lends the owner's account to unattended
runs. When no app principal exists, as on a GitLab instance without a
registered bot credential, an unattended write fails explicitly instead of
borrowing a person's link. `runAs` is part of the definition and defaults to
`app`. The runtime records it but does not resolve principals itself; the
host passes it to Bond when it requests a credential.

### Per Bond and per operation

One Loop may need different principals for different providers. A bug-triage
Loop answering a chat mention reads the code as the person who asked, so it
sees only what they can see, but replies in the chat as the bot. Each
`requiredBonds` entry may override `runAs`, with one value for the whole Bond
or one per operation:

```ts
defineLoop(
  {
    id: "feishu-bug-triage",
    runAs: "app",
    requiredBonds: [
      { provider: "gitlab", operations: ["fetch", "read"], runAs: "requester" },
      { provider: "feishu", operations: ["im_read", "im_send"] },
    ],
  },
  install,
);
```

`loopRunAs(definition, provider, operation)` resolves an operation's
`runAs`: the operation's own value, then its Bond's, then the Loop's, then
`app`. A per-operation map may only name operations listed in the same entry.
The policy table above still applies to each request, and an unattended
Event still never runs as `requester`.
