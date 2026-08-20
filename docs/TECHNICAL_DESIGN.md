# OpenMatter Technical Design v0

| Field | Value |
| --- | --- |
| Status | Proposed |
| Primary language | TypeScript |
| Public programming model | Promise, AsyncIterable, plain objects |
| Internal runtime model | Effect |
| Portable artifact | OpenMatter Work Profile JSON |
| Primary compiler input | OpenAPI 3.1 |

## 1. Decision summary

OpenMatter will implement its own small SDK and runtime rather than embedding part of a connector or workflow platform.

The SDK does **not** require OpenMatter maintainers to integrate every SaaS. It separates three responsibilities:

1. **Compiler** converts machine descriptions such as OpenAPI into a portable Work Profile.
2. **Profile authoring** optionally adds work semantics that cannot be safely inferred.
3. **Runtime** loads a Profile, binds it to credentials and event ingress, and orchestrates an external agent.

```text
                   build time

OpenAPI ─┐
AsyncAPI ├── Compiler ── semantic overlay ── Work Profile JSON
GraphQL ─┘

                   runtime

Work Profile + authority configuration + bindings
                         ↓
                  OpenMatter Runtime
                   ↙             ↘
             work platform      AgentDriver
                                  ↓
                           ACP / managed agent
```

The portable artifact is an SDK contract and does not require an independent wire service.

## 2. Design constraints

The implementation MUST preserve these properties:

- embedded by default; no required Hub or control plane;
- storage, scheduler, queue, and deployment neutral;
- code-first orchestration with JSON-serializable profiles and records;
- no public Actor or Effect types required for application users;
- no provider-specific HTTP client when OpenAPI is sufficient;
- no silent semantic guessing;
- exactly one terminal Reaction for every valid received WorkEvent, including null;
- ACP remains the first open agent-session binding;
- provider-native data and runtime-native events remain available with provenance.

## 3. Public concepts

### 3.1 WorkProfile

`WorkProfile` is the compiled, portable description of operations, events, resources, interactions, capabilities, and their bindings.

It contains no live credentials, listeners, database handles, functions, or network clients.

```ts
import { compileWorkProfile, openapi, overlay } from "@openmatter/compiler";

const result = await compileWorkProfile({
  sources: [openapi("./work-api.yaml")],
  overlays: [overlay("./work-semantics.yaml")],
});

await result.write("./dist/work-profile.json");
```

Compilation returns both an artifact and structured diagnostics. Warnings are part of the product: they tell a profile author which work semantics remain unknown.

### 3.2 WorkSurface

`WorkSurface` binds a Profile to one configured provider authority.

```ts
interface WorkSurface {
  id: string;
  profile: WorkProfile;
  authority: AuthorityRef;
  operations?: OperationExecutor;
  decoders?: WorkEventDecoder<unknown>[];
  sources?: WorkEventSource[];
  resources?: ResourceMaterializer;
}
```

Several authorities may use the same immutable Profile. For example, two Slack workspaces share one Slack Profile but have separate credentials, event subscriptions, policies, and IDs.

### 3.3 Work bindings and ingress adapters

Bindings are executable edges. The SDK defines small capability-specific ports
instead of one provider object that also owns a process loop.

```ts
interface OperationExecutor {
  invoke(call: OperationCall, signal?: AbortSignal): Promise<OperationResult>;
}

interface WorkEventDecoder<TInput> {
  decode(input: TInput): Promise<readonly WorkEvent[]>;
}

interface WorkEventSource {
  start(
    emit: (event: WorkEvent) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface TimerAdapter<TOccurrence>
  extends WorkEventDecoder<TOccurrence> {
  id: string;
}
```

`WorkEventDecoder` serves request/callback style ingress. `WorkEventSource` is an
optional host convenience for WebSocket, polling, or SDK streams. `TimerAdapter`
does not schedule anything: it maps one host-native occurrence to WorkEvents.
Resource materialization remains a separate capability.

An OpenAPI-only surface normally uses the generic HTTP `OperationExecutor`.
Provider signature verification, subscription, and webhook parsing can be
packaged together for authoring convenience without merging the internal ports.

### 3.4 OpenMatterRuntime

```ts
interface OpenMatterRuntime {
  ingest(event: WorkEvent): Promise<EventIngestReceipt>;
  process(event: WorkEventRef): Promise<EventProcessReceipt>;
  deliver(callId: string): Promise<OperationDeliveryReceipt>;
  accept(event: WorkEvent): Promise<AcceptReceipt>;
}
```

`ingest`, `process`, and `deliver` are independently retryable durable seams.
They accept only serializable values, so an application may place a queue or
workflow engine between them. `accept` is a convenience composition for an
embedded process. Runtime does not own a server, event loop, scheduler, or
global pending-operation scan.

## 4. Authoring API

Profiles are declarative where portability matters. Applications remain ordinary code where behavior is open-ended.

```ts
import {
  defineWorkProfile,
  openapi,
  operation,
  resource,
  select,
} from "@openmatter/profile";

export default defineWorkProfile({
  source: openapi("./api.yaml"),

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

This authoring API produces data. It is not the Runtime configuration and cannot hide executable network behavior inside a supposedly portable Profile.

Custom behavior is registered explicitly:

```ts
const surface = createWorkSurface({
  profile,
  authority: { profile: profile.id, id: "workspace-1" },
  operations: openApiOperations({
    fetch,
    credentials,
  }),
  sources: [
    customEvents({
      async start(emit, signal) {
        // provider SDK, queue, socket, poller, or application event bus
      },
    }),
  ],
});
```

## 5. Compiler design

### 5.1 Pipeline

The compiler is a pure staged pipeline around an immutable intermediate model.

```text
load
  → identify source dialect
  → parse and validate source
  → resolve and bundle references
  → normalize schemas
  → discover operations, events, and security
  → create conservative generated semantics
  → apply ordered overlays
  → validate cross-references
  → emit Work Profile + diagnostics + source map
```

Each stage receives and returns serializable values. File access and network reference loading are injected capabilities, not global behavior.

### 5.2 Determinism

For the same source bytes, compiler version, options, and overlay order, output bytes MUST be stable after canonical JSON serialization.

The compiler records:

- source URI when known;
- exact source digest;
- compiler name and version;
- overlay digests and order;
- diagnostics;
- mapping from output definitions to source locations.

Timestamps MUST NOT be embedded in the canonical artifact.

### 5.3 OpenAPI input

OpenAPI 3.1 is the first complete source adapter.

It is responsible for:

- Operation Object discovery;
- parameter and request-body input schemas;
- response and error schemas;
- server and security requirements;
- descriptions, tags, and deprecation;
- OpenAPI webhooks and callbacks when present;
- source references used by the generic executor.

OpenAPI 3.0 may be accepted through a compatibility conversion layer. Lossy schema conversion produces diagnostics and cannot be silently treated as 3.1.

### 5.4 AsyncAPI and GraphQL

AsyncAPI is the preferred event-description source. The v0 adapter maps channels, messages, operations, correlation information, and supported bindings into event candidates.

GraphQL introspection describes types but not useful pre-built operations. The GraphQL adapter therefore requires named query/mutation documents in addition to introspection. It does not expose arbitrary graph traversal as one unrestricted agent tool.

### 5.5 Semantic overlays

Overlays are applied by stable definition key. They may:

- rename generated operations;
- define Resource identity and aliases;
- associate operations and events with Resources;
- tighten safety and confirmation requirements;
- declare idempotency;
- define anchors, interactions, and capabilities;
- suppress intentionally unsupported definitions.

They may not inject executable functions or credentials.

Conflicting overlays are resolved only through explicit order. The compiler emits a diagnostic for every overwritten non-identical semantic field.

### 5.6 Selectors

Portable selectors use RFC 9535 JSONPath. The reference implementation will use a conformance-tested selector engine behind an internal port.

Complex transformation is not added to a string expression DSL. It is handled by:

- multiple ordered selectors;
- JSON Schema defaults and validation where appropriate;
- a named custom compiler plugin;
- a named runtime resolver.

Named extensions keep the JSON artifact inspectable and make non-portable behavior explicit.

## 6. Schema strategy

The canonical external schema dialect is JSON Schema Draft 2020-12.

Two validation paths are intentionally separated:

1. OpenMatter's own records are defined schema-first and exported as JSON Schema.
2. Third-party operation payload schemas are preserved and validated by a Draft 2020-12 validator.

The reference implementation may use Effect Schema for internal TypeScript domain construction and a standards-compliant JSON Schema validator for imported schemas. Imported schemas are never translated through a smaller internal type system if that would lose meaning.

Every boundary validates:

```text
source document
compiled Work Profile
incoming WorkEvent data
OperationCall input
OperationResult output
persisted versioned record
```

## 7. Generic OpenAPI operation binding

The generic HTTP executor is the main mechanism that prevents one implementation per SaaS.

### 7.1 Request construction

For an `openapi` operation it:

1. finds the compiled source operation by stable source identity;
2. validates the call input;
3. selects a host-configured server for the authority;
4. resolves credentials through `CredentialProvider`;
5. serializes path, query, header, cookie, and body parameters according to OpenAPI rules;
6. applies an idempotency key only through a declared binding rule;
7. executes with host `fetch` and `AbortSignal`;
8. parses the documented response media type;
9. validates the normalized output;
10. extracts declared Resources and records a receipt.

### 7.2 Trusted host configuration

Server scheme, host, credential selection, proxy policy, and TLS policy belong to authority configuration. They are not ordinary operation input.

The executor rejects by default:

- agent-controlled absolute URLs;
- redirects to an untrusted authority;
- undocumented credential forwarding;
- header injection into protected headers;
- remote schema dereferencing at runtime;
- response bodies beyond configured limits.

### 7.3 Retries

Transport retry and logical operation retry are distinct.

- Connection failure before request transmission may be transport-retryable.
- Reads may follow configured retry policy.
- Writes require provider idempotency or an idempotency key rule.
- An indeterminate write returns `status: unknown` and is not automatically repeated.

## 8. Event ingress

The compiler can describe an event but cannot assume how a provider delivers or verifies it.

The SDK supplies reusable ingress components:

- CloudEvents receiver;
- generic signed webhook receiver;
- polling source with durable cursor;
- queue and stream adapters;
- timer occurrence adapter;
- custom callback adapter.

Provider-specific signature or subscription behavior is a small binding, not a new runtime. Users and third parties can publish such bindings independently of OpenMatter core.

```ts
const handler = webhookHandler({
  surface,
  event: "issue.updated",
  verify: verifyProviderSignature,
  map: profileEventMapper("issue.updated"),
});
```

Every successfully normalized event enters `runtime.ingest`. The host may then
enqueue the returned event reference for `runtime.process`. Filtering occurs
after durable reception and therefore produces a null Reaction rather than a
silent drop.

## 9. Runtime design

### 9.1 Processing pipeline

```text
ingest WorkEvent
  → validate and persist-if-absent
  → enqueue event reference (host-owned, optional)
process event reference
  → claim event lease
  → resolve AgentScope
  → resolve references and Matters
  → choose or continue WorkThread
  → build authorized ContextProjection
  → create or resume AgentSession
  → run one Turn
  → compile terminal Reaction
  → atomically persist Reaction and operation intents
deliver exact operation callId
  → claim operation lease
  → execute the authorized operation
  → persist its result
```

Application code may replace the middle policy stages. The Runtime owns durable state transitions and observability around them.

### 9.2 Internal Effect usage

Effect is an implementation method, not a public requirement.

Internally it provides:

- typed service dependencies through Layers;
- scoped resource acquisition and release;
- structured cancellation through Fibers and Scope;
- queues and streams for event and agent updates;
- typed failures and retry schedules;
- test clocks and deterministic service substitution;
- tracing context propagation.

Public APIs expose Promise, AsyncIterable, AbortSignal, and plain TypeScript values. Users do not create Actors, Fibers, Layers, or Effect values unless they choose an advanced adapter entry point.

### 9.3 Concurrency ownership

The Runtime serializes state changes only where the domain requires it:

- event deduplication key;
- WorkThread revision;
- AgentSession turn ordering when the driver cannot run concurrent turns;
- Reaction terminal transition;
- operation idempotency key.

There is no global actor or global event lock. Different WorkThreads may run concurrently.

## 10. Agent integration

`AgentDriver` remains independent from Work Profiles.

```ts
interface AgentDriver {
  capabilities(): Promise<AgentCapabilities>;
  createSession(input: CreateSessionInput): Promise<AgentSessionHandle>;
  resumeSession(input: ResumeSessionInput): Promise<AgentSessionHandle>;
  turn(input: AgentTurnInput): AsyncIterable<OpenMAEvent>;
  respondToPermission(input: PermissionResponse): Promise<void>;
  cancel(input: CancelTurnInput): Promise<void>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
```

For each Turn, OpenMatter gives the driver:

- the immutable ContextProjection;
- the triggering WorkEvent;
- the authorized subset of Profile operations;
- the expected response/reaction contract;
- correlation and cancellation identifiers.

Drivers expose operations through the closest native mechanism:

- managed-agent or in-process SDK tool callbacks;
- MCP tools hosted by OpenMatter;
- an ACP extension binding when negotiated;
- a custom runtime callback.

If a runtime cannot accept dynamic external operations, the driver reports that capability gap. It MUST NOT pretend that tool delivery succeeded.

## 11. Storage ports

The Runtime depends on behavioral ports, not a database schema product.

```ts
interface OpenMatterStore {
  events: EventRepository;
  scopes: ScopeRepository;
  matters: MatterRepository;
  threads: WorkThreadRepository;
  sessions: SessionRepository;
  turns: TurnRepository;
  reactions: ReactionRepository;
  operations: OperationRepository;
  checkpoints: CheckpointRepository;
}
```

Minimum required semantics:

- insert-if-absent by idempotency key;
- compare-and-set revision;
- atomic terminal transition plus effect intent;
- expiring lease or equivalent recovery ownership;
- ordered append or sequence validation for agent events;
- configurable retention and redaction.

The first adapter is in-memory for tests and examples. SQLite or Postgres is the first durable reference adapter; neither becomes a core dependency.

## 12. Errors and diagnostics

Compiler diagnostics and runtime failures are different types.

```ts
interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  source?: SourceLocation;
  definition?: string;
  suggestion?: string;
}
```

Runtime errors use stable machine codes and retain a provider-native cause under redaction policy.

Important states are not collapsed into generic failure:

```text
denied      policy refused the operation
failed      provider confirmed failure
unknown     outcome could include an unconfirmed side effect
cancelled   cancellation completed or was acknowledged
expired     callback, session, or authority is no longer usable
```

## 13. Package shape

The initial physical package boundaries are:

```text
@openmatter/core          portable domain contracts and behavioral ports
@openmatter/openapi       OpenAPI compiler and executable HTTP plans
@openmatter/runtime       Effect-based event and reaction orchestration
@openmatter/agent-openma  thin OpenMA Agent Contract bridge
@openmatter/testing       Memory Store, Mock Work Adapter, and test fixtures
```

These packages describe the initial dependency direction:

```text
core ← openapi
core ← testing
core + Effect ← runtime
core + OpenMA Agent Contract ← agent-openma
```

The core package MUST NOT depend on Effect, an HTTP framework, a database, ACP,
React, or a provider SDK. `agent-openma` reuses the Agent Contract and ACP
runtime maintained by `openma-common`; it does not implement the protocol
again. A public `@openmatter/sdk` façade may be added after the entry points are
exercised. AsyncAPI, GraphQL, and production storage adapters remain later
packages.

## 14. Conformance and test strategy

The harness is black-box and implementation-neutral.

### Compiler fixtures

- minimal OpenAPI operation;
- every OpenAPI parameter location;
- JSON Schema references and cycles;
- multiple response media types;
- security alternatives and OAuth scopes;
- missing `operationId` determinism;
- callbacks and webhooks;
- semantic overlay conflicts;
- malicious external references;
- stable canonical output.

### Runtime fixtures

- duplicate WorkEvent returns one logical Reaction;
- ignored event produces null Reaction;
- invalid event never starts an Agent Turn;
- denied operation never reaches a binding;
- unknown write is not automatically retried;
- cancellation closes scoped resources;
- two WorkThreads may progress concurrently;
- one non-concurrent AgentSession orders its Turns;
- effect intent survives process interruption before delivery;
- native payload redaction is enforced.

### Binding fixtures

- OpenAPI serialization conformance;
- host and redirect restrictions;
- credential isolation between authorities;
- input/output schema enforcement;
- abort propagation;
- idempotency header behavior;
- provider receipt preservation.

## 15. Executable v0 slice

The current executable slice is intentionally narrow:

1. CloudEvents-compatible WorkEvent construction and qualified references;
2. generic HTTP operation plans using host `fetch`;
3. independently retryable `ingest`, `process`, and `deliver` Runtime units;
4. embedded `accept` convenience composition;
5. behavioral Store with event and operation leases/fencing;
6. CAS-backed Agent Session and Checkpoint stores;
7. Memory Store, Mock Work Adapter, WorkEventSource, and TimerAdapter;
8. OpenMA Agent Contract bridge;
9. Node embedded and Cloudflare-like deployment compositions.

The complete Work Profile compiler, durable production adapters, and concrete
ACP/managed-agent drivers remain later milestones. Slack or Linear should
validate the architecture later, not define the core abstractions prematurely.

## 16. Explicitly rejected approaches

### Partial embedding of Activepieces, Zapier, or another workflow runtime

Rejected because supplying their execution context, event lifecycle, storage, and auth semantics would recreate a large part of their runtime. If an application chooses one of those products, it should use that product completely and integrate with OpenMatter only at a documented boundary.

### OpenMatter-maintained connector catalog

Rejected as the core model. Generic compiler adapters provide broad mechanical coverage; profile authors add only semantic deltas.

### Separate work-protocol brand or wire protocol

Rejected. Work Profile and runtime records are contracts of the OpenMatter SDK. Network bindings may be standardized later only when multiple independent implementations require them.

### Mandatory Hub

Rejected. Embedded and externally orchestrated deployments remain first-class.

### Closed JSON workflow DSL

Rejected. Profiles serialize work surfaces; application orchestration stays programmable.

### Public Actor abstraction

Rejected. Actor-like ownership may exist internally, but it is not a user-facing concept or required mental model.
