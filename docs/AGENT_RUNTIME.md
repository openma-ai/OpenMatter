# Agent Runtime and Session Lifecycle

| Field  | Value                                              |
| ------ | -------------------------------------------------- |
| Status | Executable v0 contract                             |
| Source | `@openmatter/agent` and `@openmatter/runtime` APIs |

## Purpose

OpenMatter connects work orchestration to replaceable agent runtimes through `AgentDriver`.

```ts
interface AgentDriver {
  readonly id: string;
  capabilities(): Effect<AgentCapabilities, AgentDriverError>;
  createSession(
    input: AgentSessionCreateInput,
  ): Effect<AgentSessionHandle, AgentDriverError>;
  resumeSession(
    handle: AgentSessionHandle,
  ): Effect<
    AgentSessionHandle,
    AgentDriverError | AgentSessionUnavailableError
  >;
  turn(input: AgentTurnInput): Stream<OpenMAEvent, AgentDriverError>;
  respondToPermission(
    input: PermissionResponse,
  ): Effect<void, AgentDriverError>;
  cancel(input: CancelTurnInput): Effect<void, AgentDriverError>;
  closeSession(handle: AgentSessionHandle): Effect<void, AgentDriverError>;
}
```

This is the Effect-native internal contract. Promise facades may exist at application and transport boundaries; they are not a second Agent Driver model. The first planned open binding targets Agent Client Protocol. Separate drivers may target Claude managed runtimes, in-process agent SDKs, subprocesses, or private runtimes.

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

| Work shape                       | Session policy                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Channel conversation             | One session per conversation or native thread                                  |
| Channel with many native threads | One main channel session plus one session per thread when needed               |
| Cross-channel Matter             | One session per WorkThread resolved from the Matter                            |
| Work item                        | One session per issue, task, card, or record WorkThread                        |
| Slash command or form            | Fresh invocation session or child WorkThread session                           |
| Scheduled patrol                 | Fixed patrol WorkThread with resumable or fresh sessions by application choice |
| Direct message                   | Actor-isolated session unless explicitly shared                                |

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

## Crash resume and application retry

Executable v0 implements recovery of one stable logical Turn, not a public retry-policy or fork API. The Turn id is derived from Event idempotency, Session binding, and invocation position; its original ContextProjection and allow list are persisted as immutable input.

- A completed Turn replay returns the durable result without invoking the Agent again.
- A running Turn may resume with `afterSequence` only in its original Session generation, using the original ContextProjection and allow list.
- A persisted running Turn is considered in flight even if no Agent event was observed yet. If its original Session cannot resume, it terminates as `turn.interrupted`; the runtime does not risk redispatching it in a new generation.
- Worker leases, reconnects, and transport attempts remain runtime records rather than public domain objects.

A new application-requested retry or fork is a distinct future invocation with explicit policy. Its public semantics are intentionally deferred until they can be validated across runtimes.

## Durable and opaque state

Agent runtime state may remain opaque, but OpenMatter cannot rely on it for durable correctness.

OpenMatter persists:

- session binding and external handle;
- trigger and context snapshot digest;
- effective capabilities;
- ordered OpenMAEvents or retained projections, with terminal events committed only after a clean stream end;
- permission decisions bound to request-content fingerprints;
- reaction and effect receipts;
- cancellation and terminal state.

Runtime transcript, scratchpads, caches, and internal tool state may remain private to the agent runtime.

Facts required for cross-session continuity, retry, audit, or recovery belong in OpenMatter state or an explicitly referenced durable resource.

Remote Session creation is planned durably before the side effect. `createSession` receives the local Session id/generation as a stable idempotency input. A typed remote-session-unavailable result may create a new generation for new work; transient resume failures do not. `createSession`, permission response, cancellation, and close operations must be idempotent by their stable Session/Turn/request identities; an adapter treats an already-applied remote operation as success.

## Permissions and tools

OpenMatter does not decide what the agent should think or which internal tool it should call. It controls which external operations are exposed for a Turn.

```ts
const result = await session.turn({
  context,
  allow: ["slack.reply", "linear.issue.update", "github.comment.create"],
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

| OpenMatter                             | ACP responsibility                             |
| -------------------------------------- | ---------------------------------------------- |
| Driver initialization and capabilities | ACP initialization and negotiated capabilities |
| AgentSession create/resume             | ACP session lifecycle                          |
| Turn input                             | ACP prompt or session input                    |
| OpenMAEvent updates                    | ACP session updates and content/tool events    |
| Permission request                     | ACP permission flow where supported            |
| Cancellation                           | ACP cancellation semantics                     |
| Terminal Turn result                   | ACP completion or error                        |

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
