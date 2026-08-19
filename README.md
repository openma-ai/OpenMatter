# OpenMatter

**The integration and context framework for work agents.**

> Context that puts agents to work, not another way to build them.

OpenMatter is an open, embeddable orchestration framework for bringing agents into chat, issue trackers, code hosts, kanban systems, forms, and scheduled work.

It composes two abstract protocols:

- the **Work Protocol**, defined by OpenMatter, normalizes platform events, resources, effects, capabilities, and authentication;
- the **Agent Protocol** normalizes agent sessions, attempts, streaming updates, permission requests, cancellation, and results. It has bindings for [Agent Client Protocol (ACP)](https://agentclientprotocol.com/get-started/introduction) and may support managed agent runtimes.

The OpenMatter orchestrator resolves scopes, projects context, freezes durable runs, executes attempts through an Agent Protocol binding, and sends typed effects back through a Work Protocol binding.

> [!IMPORTANT]
> OpenMatter is at the design and framework setup stage. The API sketches below explain the intended developer experience; they are not yet a released compatibility promise.

## Why OpenMatter?

Agents already know how to reason, use tools, and generate results. Putting them into real work introduces a different set of problems:

- Which workspace, project, channel, thread, or work item does an event belong to?
- What context is relevant and authorized for this run?
- How can retries stay reproducible while source conversations keep changing?
- How should an agent reply, react, request approval, update a form, or mutate a work item?
- How can one application run with different providers, stores, agents, and deployment topologies?

OpenMatter makes those concerns explicit and programmable.

## Core flow

```mermaid
flowchart LR
    P["Work platform"] <-->|"Work Protocol"| O["OpenMatter orchestrator"]
    O --> S["Scope resolution"]
    S --> C["Context projection"]
    C --> R["Immutable run"]
    R --> T["Attempt"]
    T <-->|"Agent Protocol"| A["ACP / managed agent"]
    A --> X["Result"]
    X --> O
```

Every normalized event produces an explicit reaction. The reaction may be a reply, update, approval request, tool-backed effect, or a deliberate null effect.

## Integration first

The first OpenMatter milestone focuses on Work Protocol integrations. An integration is more than a webhook wrapper; it maps four surfaces between a work system and the orchestrator:

| Surface | Responsibility |
| --- | --- |
| **Events** | Normalize messages, mentions, commands, forms, work-item changes, schedules, and callbacks into WorkEvent. |
| **Context** | Expose threads, records, files, boards, repositories, and other resources for authorized materialization. |
| **Effects** | Compile replies, reactions, forms, approvals, updates, and work mutations into provider API calls. |
| **Capabilities** | Declare supported operations, authentication requirements, permission scopes, and platform limits. |

Provider integrations should remain independently installable and testable against a shared harness. Agent Protocol bindings should be equally replaceable; ACP is the first open binding rather than the definition of the whole framework.

## Framework sketch

OpenMatter is intended to feel like a framework, not a hosted control plane:

```ts
const app = defineOpenMatter({
  integrations: [chat, codeHost, kanban],
  agents: [acpAgent, managedClaudeAgent],
  store,
  queue,

  scopes: {
    project: projectScope({ bindBy: ["repository", "channel", "board"] }),
    private: privateScope({ isolateBy: "actor" }),
  },

  routes: [
    when(messageMentioned())
      .useScopes("project", "thread")
      .collect(trigger(), recentThread(), referencedResources())
      .startRun(),

    when(schedule("*/15 * * * *"))
      .useScopes("project", "patrol")
      .collect(eventsSinceCursor(), openWorkItems())
      .startRun(),
  ],
});

await app.run();
```

Applications describe policy and context. OpenMatter performs the mechanical event, snapshot, attempt, and effect loop.

## Core model

| Concept | Meaning |
| --- | --- |
| **WorkEvent** | A normalized event from an IM, code host, kanban system, form, schedule, or custom source. |
| **AgentScope** | A user-defined boundary for resource bindings, context sources, policy, memory, and capabilities. |
| **ContextProjection** | The authorized, relevant, budgeted projection of active scopes for one run. |
| **Run** | A durable request with an immutable input and context snapshot. |
| **Attempt** | One disposable execution of a run. A retry creates a new attempt without silently changing the run input. |
| **Effect** | A structured outcome applied back to a provider, including an explicit null effect. |

## What OpenMatter is

- A framework for work-event ingestion, scope resolution, context engineering, durable runs, attempts, and effects.
- An orchestrator between Work Protocol and Agent Protocol implementations.
- A set of neutral interfaces, schemas, reference implementations, and a conformance harness.
- A library that can be embedded in infrastructure you own.

## What OpenMatter is not

- Not another model, prompt-chain, or agent-brain framework.
- Not a replacement for ACP, a model SDK, or an agent-internal tool loop.
- Not a required hosted hub, SaaS control plane, or central broker.
- Not tied to one IM, kanban product, database, queue, cloud, or deployment topology.

## Neutral by design

OpenMatter core depends on ports rather than infrastructure products:

- **WorkIntegration** supplies provider events, context resources, effects, capabilities, and auth.
- **AgentDriver** supplies sessions, attempts, updates, permission handling, cancellation, and results.
- **ScopeResolver** selects active scopes for an event.
- **ContextProjector** collects, authorizes, filters, ranks, budgets, and snapshots context.
- **RunStore** persists scopes, runs, attempts, effects, leases, and audit records.
- **AttemptRunner** executes a frozen run context through a selected AgentDriver.
- **EffectDispatcher** applies idempotent outcomes to source systems.

An implementation may use memory, SQLite, Postgres, object storage, queues, or a custom durable backend. It may run as an embedded library, a single process, a sidecar, a worker service, a serverless function, or a distributed deployment.

## Relationship to agent frameworks

OpenMatter manages the work around an agent. The selected Agent Protocol binding may use ACP, a managed agent API, or another compatible runtime; the agent may use any model or internal framework.

```text
Slack / Lark / Teams / GitHub / Kanban
                    |
              Work Protocol
                    |
          OpenMatter Orchestrator
                    |
              Agent Protocol
              /            \
            ACP      managed runtime
             |              |
       Claude / Codex / custom agent
       LangChain / LangGraph / other runtime
```

## Documentation

- [Product and architecture brief](docs/BRIEF.md)
- API reference, integrations, deployment guides, and examples will arrive with the first executable release.

## Initial direction

The integration-first milestone is expected to include:

- an integration contract covering Events, Context, Effects, and Capabilities;
- an Agent Protocol contract plus ACP and managed-runtime bindings;
- one complete reference work-system integration;
- a harness for provider capability, idempotency, and effect behavior;
- neutral schemas for events, scopes, context, runs, attempts, and effects;
- an in-memory runtime plus storage and deployment ports.

OpenMatter is being designed in the open. The repository will evolve from this brief into executable schemas, integrations, agent drivers, and a stable orchestrator.
