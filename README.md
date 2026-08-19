# OpenMatter

**The integration and context framework for work agents.**

> Put agents into real work without putting their minds inside another framework.

OpenMatter is an open, embeddable TypeScript framework for connecting agents to chat, issue trackers, code hosts, kanban systems, forms, and scheduled work.

It is code-first. Applications write ordinary code to decide:

- which events activate an agent;
- which scope, matter, and work thread an event belongs to;
- what context the agent receives;
- whether an agent session is created or resumed;
- which operations the agent may perform;
- which reaction, including an explicit null reaction, completes the event.

OpenMatter supplies the integrations, lifecycle, persistence ports, observability, and runtime mechanics around that code. It does not replace the agent's reasoning or tool loop.

## Core flow

```text
Work platform or schedule
          ↓
      WorkEvent
          ↓
 AgentScope → Matter → WorkThread
          ↓
 AgentSession → Turn → OpenMAEvent stream
          ↓
       Reaction
          ↓
       WorkEffect
```

Every accepted `WorkEvent` reaches one terminal `Reaction`. A reaction may contain replies, reactions, forms, approvals, work-item mutations, or no effects at all.

## Framework shape

```ts
const app = createOpenMatter({
  integrations: {
    slack: slackIntegration({ token: process.env.SLACK_TOKEN }),
    linear: linearIntegration({ apiKey: process.env.LINEAR_API_KEY }),
  },

  agents: {
    worker: acpAgent({ endpoint: process.env.ACP_ENDPOINT }),
  },

  store: postgresStore(db),
});

app.on("slack.message.mentioned", async (work) => {
  const scope = await work.scopes.resolve("project");
  const matters = await work.matters.resolve(work.event);
  const thread = await work.threads.continue({
    scope,
    key: matters.primary?.id ?? work.event.source.threadId,
  });

  const context = await work.context.build(async (context) => {
    context.add(work.event);
    context.add(await work.integration("slack").readThread());

    for (const matter of matters.resolved) {
      context.add(await work.matters.materialize(matter));
    }
  });

  const result = await work
    .agent("worker")
    .session({ scope, thread })
    .turn({
      context,
      allow: ["slack.reply", "slack.react", "linear.comment.create"],
    });

  return work.react(result);
});

await app.run();
```

The SDK provides conventions and typed boundaries, not a closed configuration language. Custom functions can participate at every stage.

## Two replaceable boundaries

OpenMatter composes two semantic interfaces:

- **Work Integration** maps provider events, references, context, capabilities, authentication, and effects into OpenMatter.
- **Agent Driver** maps sessions, turns, event streams, permissions, cancellation, and results to ACP, Claude managed runtimes, in-process SDKs, or custom agents.

ACP is the first open Agent Driver binding. HTTP, WebSocket, webhooks, polling, and SDK calls are transport choices of a binding, not new core domains.

## Matter

A `Matter` is a durable identity for “the thing being worked on.” It may be represented by a Linear issue ID, GitHub pull request, URL, channel thread, team alias, natural-language phrase, or several of these at once.

OpenMatter does not require every mention to resolve. Unknown or ambiguous references retain their raw text and provenance until application code, a deterministic resolver, an agent proposal, or a user confirmation links them.

## Scheduled work

Proactive behavior is ordinary scheduled code:

```ts
app.schedule("issue-patrol", cron("*/15 * * * *"), async (work) => {
  const issues = await work.integration("linear").issues.list({ state: "open" });

  if (issues.length === 0) {
    return work.react.none("No open issues require attention");
  }

  const result = await work.agent("worker").session({
    scope: await work.scopes.resolve("project"),
    thread: await work.threads.continue("issue-patrol"),
  }).turn({ context: issues });

  return work.react(result);
});
```

Each schedule tick becomes a `WorkEvent` and follows the same scope, context, session, turn, and reaction lifecycle as provider events.

## Serializable where it matters

OpenMatter does not try to serialize application code. It emits versioned JSON records for:

- component manifests;
- provider capabilities;
- normalized events and references;
- scopes, matters, work threads, sessions, turns, and reactions;
- context provenance and authorization decisions;
- execution traces and effect receipts.

These records support visualization, auditing, replay, conformance testing, and storage neutrality while leaving the application fully programmable.

## What OpenMatter is not

- Not another prompt-chain, graph, planner, or agent-brain framework.
- Not a replacement for ACP, model SDKs, or agent-internal tools.
- Not a mandatory Hub, SaaS control plane, database, queue, or cloud.
- Not a closed JSON DSL that limits application behavior.
- Not tied to one IM, kanban product, runtime, transport, or deployment shape.

## Documentation

- [Product and architecture brief](docs/BRIEF.md)
- [Current design decisions](docs/DECISIONS.md)
- [Domain model](docs/DOMAIN_MODEL.md)
- [Code-first SDK shape](docs/SDK_SHAPE.md)
- [Work integrations and Matter references](docs/INTEGRATIONS.md)
- [Agent runtime and session lifecycle](docs/AGENT_RUNTIME.md)
- [Design references and platform APIs](docs/REFERENCES.md)

> [!IMPORTANT]
> OpenMatter is in its design and framework setup stage. The current interfaces are directional and will be validated through reference integrations, drivers, and a conformance harness before becoming a compatibility promise.
