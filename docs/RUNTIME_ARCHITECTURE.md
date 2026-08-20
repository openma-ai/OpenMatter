# Runtime Architecture

| Field             | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Status            | Executable v0 foundation                             |
| Programming model | Effect-first internals, code-first application API   |
| Durable boundary  | `Reaction` plus `WorkEffect` intents before delivery |
| Deployment unit   | Embeddable SDK; no required OpenMatter service       |

## Design intent

OpenMatter uses Effect as its runtime model rather than adding an Effect-shaped wrapper around Promises. Store, integration, and agent boundaries return typed `Effect` or `Stream` values. Runtime dependencies compose through `Context` and `Layer`. Provider failures, agent failures, busy events, interruption, and context failures remain in explicit error channels until the framework intentionally converts them into domain outcomes.

The framework does not reproduce Spectrum's `Message`, `Space`, live capability objects, `definePlatform`, or managed connector architecture. The useful concepts learned from Photon are narrower: one coherent integration-authoring boundary, a common path for live streams and request-driven execution, and room for provider-native extensions. OpenMatter applies those lessons to a different domain and programming model.

### Immutable core, stateful edges

**Immutable facts, explicit transitions** is a runtime invariant. WorkEvents, ContextProjections, Turn inputs, PermissionDecisions, Reactions, WorkEffects, Agent events, and delivery receipts cross async or durable boundaries as deep portable-JSON snapshots. A successful authorization guard returns the snapshot that will be committed; it never returns a caller-owned live reference. New Turns reload their authorized ContextProjection from Store before dispatch.

AgentSession, lease, and delivery state are intentionally stateful, but they change only through named operations protected by fencing tokens or insert-once/CAS semantics. Session generations express replacement rather than mutating history into a different identity. Effect values are safely reusable: invocation-local finalizer state is allocated inside `Effect.suspend`, not captured in a shared construction closure.

## Runtime topology

```text
native event                                              agent runtime
    │                                                          ▲
    ▼                                                          │
WorkIntegration.ingest                              AgentDriver Stream
    │                                                          │
    ▼                                                          │
WorkEvent ──► claim ──► context projection ──► session ──► turn
                         provenance + grants              OpenMAEvents
                                  │                           │
                                  └──────── handler ──────────┘
                                               │
                                               ▼
                                           Reaction
                                               │
                              atomic durable boundary
                                               │
                                               ▼
                                      WorkEffect intents
                                               │
                                   structured concurrency
                                               │
                                               ▼
                                  WorkIntegration.deliver
```

Every domain-complete `WorkEvent` obtains one terminal `Reaction`. An explicit null reaction is `status: "completed"` with `effects: []`. Infrastructure failures leave the event claim recoverable instead of manufacturing a false domain reaction.

## Effect composition

The runtime is assembled from three replaceable services:

```text
StoreService       leased claims, context, session mailbox, turns, outbox, receipts
WorkIntegrations   native event normalization and effect delivery
AgentDrivers       session lifecycle and streamed OpenMAEvents
```

Each service has a `Layer` constructor. `createOpenMatter()` builds a runtime layer from concrete ports and exposes both Effect-native and Promise boundary methods:

```ts
app.acceptEffect(event); // Effect<ReactionReceipt, ...>
await app.accept(event); // Promise facade

app.acceptFromEffect("slack", raw); // normalize and execute
await app.acceptFrom("slack", raw); // request/serverless facade
```

`app.consume(asyncEvents)` converts a long-lived `AsyncIterable` into an Effect `Stream` and feeds the same `acceptEffect` pipeline. There is no second long-running runtime with different semantics.

## Durable execution boundary

The order is deliberate:

```text
claim event
  → run application and agent turn
  → atomically persist terminal Reaction + WorkEffect intents
  → deliver pending effects
  → persist provider receipts
```

Event, Session, and Effect claims carry expiring leases and fencing tokens/revisions. Runtime requests contain a duration, never a client-computed wall-clock expiry; a storage adapter computes `expiresAt` from its own authoritative clock inside the atomic claim or renewal. This avoids serverless node clock skew becoming lock ownership. Scoped heartbeat fibers renew all three while user code, the complete claimed Session lifecycle, or a provider call is running. The Session heartbeat begins immediately after claim and covers close/create/resume, handle validation, persistence, the Agent stream, and terminal Turn persistence. Renewal failure interrupts the local work (and cancels a remote Agent Turn when supported). Reaction, Turn, Agent-event, permission-decision, Session, and delivery writes require the exact relevant lease token, so a stale worker cannot overwrite a worker that reclaimed expired work.

`commitTerminalReaction` is an atomic insert-once operation. If completion races with an interruption finalizer, the first terminal value wins; neither path can rewrite the durable Reaction or its outbox intents.

On a duplicate event, the runtime returns the stored reaction and reclaims effects whose latest receipt is retryable and due. `recoverEffects()` exposes the same outbox recovery independently of event replay, so a scheduler, queue consumer, or request can drive recovery. Every effect carries its own idempotency key; a production integration must pass that key through to the provider or implement equivalent deduplication.

The memory adapter implements these state transitions for conformance tests but is process-local. It accepts an injectable Store clock for deterministic tests. A production adapter must use database/queue time for lease comparisons, realize claims as atomic compare-and-set operations, and commit `Reaction + WorkEffect[]` transactionally.

## Context is a persisted input

An agent does not receive an untracked array of values. Application code creates a `ContextProjection` containing:

- Scope and WorkThread binding;
- triggering event;
- context items and provenance;
- effective grants;
- strict JSON-canonical SHA-256 digest.

The projection is persisted before the turn. The same `JsonValue` contract applies to WorkEvents, context values, WorkEffects, Reactions, OpenMAEvents, Session handles, and provider receipts. Unsupported values such as `Map`, `Date`, `BigInt`, cycles, and non-finite numbers are rejected rather than silently behaving differently across stores. A projection cannot be supplied to a Session bound to another Scope or WorkThread. The runtime snapshots caller inputs before asynchronous guards and reloads the durable projection for Agent/effect execution, closing mutation/TOCTOU windows. This keeps runtime continuity separate from durable work truth.

## Session mailbox and Agent stream

One reusable Agent Session is keyed by:

```text
agent + authority + AgentScope + WorkThread + privacy partition
```

A Session lease serializes turns for that binding. Separate channels may therefore share a Scope or WorkThread without accidentally sharing credentials or private context across authorities. The current runtime deliberately uses a mailbox invariant (`concurrentTurns: false`) rather than exposing actors as a user-facing abstraction. A changed Driver, closed Session, or Driver without resume support creates a new Session generation and closes the prior durable generation. The Runtime persists a `creating` generation before calling the Driver; `createSession` receives that stable local id as an idempotency key, closing the create-success/save-handle crash window. Only typed remote-session expiry triggers fallback—transient resume errors remain errors.

Each Agent Driver returns a `Stream<OpenMAEvent>`. The Runtime validates session/turn identity, a contiguous sequence, exactly one terminal event, and no event after termination, while checkpointing nonterminal events as they arrive. A terminal event is persisted only after the Stream closes cleanly, so a malformed post-terminal event cannot become a successful replay checkpoint. A Turn id is stable across Event replay and does not depend on newly materialized context. The Turn record points to its original ContextProjection and allow list; in-flight replay resumes from the stored sequence and input, while a completed Turn is returned without another Agent call. Any persisted nonterminal Turn is already dispatched—even before sequence one is observed—and cannot cross Session generations. Loss of its original Session creates a fenced `turn.interrupted` terminal event rather than risking a duplicate dispatch.

`completed`, `failed`, `cancelled`, and `interrupted` are typed Agent outcomes rather than transport errors. Permission decisions are persisted insert-once before response and bound to a canonical fingerprint of request type and payload. Reusing a request id with different content is rejected as a Driver protocol error; a valid replay sends the same decision through a response that is idempotent by Session/request id. Effect interruption remains interruption; the durable Turn and Reaction are marked `cancelled`, and the Driver receives `cancel()` when it supports remote cancellation. A durable cancelled Turn is irreversible: if its Event Reaction was not committed, replay repairs a missing `turn.interrupted` checkpoint rather than invoking the Agent again.

## Authorization boundary

Grants are executable constraints, not audit-only metadata:

- a Turn's `allow` list must be a subset of its persisted ContextProjection grants;
- a WorkEffect must be created from a ContextProjection built for the current event;
- `${integrationId}.${operation}` must be granted and declared by the target integration;
- a structurally forged WorkEffect is rejected before the outbox commit;
- authorization stores the canonical JSON fingerprint captured at creation, so replacement and in-place mutation are both rejected.

## Deployment shapes

### Request-driven or serverless

```ts
export const makeWebhookHandler = (store: OpenMatterStore) => {
  const app = buildApplication(store);

  return async (request: Request): Promise<Response> => {
    const nativeEvent = await request.json();
    const receipts = await app.acceptFrom("chat", nativeEvent);
    return Response.json(receipts);
  };
};
```

The hosting environment supplies a durable `OpenMatterStore`. The SDK does not require Durable Objects, Node servers, or an OpenMatter-hosted control plane.

### Long-lived process

```ts
await app.consume(provider.events(), { concurrency: 8 });
```

The source owns connection and reconnect policy. The Runtime owns normalized event execution. This separation also allows queues, polling, database change streams, and tests to provide events without pretending they are IM providers.

## Package map

| Package                        | Responsibility                              |
| ------------------------------ | ------------------------------------------- |
| `@openmatter/core`             | Effect Schemas and immutable domain records |
| `@openmatter/runtime`          | Handler registry and Effect orchestration   |
| `@openmatter/store`            | Durable storage service contract and Layer  |
| `@openmatter/store-memory`     | Process-local reference adapter             |
| `@openmatter/integration`      | Work integration contract and Layer         |
| `@openmatter/integration-mock` | Bidirectional mock work platform            |
| `@openmatter/agent`            | AgentDriver, OpenMAEvent, and Layer         |
| `@openmatter/agent-mock`       | Deterministic mock agent runtime            |

## Current limits

The foundation intentionally does not yet claim production completeness:

- no Postgres, SQLite, or cloud durable store adapter;
- no real Slack, Linear, Lark, GitHub, or kanban integration;
- no ACP or Claude managed AgentDriver implementation;
- no automatic recovery scheduler, configurable retry/backoff policy, or DLQ;
- no complete Matter resolver or Scope repository implementation;
- no provider conformance harness yet.

These are the next vertical slices; the current code establishes the contracts they must satisfy.
