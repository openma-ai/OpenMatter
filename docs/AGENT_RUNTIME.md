# Agent Runtime and Session Lifecycle

## Purpose

OpenMatter connects work orchestration to replaceable agent runtimes through `AgentDriver`.

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

The first open binding targets Agent Client Protocol. Separate drivers may target Claude managed runtimes, in-process agent SDKs, subprocesses, or private runtimes.

## OpenMAEvent

`OpenMAEvent` is the canonical runtime event consumed by OpenMatter and any framework UI.

```ts
interface OpenMAEvent {
  schemaVersion: string;
  id: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
  raw?: unknown;
}
```

Typical event classes include:

- session state;
- assistant text or structured content delta;
- reasoning or progress update where available;
- tool or custom-operation request;
- permission request and response;
- artifact or file update;
- plan or status update;
- turn completion, failure, cancellation, or interruption;
- provider-native extensions.

ACP events and managed-runtime events map into OpenMAEvent. UI code consumes OpenMAEvent rather than maintaining separate ACP and managed event models.

The mapping should remain lossless through `raw` and provider extension fields.

## Session lifecycle

```text
absent → creating → open → interrupted → open
                         ↘ expired
                         ↘ closed
```

An AgentSession is bound to:

```text
agent + runtime authority + AgentScope + WorkThread + privacy partition
```

The exact session key is application policy. Recommended defaults are:

| Work shape | Session policy |
| --- | --- |
| Channel conversation | One session per conversation or native thread |
| Channel with many native threads | One main channel session plus one session per thread when needed |
| Cross-channel Matter | One session per WorkThread resolved from the Matter |
| Work item | One session per issue, task, card, or record WorkThread |
| Slash command or form | Fresh invocation session or child WorkThread session |
| Scheduled patrol | Fixed patrol WorkThread with resumable or fresh sessions by application choice |
| Direct message | Actor-isolated session unless explicitly shared |

A channel may have multiple WorkThreads and Sessions. Multiple channels may contribute to one WorkThread and Session when policy and authority allow it.

## Turn lifecycle

A Turn is one agent invocation inside a Session.

```text
queued → running → completed
                ↘ failed
                ↘ cancelled
                ↘ interrupted
```

The Turn receives:

- the triggering WorkEvent;
- an immutable ContextProjection snapshot;
- the effective operation grants;
- a response contract;
- the selected AgentDriver and session handle.

The driver emits ordered OpenMAEvents until a terminal event.

## Retry

Public v0 uses direct Turn retry rather than a separate Attempt domain.

```ts
await work.agent("worker").session({ scope, thread }).turn({
  context,
  retry: {
    max: 3,
    backoff: "exponential",
  },
});
```

A retry retains the same trigger and context digest. Execution IDs, leases, reconnect tokens, and transport retries remain observable runtime records without becoming top-level application concepts.

Forking is intentionally deferred until a concrete cross-runtime semantic can be validated.

## Durable and opaque state

Agent runtime state may remain opaque, but OpenMatter cannot rely on it for durable correctness.

OpenMatter persists:

- session binding and external handle;
- trigger and context snapshot digest;
- effective capabilities;
- ordered OpenMAEvents or retained projections;
- permission decisions;
- reaction and effect receipts;
- cancellation and terminal state.

Runtime transcript, scratchpads, caches, and internal tool state may remain private to the agent runtime.

Facts required for cross-session continuity, retry, audit, or recovery belong in OpenMatter state or an explicitly referenced durable resource.

## Permissions and tools

OpenMatter does not decide what the agent should think or which internal tool it should call. It controls which external operations are exposed for a Turn.

```ts
const result = await session.turn({
  context,
  allow: [
    "message.reply",
    "issue.update",
    "code.comment.create",
  ],
});
```

The allowed names refer to operations from loaded Work Profiles. An agent may request an operation or permission through its native runtime mechanism. The AgentDriver maps that request into OpenMAEvent, and OpenMatter applies application policy, actor authority, scope policy, and provider constraints before responding.

Drivers deliver granted operations through the closest supported mechanism:

- managed-runtime or in-process SDK tool callbacks;
- MCP tools hosted by OpenMatter;
- a negotiated ACP extension when supported;
- a custom runtime callback.

A driver must report when its runtime cannot receive external operations. It cannot silently pretend that Work Profile operations were exposed.

## ACP binding

The ACP driver maps OpenMatter semantics to the closest supported ACP lifecycle:

| OpenMatter | ACP responsibility |
| --- | --- |
| Driver initialization and capabilities | ACP initialization and negotiated capabilities |
| AgentSession create/resume | ACP session lifecycle |
| Turn input | ACP prompt or session input |
| OpenMAEvent updates | ACP session updates and content/tool events |
| Permission request | ACP permission flow where supported |
| Cancellation | ACP cancellation semantics |
| Terminal Turn result | ACP completion or error |

ACP remains the wire protocol. OpenMatter adds work-domain context, policy, persistence, and reaction orchestration around it.

The binding must expose unsupported behavior through capabilities rather than silently emulating incompatible semantics.

## Managed-runtime binding

A managed runtime may already provide hosted session storage, reconnectable streams, confirmation flows, execution isolation, and usage policy.

The OpenMatter driver maps those native features into AgentSession, Turn, and OpenMAEvent without duplicating the hosted control plane.

OpenMatter still owns the work-side trigger, scope, Matter, WorkThread, context projection, effective work operations, and final Reaction.

## Transport

AgentDriver is a semantic SDK interface. Implementations may use:

- ACP over its supported transports;
- HTTP request and streamed response;
- WebSocket;
- server-sent events;
- stdio or subprocess messaging;
- in-process SDK calls;
- a managed service client.

Transport is driver-specific and should not leak into the Work domain.

## UI contract

A framework UI subscribes to OpenMAEvent plus OpenMatter domain traces:

```text
WorkEvent
Scope / Matter / WorkThread decisions
Context projection and grants
AgentSession and Turn state
OpenMAEvent stream
Reaction and OperationResult receipts
```

This gives the UI one normalized surface while preserving access to raw provider events for specialized rendering.
