# OpenMatter

**The SDK that turns work APIs into interfaces agents can work with.**

> Compile APIs and events. Keep context and policy in your application. Leave the mind to the agent.

OpenMatter is an open, embeddable TypeScript SDK for putting external agents into chat, issue trackers, code hosts, kanban systems, forms, documents, and scheduled work.

The executable foundation composes two replaceable boundaries: `WorkIntegration` normalizes work-platform events and effects; `AgentDriver` maps durable Sessions and Turns to ACP, managed runtimes, or custom agent SDKs. Application code owns context construction, policy, and orchestration.

Work Profiles and OpenAPI compilation remain a directional integration layer; no compiler package is claimed as executable yet. Arbitrary SaaS semantics cannot be inferred from OpenAPI alone.

**Immutable facts, explicit transitions.** Events, ContextProjection inputs, Turn inputs, permission decisions, Reactions, and effect intents are durable values rather than live mutable objects. Session, lease, and delivery state may change only through named, fenced state transitions. The runtime takes deep snapshots at asynchronous and durable boundaries; TypeScript `readonly` alone is not treated as immutability.

## Core flow

```text
native event                              agent runtime
    │                                          ▲
    ▼                                          │
WorkIntegration.ingest                  AgentDriver Stream
    │                                          │
    ▼                                          │
WorkEvent → ContextProjection → Session → Turn │
    │                                          │
    └──────── application handler ─────────────┘
                         │
                         ▼
                      Reaction
                         │
                         ▼
                    WorkEffect intents
                         │
                         ▼
               WorkIntegration.deliver
```

Every domain-complete accepted `WorkEvent` reaches one terminal `Reaction`. A reaction may contain replies, reactions, forms, approvals, work-item mutations, or no effects at all. Infrastructure failures leave recoverable claims instead of manufacturing false domain outcomes.

Directional Work Profiles may later describe operations, events, Resource identities, authority, risk, and provider bindings as portable JSON. Those artifacts complement the code-first runtime; they do not replace its authorization or context decisions.

## Current packages

- `@openmatter/core`, `@openmatter/store`, `@openmatter/integration`, and `@openmatter/agent` define the immutable records and three Effect-native ports.
- `@openmatter/runtime` provides the Event → Context → Session → Reaction → Effect lifecycle.
- `@openmatter/store-memory`, `@openmatter/integration-mock`, and `@openmatter/agent-mock` are executable test/reference adapters.
- `examples/basic` is the canonical executable composition; `examples/deployment-shapes.ts` shows host-owned request/serverless and long-lived source composition.

See [Project structure](docs/PROJECT_STRUCTURE.md) for dependency direction and
package ownership.

## Build an HTTP operation

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

Every domain-complete `WorkEvent` reaches one immutable terminal `Reaction`.
Operation delivery has its own durable receipts; a reaction with no effects is
still explicit and observable. Infrastructure failures keep recoverable claims
instead of manufacturing a false domain result.

## Work context

OpenMatter keeps distinct concepts distinct:

- `ResourceAddress` identifies a provider resource.
- `Matter` identifies the durable thing being worked on and may link several provider resources.
- `AgentScope` owns shared authority, policy, bindings, and candidate context.
- `WorkThread` owns the structured continuity of one piece of work across events and providers.
- `ContextProjection` is the authorized snapshot delivered to one Turn.
- `AgentSession` is an external runtime continuity handle, not the only durable source of truth.

A Channel is not automatically a Scope, WorkThread, or Agent Session. Multiple channels can share a Scope; one Matter can connect a message thread, issue, pull request, and document.

## Agent boundary

OpenMatter does not implement another agent brain. `AgentDriver` maps OpenMatter sessions, turns, operation grants, event streams, permissions, and cancellation to:

- Agent Client Protocol;
- managed-agent runtimes;
- in-process SDKs;
- MCP-backed tools;
- custom agents.

The agent owns reasoning, planning, transcript, and private tool state. OpenMatter owns work-side context, authority, continuity, reactions, and effect receipts.

## Deployment neutrality

The SDK owns no server, scheduler, queue, or process loop. A host constructs the
same application from its Store, Work Integration, and Agent Driver ports, then
calls `accept`, `acceptFrom`, or `consume`. See
[`examples/deployment-shapes.ts`](examples/deployment-shapes.ts).

Cloudflare Cron, EventBridge, Kubernetes CronJob, and Node timers keep their own
registration, overlap, retry, and wake-up semantics. OpenMatter does not embed a
scheduler. Each decoded tick follows the same Scope, Matter, WorkThread,
Session, Turn, and Reaction lifecycle.

All durable fields use one portable `JsonValue` contract. Integration-native payloads, Agent handles, and provider receipts remain available, but adapters must encode them as JSON instead of leaking live SDK objects into storage.

## What OpenMatter is not

- Not a connector catalog that must hand-code every SaaS.
- Not a partial wrapper around Activepieces, Zapier, or another workflow runtime.
- Not another prompt graph, planner, or model SDK.
- Not a replacement for ACP, OpenAPI, AsyncAPI, GraphQL, or MCP.
- Not a mandatory Hub, SaaS control plane, credential service, database, queue, or cloud.
- Not a closed JSON workflow DSL.

## Documentation

- [Product and architecture brief](docs/BRIEF.md)
- [Executable Effect runtime architecture](docs/RUNTIME_ARCHITECTURE.md)
- [Current design decisions](docs/DECISIONS.md)
- [Domain model](docs/DOMAIN_MODEL.md)
- [SDK shape](docs/SDK_SHAPE.md)
- [Work Profiles, bindings, and Matter references](docs/INTEGRATIONS.md)
- [Agent runtime and session lifecycle](docs/AGENT_RUNTIME.md)
- [Executable technical design](docs/TECHNICAL_DESIGN.md)
- [Standards and platform references](docs/REFERENCES.md)
- [Package structure](docs/PROJECT_STRUCTURE.md)
- Directional Work Profile layer: [architecture](docs/ARCHITECTURE.md) and [draft specification](docs/SDK_SPEC.md)

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
