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

OpenAPI / AsyncAPI / GraphQL + optional semantic overlay
                            ↓
                    OpenMatter Compiler
                            ↓
                    Work Profile JSON

                         runtime

work event → Scope → Matter → WorkThread → Agent Session
     ↑                                           ↓
work binding ← authorized Operation ← Reaction ← Turn
                            ↕
                    ACP / managed agent
```

OpenAPI describes how an API can be called. A Work Profile adds what an agent needs to understand work:

- operations and their input/output schemas;
- events and structured human interactions;
- Resource identities, aliases, and relationships;
- authority, capability, risk, confirmation, and idempotency metadata;
- provider bindings without live credentials.

## Compile a Work Profile

```ts
import { compileWorkProfile, openapi, overlay } from "@openmatter/compiler";

const result = await compileWorkProfile({
  sources: [openapi("./work-api.yaml")],
  overlays: [overlay("./work-semantics.yaml")],
});

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.severity, diagnostic.message);
}

await result.write("./dist/work-profile.json");
```

The compiler generates invocation mechanics and conservative safety defaults. It never invents a stable Resource identity or permission merely because a response contains a field named `id`.

Semantic enrichment is optional and serializable:

```ts
export default defineWorkProfile({
  source: openapi("./work-api.yaml"),

  resources: {
    issue: resource({
      identity: select("output", "$.id"),
      aliases: [select("output", "$.identifier")],
    }),
  },

  operations: {
    createIssueComment: operation({
      id: "issue.comment.create",
      target: "issue",
      class: "write",
      idempotency: "key",
    }),
  },
});
```

The authoring API emits equivalent Work Profile JSON. It is not a closed workflow language.

## Run it with an agent

```ts
const app = createOpenMatter({
  work: {
    project: createWorkSurface({
      profile,
      authority: { profile: profile.id, id: "workspace-1" },
      operations: openApiOperations({ credentials, fetch }),
      events: [projectWebhooks],
    }),
  },

  agents: {
    worker: acpAgent({ endpoint: process.env.ACP_ENDPOINT }),
  },

  store: postgresStore(db),
});

app.on("issue.updated", async (work) => {
  const scope = await work.scopes.resolve(resolveProjectScope);
  const matters = await work.matters.resolve(work.event);
  const thread = await work.threads.continue({
    scope,
    key: matters.primary?.id ?? work.event.subject,
    matters,
  });

  const context = await work.context.project({
    scope,
    thread,
    event: work.event,
  });

  const result = await work.agent("worker").session({
    scope,
    thread,
  }).turn({
    context,
    allow: ["issue.read", "issue.comment.create"],
  });

  return work.react(result);
});

await app.run();
```

Every valid received `WorkEvent` reaches one terminal `Reaction`. A reaction may request operations or deliberately contain no effects at all. Filtering is therefore observable as an explicit null reaction rather than a silent drop.

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

Schedules are ordinary event sources:

```ts
app.schedule("issue-patrol", cron("*/15 * * * *"), patrolHandler);
```

Each tick becomes a WorkEvent and follows the same Scope, Matter, WorkThread, Session, Turn, and Reaction lifecycle. OpenMatter can use an embedded scheduler or accept ticks from an external one.

## What OpenMatter is not

- Not a connector catalog that must hand-code every SaaS.
- Not a partial wrapper around Activepieces, Zapier, or another workflow runtime.
- Not another prompt graph, planner, or model SDK.
- Not a replacement for ACP, OpenAPI, AsyncAPI, GraphQL, or MCP.
- Not a mandatory Hub, SaaS control plane, credential service, database, queue, or cloud.
- Not a closed JSON workflow DSL.

## Documentation

- [OpenMatter SDK specification](docs/SDK_SPEC.md)
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
> OpenMatter is in its v0 design stage. Work Profile, binding, runtime, and AgentDriver interfaces remain provisional until exercised by reference implementations and a black-box conformance harness.
