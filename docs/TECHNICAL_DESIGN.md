# OpenMatter Technical Design v0

| Field                    | Value                                      |
| ------------------------ | ------------------------------------------ |
| Status                   | Executable v0 foundation                   |
| Language                 | TypeScript 6                               |
| Runtime model            | Effect 3                                   |
| Public programming model | Effect-native handlers; Promise host edges |
| Deployment               | Embedded and serverless-neutral            |

This document describes the one executable SDK architecture. Directional Work
Profile/compiler design is kept in [Architecture](./ARCHITECTURE.md) and
[SDK Spec](./SDK_SPEC.md); it does not define a second Runtime API.

## 1. Design statement

OpenMatter composes two replaceable semantic edges around application-owned
context engineering:

```text
work platform ⇄ WorkIntegration ⇄ OpenMatter Runtime ⇄ AgentDriver ⇄ agent
                                      │
                                      ▼
                               OpenMatterStore
```

- `WorkIntegration` normalizes native platform events and delivers authorized
  effects.
- `AgentDriver` maps Sessions, Turns, event streams, permissions, cancellation,
  and results to ACP, a managed runtime, or a custom agent SDK.
- `OpenMatterStore` owns durable facts, claims, fencing, checkpoints, and the
  effect outbox.
- Application handlers choose Scope, WorkThread, context, grants, Agent, and
  reactions.

OpenMatter owns no server, scheduler, queue, credentials service, UI, or Agent
reasoning loop.

## 2. Core invariant: immutable facts, explicit transitions

The Runtime treats these as immutable JSON facts:

- `WorkEvent`;
- `ContextProjection` and its provenance/grants;
- Agent Session handles after portable encoding;
- Turn inputs and ordered `OpenMAEvent` checkpoints;
- permission decisions;
- terminal `Reaction` and `WorkEffect` intents;
- provider delivery receipts.

TypeScript `readonly` is insufficient. Before every asynchronous or durable
boundary, the Runtime validates and deep-snapshots the value. It never continues
using a caller-owned mutable object after authorization.

Mutable lifecycle state—lease ownership, Session generation, Turn state, effect
attempts—changes only through named Store operations guarded by a revision,
claim token, or fencing token.

## 3. Package boundaries

```text
@openmatter/core              immutable records and Effect Schemas
@openmatter/store             durable Store port
@openmatter/store-memory      in-process reference Store
@openmatter/inbox             durable transport-envelope port
@openmatter/inbox-sqlite      embedded Node inbox adapter
@openmatter/integration       WorkIntegration port
@openmatter/integration-mock  reference work adapter
@openmatter/agent             AgentDriver and OpenMAEvent port
@openmatter/agent-mock        reference agent adapter
@openmatter/runtime           lifecycle orchestration
@openmatter/integration-slack signed Slack ingress and semantic operations
@openmatter/orchestration     built-in code-first orchestration presets
@openmatter/host-cloudflare   Worker HTTP/Queue host binding
@openmatter/host-local        Node Socket Mode host binding
```

Dependency direction is inward toward `core`. Concrete provider SDKs,
databases, ACP clients, cloud runtimes, and HTTP frameworks belong in adapters,
not in core or runtime.

Host packages are thin lifecycle bindings, not alternate runtimes. They do not
own context, policy, or Session semantics. The Cloudflare binding
ACKs signed HTTP ingress by enqueueing a portable input and invokes the same
application from its Queue consumer. The local binding uses Slack's official
Socket Mode client, persists pre-authenticated envelopes through a separately
injected `DurableInbox`, ACKs only after that commit, and passes claimed bodies
to the same Slack integration. Transport-inbox persistence stays separate from
the domain Store.

## 4. Work Integration

```ts
interface WorkIntegration {
  readonly manifest: IntegrationManifest;
  readonly ingest: (
    input: unknown,
  ) => Effect<readonly WorkEvent[], IntegrationError>;
  readonly deliver: (
    effect: WorkEffect,
  ) => Effect<ProviderDeliveryResult, IntegrationError>;
}
```

`ingest` is the normalization boundary for webhooks, SDK callbacks, forms,
slash commands, timer occurrences, polling results, and custom application
events. Host-owned WebSocket/polling sources can emit normalized `WorkEvent`
values into `app.consume`.

`deliver` receives only a previously authorized and durably recorded
`WorkEffect`. It must preserve provider receipts as portable JSON and classify
failures as retryable or terminal.

## 5. Agent Driver

`AgentDriver` is an Effect-native semantic interface, not a transport protocol.
It covers:

- capability discovery;
- idempotent Session creation and resumable handles;
- ordered Turn event streams;
- permission responses;
- cancellation and Session close;
- typed Session-unavailable recovery.

ACP, Claude managed runtimes, and custom SDKs each implement this same port.
HTTP, WebSocket, stdio, SDK calls, and webhooks remain binding choices.

The durable `AgentSession` is scoped by Agent, authority, Scope, WorkThread, and
privacy partition. A Turn is pinned to one Session generation. A partial Turn is
never silently continued in a newly created remote Session.

## 6. Runtime lifecycle

```text
native input
  → WorkIntegration.ingest
  → validate + snapshot WorkEvent
  → claim Event
  → application handler
      → create immutable ContextProjection
      → create/resume AgentSession
      → run/checkpoint one logical Turn
      → authorize immutable WorkEffect intents
      → return terminal Reaction (including no-effects)
  → atomically persist Reaction + effects
  → claim and deliver effects through WorkIntegration
  → persist delivery receipts
```

The public application is created once per host composition:

```ts
const app = createOpenMatter({ store, integrations, agents });

app.on("chat.message.received", handler);

await app.accept(event);
await app.acceptFrom("chat", nativeWebhookBody);
await app.consume(workEventSource, { concurrency: 8 });
```

Handlers are Effect-native. `accept`, `acceptFrom`, and `consume` are Promise
facades suitable for request handlers, queue consumers, tests, and long-lived
processes.

## 7. Context and authority

`ContextProjection` is the exact authorized snapshot for one Turn. It records:

- `scopeId` and `workThreadId`;
- trigger Event;
- selected context items;
- provenance for every item;
- operation grants;
- a stable digest.

Scope state is candidate context, not automatically disclosed context. The
application decides what a given Event and Agent may see. A replay of a logical
Turn uses its stored projection and stored allow-list, never newly expanded
permissions.

## 8. Store and serverless correctness

The Store, not an application node's wall clock, is authoritative for lease
expiry. Claim, renewal, and commit operations use tokens/fencing so a stale
worker cannot overwrite a newer owner.

Stable logical identity is derived from durable invocation identity—not from
mutable context contents. Session creation, Turn dispatch, permission replies,
effect delivery, cancellation, and close expose stable idempotency identifiers
to adapters.

Crash recovery rules are explicit:

- a terminal Turn result is reusable without contacting the Agent Driver;
- a partial Turn resumes only in its original compatible Session generation;
- a cancelled Turn cannot be revived by Event replay;
- permission decisions are persisted with a request fingerprint;
- malformed streams remain rejected after replay;
- effects are recoverable from the durable outbox.

The memory adapter exercises these semantics but is not a production durability
claim.

## 9. Deployment shapes

OpenMatter has no deployment runtime. The same SDK composition works in:

- Node/Bun/Deno/container processes;
- Cloudflare Workers and other request isolates;
- queue and workflow workers;
- bots and plugins;
- tests.

For fast serverless acknowledgement, the host verifies the request and places
the native input or normalized `WorkEvent` on its durable queue. A worker then
constructs the application from environment-specific adapters and calls
`acceptFrom` or `accept`. No work is floated after a request returns.

Schedulers follow the same rule: the host owns registration, wake-up, overlap,
and retry; its occurrence is ordinary Integration input.

See [`examples/deployment-shapes.ts`](../examples/deployment-shapes.ts).

## 10. Future Work Profile layer

OpenAPI/AsyncAPI/GraphQL compilation may later generate portable Work Profiles
and portions of a `WorkIntegration`. A compiler cannot safely invent resource
identity, authorization, idempotency, reference semantics, or provider-specific
subscriptions. Those require explicit overlays or adapter code.

Compiler output must bind into the same two runtime edges. It must not introduce
a second event model, operation runtime, Session lifecycle, or deployment
platform.

## 11. Verification gates

The v0 foundation is accepted only when all of these pass:

```bash
pnpm check
git diff --check
```

Tests cover immutability at durable boundaries, event/reaction containment,
grants, idempotency, claim fencing, crash replay, Session recovery, Turn stream
validation, permission durability, cancellation, and effect outbox delivery.
