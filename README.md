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

**Immutable facts, explicit transitions.** Events, ContextProjection inputs, Turn inputs, permission decisions, Reactions, and effect intents are durable values rather than live mutable objects. Session, lease, and delivery state may change only through named, fenced state transitions. The runtime takes deep snapshots at asynchronous and durable boundaries; TypeScript `readonly` alone is not treated as immutability.

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

Every domain-complete accepted `WorkEvent` reaches one terminal `Reaction`. A reaction may contain replies, reactions, forms, approvals, work-item mutations, or no effects at all. Infrastructure failures leave recoverable claims instead of manufacturing false domain outcomes.

## Framework shape

```ts
import { Effect } from "effect";
import { makeMockAgentDriver } from "@openmatter/agent-mock";
import { makeMockIntegration } from "@openmatter/integration-mock";
import { createOpenMatter } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";

const chat = makeMockIntegration({ id: "chat" });
const worker = makeMockAgentDriver({ id: "worker", output: "Hello" });
const app = createOpenMatter({
  store: makeMemoryStore(),
  integrations: { chat: chat.integration },
  agents: { worker: worker.driver },
});

app.on("chat.message.received", (work) =>
  Effect.gen(function* () {
    const context = yield* work.context.project({
      scopeId: "project:openmatter",
      workThreadId: "discussion:runtime",
      items: [work.context.event()],
      grants: ["chat.message.reply"],
    });

    const result = yield* work
      .agent("worker")
      .session({
        scopeId: context.scopeId,
        workThreadId: context.workThreadId,
        privacyPartition: "team",
      })
      .turn({ context, allow: context.grants });

    const reply = yield* work.effect(context, {
      integrationId: "chat",
      operation: "message.reply",
      input: { text: result.output ?? null },
    });

    return work.react.effects([reply]);
  }),
);

await app.acceptFrom("chat", nativeWebhookBody);
```

This is the executable v0 surface. Real platform, durable-store, and Agent Driver adapters replace the mocks without changing handler semantics. The SDK provides conventions and typed boundaries, not a closed configuration language.

## Two replaceable boundaries

OpenMatter composes two semantic interfaces:

- **Work Integration** maps provider events, references, context, capabilities, authentication, and effects into OpenMatter.
- **Agent Driver** maps sessions, turns, event streams, permissions, cancellation, and results to ACP, Claude managed runtimes, in-process SDKs, or custom agents.

ACP is the first open Agent Driver binding. HTTP, WebSocket, webhooks, polling, and SDK calls are transport choices of a binding, not new core domains.

## Matter

A `Matter` is a durable identity for “the thing being worked on.” It may be represented by a Linear issue ID, GitHub pull request, URL, channel thread, team alias, natural-language phrase, or several of these at once.

OpenMatter does not require every mention to resolve. Unknown or ambiguous references retain their raw text and provenance until application code, a deterministic resolver, an agent proposal, or a user confirmation links them.

## Scheduled work

Proactive behavior enters through a scheduler/source adapter; it is not a special kind of agent or a timer hidden inside the Runtime:

```ts
app.on("schedule.issue-patrol.tick", (work) => {
  // Build context and optionally invoke an agent exactly as for a webhook event.
  return work.react.none("Nothing requires attention");
});

// Cloud scheduler, queue consumer, cron process, or test adapter:
await app.accept(scheduleAdapter.tick("issue-patrol", scheduledAt));
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

All durable fields use one portable `JsonValue` contract. Integration-native payloads, Agent handles, and provider receipts remain available, but adapters must encode them as JSON instead of leaking live SDK objects into storage.

## What OpenMatter is not

- Not another prompt-chain, graph, planner, or agent-brain framework.
- Not a replacement for ACP, model SDKs, or agent-internal tools.
- Not a mandatory Hub, SaaS control plane, database, queue, or cloud.
- Not a closed JSON DSL that limits application behavior.
- Not tied to one IM, kanban product, runtime, transport, or deployment shape.

## Documentation

- [Product and architecture brief](docs/BRIEF.md)
- [Executable Effect runtime architecture](docs/RUNTIME_ARCHITECTURE.md)
- [Current design decisions](docs/DECISIONS.md)
- [Domain model](docs/DOMAIN_MODEL.md)
- [Code-first SDK shape](docs/SDK_SHAPE.md)
- [Work integrations and Matter references](docs/INTEGRATIONS.md)
- [Agent runtime and session lifecycle](docs/AGENT_RUNTIME.md)
- [Design references and platform APIs](docs/REFERENCES.md)

> [!IMPORTANT]
> OpenMatter has an executable v0 vertical slice. Its contracts remain pre-stable until they are exercised by real integrations, Agent Drivers, durable stores, and a conformance harness.

## Executable foundation

The repository now contains the first runnable vertical slice:

- Effect Schema domain contracts;
- Effect Service/Layer ports for storage, work integrations, and agent drivers;
- persisted context projections with provenance, grants, and digests;
- authority/privacy-bound Agent Sessions and validated OpenMAEvent streams;
- enforced grants for Agent turns and provider operations;
- leased event/session/effect claims with full-lifecycle heartbeat renewal and stale-worker fencing;
- insert-once terminal Reactions, immutable authorized Effect intents, retry receipts, and outbox recovery;
- stable logical Turns, checkpointed Agent streams, durable permission decisions, and idempotent Session creation;
- memory storage, mock work-platform, and mock agent adapters;
- the same execution pipeline for request/serverless and long-lived sources.

Run it with:

```bash
pnpm install
pnpm check
```
