# OpenMatter: Product and Architecture Brief

| Field | Value |
| --- | --- |
| Status | v0 design brief |
| Category | Integration and context framework for work agents |
| Primary API | Code-first TypeScript SDK |
| Work boundary | `WorkIntegration` |
| Agent boundary | `AgentDriver`, with ACP and managed-runtime bindings |

## Product statement

OpenMatter is an open, embeddable framework that connects agents to work systems and supplies the runtime context around them.

Applications write ordinary code to decide:

- when an agent should run;
- which governance scope and ongoing work thread apply;
- what the event is about;
- which context is relevant and authorized;
- whether an agent session should be created or resumed;
- which operations may be exposed;
- how the agent's event stream becomes a terminal reaction.

OpenMatter owns the mechanical loop, typed boundaries, persistence ports, and observability. The agent retains responsibility for reasoning, planning, and internal tool use.

## Positioning

```text
Work systems                OpenMatter                    Agent runtimes

WorkIntegration  →  scope / matter / thread  →  AgentDriver
events + context     session / turn / reaction     ACP / managed / custom
effects + receipts       trace + persistence
```

OpenMatter is not:

- an agent-brain, graph, or prompt-chain framework;
- a replacement for ACP, model SDKs, or agent tools;
- a mandatory Hub, hosted control plane, or SaaS;
- a closed declarative language;
- a required database, queue, transport, or cloud topology.

## Code-first, observable by design

The framework does not try to serialize user code. Custom application functions may participate at every stage.

OpenMatter instead emits versioned JSON for observable boundaries and outcomes:

- component and capability manifests;
- normalized events and provider references;
- scopes, matters, work threads, sessions, turns, and reactions;
- context sources, provenance, redactions, and authorization decisions;
- agent runtime updates and permission requests;
- effect intents, delivery receipts, checkpoints, and execution traces.

This provides visualization, auditing, replay, and conformance without limiting the application to a JSON DSL.

## Core lifecycle

```text
provider event or schedule tick
             ↓
         WorkEvent
             ↓
       resolve AgentScope
             ↓
    resolve or retain Matters
             ↓
  create or continue WorkThread
             ↓
      project authorized context
             ↓
 create or resume AgentSession
             ↓
            Turn
             ↓
       OpenMAEvent stream
             ↓
          Reaction
             ↓
 idempotent WorkEffects or explicit null
```

Every accepted event reaches one terminal `Reaction`. Null is an intentional, observable reaction with no external effects.

## Core domains

### Integration

Translates provider-native events, resources, references, interactive surfaces, capabilities, authentication, and API operations.

Its primary contract is `WorkIntegration`.

### Work

The core domain. It decides how events become governed, contextualized work.

It owns `AgentScope`, `WorkThread`, context projection, capability narrowing, reactions, scheduling state, and the orchestration loop.

### Matter

Provides durable identity for “the thing being worked on.” A Matter may have platform IDs, URLs, aliases, natural-language descriptions, conversation anchors, and other representations.

Mention extraction, resolution, linking, ambiguity, and user or agent confirmation belong here. Resolution may remain incomplete.

### Agent Runtime

Normalizes agent sessions, turns, event streams, permissions, cancellation, and results through `AgentDriver` implementations.

ACP is the first open binding. Managed runtimes and in-process SDKs are supported through separate drivers.

## Two semantic boundaries

### WorkIntegration

```ts
interface WorkIntegration {
  manifest: IntegrationManifest;
  events: EventSource;
  references: ReferenceResolver;
  context: ContextProvider;
  effects: EffectSink;
  auth: AuthProvider;
}
```

An integration is more than a webhook wrapper. It declares and implements:

- event delivery, acknowledgement, deduplication, and correlation;
- provider-native structured references and links;
- authorized, lazy context materialization;
- typed effects and idempotent delivery receipts;
- capabilities, auth modes, permission scopes, rate limits, and platform constraints.

### AgentDriver

```ts
interface AgentDriver {
  manifest: AgentDriverManifest;
  capabilities(): Promise<AgentCapabilities>;
  createSession(input: CreateSessionInput): Promise<AgentSessionHandle>;
  resumeSession(input: ResumeSessionInput): Promise<AgentSessionHandle>;
  turn(input: AgentTurnInput): AsyncIterable<OpenMAEvent>;
  respondToPermission(input: PermissionResponse): Promise<void>;
  cancel(input: CancelTurnInput): Promise<void>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
```

Drivers preserve runtime differences through capabilities instead of pretending all runtimes are identical.

## Context ownership

OpenMatter distinguishes candidate context from delivered context.

- `AgentScope` defines the long-lived authority, subscriptions, bindings, policies, memory namespaces, and candidate resources.
- `WorkThread` collects the structured continuity of one piece of ongoing work.
- `ContextProjection` is the authorized and budgeted snapshot passed to one Turn.
- `AgentSession` is the runtime's opaque continuity handle and must not be the only durable source of truth.

Applications can replace each context stage with ordinary code. The default pipeline is:

```text
collect → authorize → filter → materialize → rank → budget → snapshot
```

Every included or excluded item retains provenance and a reason.

## Permissions

Scope permissions are policy inputs, not unconditional credentials.

```text
effective capabilities
  = integration capabilities
  ∩ agent capabilities
  ∩ scope policy
  ∩ actor authority
  ∩ provider surface policy
  ∩ request or approval state
```

Applications may add business policy at any stage. The runtime records the resulting capability decision.

## Scheduled work

Proactive behavior is not a separate agent type or lifecycle. Applications register scheduled work:

```ts
app.schedule("project-patrol", cron("*/15 * * * *"), async (work) => {
  // ordinary OpenMatter handler code
});
```

Each schedule tick becomes a normalized `WorkEvent` and follows the same Scope, Matter, WorkThread, Session, Turn, and Reaction lifecycle.

The scheduling port supports external or embedded schedulers. Overlap policy, timeout, retry, checkpointing, and idempotency are generic scheduled-task concerns.

## Storage neutrality

OpenMatter standardizes required behavior, not a database product:

- stable IDs and schema versions;
- event and effect idempotency keys;
- ordered runtime and audit records;
- compare-and-set or equivalent revision protection;
- expiring leases and recovery;
- atomic state transition and outbound-effect intent;
- context provenance and digests;
- checkpoints and configurable retention.

Implementations may use memory, SQLite, Postgres, document storage, event logs, or managed durable systems.

## Deployment neutrality

Supported shapes include:

- embedded library;
- single long-running process;
- sidecar;
- API ingress plus worker processes;
- serverless handlers;
- distributed integrations and workers sharing durable ports.

HTTP, WebSocket, webhook, polling, stdio, and in-process calls are binding transports. The OpenMatter core does not require a central network service.

## Framework ports

```ts
interface OpenMatterRuntime {
  accept(event: WorkEvent): Promise<ReactionReceipt>;
  triggerSchedule(input: ScheduledTrigger): Promise<ReactionReceipt>;
  run(signal?: AbortSignal): Promise<void>;
}

interface OpenMatterStore {
  events: EventRepository;
  scopes: ScopeRepository;
  matters: MatterRepository;
  threads: WorkThreadRepository;
  sessions: SessionRepository;
  turns: TurnRepository;
  reactions: ReactionRepository;
  checkpoints: CheckpointRepository;
}

interface SchedulerPort {
  register(task: ScheduledTask): Promise<void>;
  unregister(taskId: string): Promise<void>;
}
```

Queue, clock, scheduler, secret resolution, tracing, and blob storage are replaceable ports.

## Initial implementation milestone

The first executable milestone should include:

- TypeScript domain schemas and JSON records;
- the code-first handler and scheduling API;
- `WorkIntegration` and `AgentDriver` SDK contracts;
- one complete work-platform integration;
- an ACP AgentDriver;
- an in-memory store and scheduler;
- runtime traces and a basic visualizer;
- a black-box conformance harness for capabilities, idempotency, session lifecycle, and reactions.

The interfaces remain provisional until exercised by reference implementations and independent adapters.
