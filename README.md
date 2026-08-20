# OpenMatter

**The SDK that turns work APIs into interfaces agents can work with.**

> Compile APIs and events. Keep context and policy in your application. Leave the mind to the agent.

OpenMatter is an open, embeddable TypeScript SDK for putting external agents into chat, issue trackers, code hosts, kanban systems, forms, documents, and scheduled work.

It has two parts:

1. A compiler turns OpenAPI and other machine descriptions into a portable **Work Profile**.
2. A runtime uses that Profile to normalize work events, construct authorized context, manage agent sessions, and execute approved operations.

OpenMatter does not require a hosted connector service and does not require its maintainers to integrate every SaaS. A raw OpenAPI description provides generic operations immediately. Optional user or community profiles add work semantics such as Resources, event subjects, threading, risk, and interactions.

## Architecture

```text
                         build time

OpenAPI + optional semantic overlay
                            ↓
                    OpenMatter Compiler
                            ↓
                    Work Profile JSON

                         runtime

work event → OpenMatter Runtime → OpenMA Agent Contract
     ↑              ↓                    ↓
ingress adapters  OperationExecutor   ACP / managed agent
     ↑              ↓
webhook/stream/  ReactionDecision + durable operation receipts
timer occurrence
```

OpenAPI describes how an API can be called. A Work Profile adds what an agent needs to understand work:

- operations and their input/output schemas;
- events and structured human interactions;
- Resource identities, aliases, and relationships;
- authority, capability, risk, confirmation, and idempotency metadata;
- provider bindings without live credentials.

## Current packages

- `@openmatter/core` provides portable contracts and ports without Effect.
- `@openmatter/openapi` builds self-contained HTTP operation plans.
- `@openmatter/runtime` is the Effect-based event and Reaction runtime.
- `@openmatter/agent-openma` bridges the existing OpenMA Agent Contract.
- `@openmatter/testing` provides the Memory Store and Mock Work Adapter.
- `examples/deployment-shapes` shows the same SDK in embedded Node and
  Cloudflare-like request/timer/queue hosts.

See [Project structure](docs/PROJECT_STRUCTURE.md) for dependency direction and
package ownership.

## Build an HTTP operation

```ts
import { buildHttpRequest } from "@openmatter/openapi";

const request = buildHttpRequest({
  kind: "http",
  operationId: "issue.comment.create",
  method: "POST",
  pathTemplate: "/issues/{issueId}/comments",
  parameters: [{ name: "issueId", in: "path", required: true }],
  requestBody: { mediaType: "application/json", required: true },
}, {
  baseUrl: "https://work.example.com/api",
  input: {
    path: { issueId: "WEB-42" },
    body: { body: "Investigating now." },
  },
});
```

The first implementation slice makes the execution plan explicit. The full
OpenAPI compiler will generate this structure rather than asking the Runtime to
re-read a mutable source document.

## Process a work event

```ts
import { createOpenMatterRuntime } from "@openmatter/runtime";
import { createMemoryStore } from "@openmatter/testing";

const runtime = createOpenMatterRuntime({
  store: createMemoryStore(),
  ownerId: "worker-1",
  decide: async (event) => ({
    operationCallIds: [],
    reason: `Observed ${event.type}`,
  }),
});

const ingested = await runtime.ingest(event); // persist before acknowledging ingress
const processed = await runtime.process(ingested.event);

if (processed.status === "completed") {
  for (const callId of processed.reaction.operationCallIds) {
    await runtime.deliver(callId);
  }
}
```

Every valid received `WorkEvent` reaches one immutable terminal
`ReactionDecision`. Operation delivery has its own state and receipts; a null
decision has no operation intents and is still observable. Embedded Node
applications may use `runtime.accept(event)` as the convenience composition of
the same three steps. Serverless applications should queue their serializable
references between the steps.

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

## Proactive work

Schedules are host-owned event sources. A `TimerAdapter` maps one native timer
occurrence to ordinary WorkEvents:

```ts
const events = await patrolTimer.decode({
  id: "issue-patrol:2026-08-20T10:00:00Z",
  scheduledAt: "2026-08-20T10:00:00.000Z",
});

for (const event of events) {
  const receipt = await runtime.ingest(event);
  await queue.send({ kind: "event.process", event: receipt.event });
}
```

Cloudflare Cron, EventBridge, Kubernetes CronJob, and Node timers keep their own
registration, overlap, retry, and wake-up semantics. OpenMatter does not embed a
scheduler. Each decoded tick follows the same Scope, Matter, WorkThread,
Session, Turn, and Reaction lifecycle.

## What OpenMatter is not

- Not a connector catalog that must hand-code every SaaS.
- Not a partial wrapper around Activepieces, Zapier, or another workflow runtime.
- Not another prompt graph, planner, or model SDK.
- Not a replacement for ACP, OpenAPI, AsyncAPI, GraphQL, or MCP.
- Not a mandatory Hub, SaaS control plane, credential service, database, queue, or cloud.
- Not a closed JSON workflow DSL.

## Documentation

- [OpenMatter SDK specification](docs/SDK_SPEC.md)
- [Project structure](docs/PROJECT_STRUCTURE.md)
- [Technical design](docs/TECHNICAL_DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product brief](docs/BRIEF.md)
- [Current decisions](docs/DECISIONS.md)
- [Domain model](docs/DOMAIN_MODEL.md)
- [SDK shape](docs/SDK_SHAPE.md)
- [Work Profiles, bindings, and Matter references](docs/INTEGRATIONS.md)
- [Agent runtime and session lifecycle](docs/AGENT_RUNTIME.md)
- [Standards and platform references](docs/REFERENCES.md)

> [!IMPORTANT]
> OpenMatter is in its v0 implementation stage. The executable skeleton covers
> package boundaries, an Effect Runtime, HTTP plans, Memory Store, Mock Work
> and Timer Adapters, an OpenMA Agent bridge, and independently retryable
> ingest/process/deliver units. The wider Work Profile compiler remains
> provisional.
