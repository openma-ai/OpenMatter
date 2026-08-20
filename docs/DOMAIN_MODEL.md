# OpenMatter Domain Model

## Design rules

1. The Work domain is the core. Work Profiles and Bindings, Matter, and Agent Runtime are replaceable boundaries around it.
2. A channel is not necessarily a scope, a work thread, or an agent session.
3. Scope owns shared authority and candidate context. WorkThread owns the continuity of one ongoing piece of work.
4. AgentSession represents runtime continuity. It is not the durable source of business truth.
5. Every valid received WorkEvent produces one terminal Reaction, including an explicit null reaction.
6. Platform-native payloads and agent-native event details remain available through lossless extension fields.

## Core relationship

```text
AgentScope
├── shared policy, grants, bindings, memory namespaces
├── Matter links and resolver policy
└── WorkThread
    ├── source anchors
    ├── Matter links
    ├── durable thread context
    └── AgentSession
        └── Turn
            └── OpenMAEvent stream
```

## WorkEvent

A normalized immutable observation from a provider, an internal source, or a schedule. WorkEvent uses a CloudEvents 1.0 compatible envelope.

```ts
interface WorkEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time?: string;
  subject?: string;
  datacontenttype: "application/json";
  dataschema?: string;
  openmatterversion: "0.1";
  openmatterprofile: string;
  openmatterauthority: string;
  data: {
    payload: unknown;
    actor?: ResourceAddress;
    anchor?: WorkAnchor;
    references?: MatterMention[];
    native?: unknown;
  };
}
```

Common event classes include messages, mentions, commands, form submissions, action callbacks, comments, work-item changes, schedules, and custom application events.

The framework accepts Profile-specific event types. A global closed event enum is not required. The pair `(source, id)` is the logical deduplication key.

## ResourceAddress and WorkAnchor

A ResourceAddress identifies one object inside one configured provider authority.

```ts
interface ResourceAddress {
  profile: string;
  authority: string;
  type: string;
  id: string;
  containers?: Record<string, string>;
  aliases?: string[];
  uri?: string;
}
```

Provider IDs are commonly compound. For example, a Slack message is addressed by team, channel, and timestamp; a GitHub issue number requires repository context.

A WorkAnchor identifies where an observation happened and where a response may be directed.

```ts
interface WorkAnchor {
  conversation?: ResourceAddress;
  thread?: ResourceAddress;
  message?: ResourceAddress;
  interaction?: ResourceAddress;
  uri?: string;
}
```

An Anchor is not automatically an AgentScope, Matter, WorkThread, or AgentSession.

## AgentScope

A long-lived, application-defined governance boundary.

```ts
interface AgentScope {
  id: string;
  type: string;
  authority: string;
  revision: number;

  bindings: ScopeBinding[];
  subscriptions: Subscription[];
  policy: ScopePolicy;
  memoryNamespaces: string[];
}
```

A scope may represent a workspace, project, customer, private user boundary, channel, patrol assignment, or another application concept.

Multiple channels and providers may map to one scope. One channel may also resolve to different scopes based on thread, Matter, actor, or application policy.

Scope-shared state includes:

- capability and permission policy;
- provider and identity bindings;
- resource namespaces and aliases;
- shared durable facts and decisions;
- quotas, deduplication, and audit policy.

## Matter

A durable identity for the thing being discussed or worked on.

```ts
interface Matter {
  id: string;
  scopeId?: string;
  label?: string;
  state: "active" | "merged" | "closed";
  representations: MatterReference[];
  provenance: Provenance[];
}
```

A Matter can have multiple simultaneous representations:

```ts
type MatterReference =
  | ResourceAddress
  | UrlReference
  | AliasReference
  | TextReference
  | ConversationReference
  | CustomReference;
```

Examples include:

- a Linear issue UUID and human identifier;
- a GitHub repository and pull request number;
- a URL;
- a Slack thread;
- the alias “login problem” inside one project;
- the phrase “the release plan we discussed last week.”

### Mention, resolution, and identity

These concepts remain distinct:

```text
MatterMention   text or structured evidence observed in an event
MatterResolution candidate, resolved, ambiguous, unresolved, or denied outcome
Matter          durable identity accepted by the application
```

An unresolved mention remains useful context. OpenMatter never invents a provider ID merely to make a record look structured.

Agent-assisted resolution is optional. Agent results are recorded as proposals unless application policy explicitly promotes them.

## WorkThread

A logical continuity boundary for one ongoing piece of work.

```ts
interface WorkThread {
  id: string;
  scopeId: string;
  state: "open" | "closed";
  anchors: WorkAnchor[];
  matters: MatterLink[];
  revision: number;
}

interface MatterLink {
  matterId: string;
  role: "primary" | "supporting" | "output" | "related";
  linkedBy: "provider" | "rule" | "user" | "agent";
  confidence?: number;
  provenance: Provenance;
}
```

A WorkThread may span multiple channels and providers. One work thread can connect a Slack discussion, a Linear issue, a GitHub pull request, and a design document.

Default strategies are application-selectable:

- native provider thread;
- whole conversation;
- resolved primary Matter;
- work item or record;
- fixed named thread for recurring work;
- custom code.

## AgentSession

The framework's durable binding to an agent runtime session.

```ts
interface AgentSession {
  id: string;
  agentId: string;
  scopeId: string;
  workThreadId: string;
  driverId: string;
  externalHandle?: unknown;
  state: "open" | "interrupted" | "closed" | "expired";
  createdAt: string;
  lastUsedAt: string;
}
```

The recommended default key is:

```text
agent + authority + scope + workThread
```

Applications may choose fresh sessions per Turn or add actor, privacy partition, runtime profile, or time bucket to the key.

Session-private state includes runtime transcript, pending permission requests, tool continuations, cancellation, and opaque provider state. Durable facts needed for retry, audit, or cross-session continuity belong in OpenMatter records or referenced durable resources.

## Turn

One invocation inside an AgentSession, triggered by one WorkEvent or explicit continuation.

```ts
interface Turn {
  id: string;
  sessionId: string;
  triggerEvent: WorkEventRef;
  contextSnapshotId: string;
  inputDigest: string;
  retry: number;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
}
```

A retry keeps the same logical Turn input and increments retry metadata. Worker leases and transport attempts are runtime implementation details rather than public domain concepts.

Fork semantics are intentionally deferred from v0.

## ContextProjection

The authorized, relevant, and budgeted context passed to one Turn.

```ts
interface ContextProjection {
  id: string;
  scopeId: string;
  workThreadId: string;
  triggerEvent: WorkEventRef;
  items: ContextItem[];
  exclusions: ContextExclusion[];
  grants: CapabilityGrant[];
  digest: string;
}
```

```ts
interface WorkEventRef {
  source: string;
  id: string;
}
```

The projection may include trigger data, recent conversation, Matter materializations, shared scope facts, thread decisions, forms, files, metrics, and arbitrary application data.

Each item records origin, authorization decision, revision, and derivation.

## Reaction and Operation effects

A Reaction is the terminal framework outcome for one valid received WorkEvent.

```ts
interface Reaction {
  id: string;
  event: {
    source: string;
    id: string;
  };
  status: "completed" | "failed" | "cancelled";
  effects: OperationCall[];
  reason?: string;
  completedAt: string;
}
```

`effects: []` is an explicit null reaction.

Effects are calls to granted Work Profile operations. They may include replies, reactions, message updates, forms, approvals, artifacts, work-item mutations, and application callbacks.

Each effect is authorized independently and produces an `OperationResult` and provider receipt. A binding may return an `unknown` outcome when it cannot determine whether a write occurred; such a write is not blindly retried.

## Scheduled tasks

Scheduled work is a source of WorkEvents, not a separate domain model.

```ts
const events = await projectPatrolTimer.decode(nativeOccurrence);

for (const event of events) {
  const receipt = await runtime.ingest(event);
  await queue.send({ kind: "event.process", event: receipt.event });
}
```

The host owns schedule registration, wake-up, overlap, timeout, and retry.
Schedules may reuse a fixed WorkThread and AgentSession or create new sessions
on each tick. Cursor and checkpoint data use the replaceable Checkpoint Store.

## Serialization boundary

Domain state and traces are JSON-serializable. Application code is not.

Custom code participates through typed interfaces and optional manifests. A visualizer may show an opaque custom-code node with its declared inputs and outputs, while runtime traces record the actual values and decisions that crossed the boundary.
