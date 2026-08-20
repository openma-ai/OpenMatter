# Current Design Decisions

This document records the active v0 decisions. Earlier briefs that conflict with this file are superseded.

## Product

- OpenMatter is an embeddable SDK, not a hosted Hub or required SaaS.
- It compiles work-system descriptions into portable Work Profiles and orchestrates agents against configured work surfaces.
- It is not a connector catalog. OpenMatter maintainers do not hand-code every SaaS API.
- OpenMatter leaves reasoning, planning, transcript, and private tools to the agent.
- Work Profile and runtime records are contracts of the OpenMatter SDK rather than an independent protocol or product.

## Input and artifact

- OpenAPI 3.1 is the first targeted compiler input; the current package produces HTTP operation plans rather than a complete semantic compiler.
- AsyncAPI, named GraphQL documents plus introspection, MCP, provider SDKs, and custom descriptions are additional sources or bindings.
- The portable artifact is `WorkProfile` JSON.
- JSON Schema Draft 2020-12 describes portable data.
- CloudEvents 1.0 is the event-envelope baseline.
- RFC 9535 JSONPath is the portable selector language.
- Profiles contain no credential values, live clients, listeners, database handles, or executable functions.

## Compilation

- Generic compilation produces operations, schemas, security requirements, bindings, and conservative safety defaults.
- Semantic overlays optionally define Resources, aliases, relations, events, anchors, interactions, risk, idempotency, and capabilities.
- The compiler never invents stable Resource identity or authorization from suggestive field names.
- Compilation is deterministic and emits source digests, source maps, and structured diagnostics.
- Complex transformations use named plugins or runtime resolvers rather than a hidden expression language.

## Runtime boundaries

- `WorkProfile` describes a work surface.
- `WorkSurface` binds one Profile to one configured provider authority.
- The executable foundation uses `WorkIntegration`, `AgentDriver`, and `OpenMatterStore` as its stable semantic ports.
- Host-specific webhook, stream, and timer decoding belongs in a `WorkIntegration` or application adapter; v0 does not expose a second set of ingress ports.
- The generic OpenAPI operation binding performs HTTP invocation without provider-specific client code.
- Provider-specific webhook verification or subscription behavior may be supplied as small independent bindings.
- `AgentDriver` remains the semantic boundary for ACP, managed agents, in-process SDKs, and custom runtimes.

## Programming model

- The SDK is code-first TypeScript.
- Effect is the internal programming model: typed errors, Context/Layer services, Stream, structured concurrency, interruption, and resource-safe lifecycle.
- Published packages share Effect as a peer dependency so Context tags, Fibers, and Streams come from one application runtime.
- TypeScript 6 is pinned for the v0 toolchain because it is the newest release fully supported by the selected bundler; TypeScript 7 remains intentionally deferred until that support is stable.
- Promise methods are boundary facades over the same Effect programs; they do not define a second runtime.
- OpenMatter supplies conventions and typed lifecycle APIs rather than a closed declarative language.
- User code may replace or extend scope resolution, Matter resolution, context assembly, thread selection, session policy, and reaction compilation.
- Component manifests, domain state, execution traces, and receipts share one strict portable JSON boundary; executable user code is not.
- Visualization is based on manifests, runtime topology, and traces. Opaque user functions remain visible as custom-code nodes.
- The architecture rule is **immutable facts, explicit transitions**. Durable inputs and outcomes are deep snapshots; changing Session, lease, and delivery state requires an explicit fenced operation.

## Boundaries

- `WorkIntegration` is the semantic interface for work platforms.
- `AgentDriver` is the semantic interface for agent runtimes.
- ACP is the first open AgentDriver binding, not a protocol replaced by OpenMatter.
- Claude managed runtimes and custom SDKs use independent drivers.
- HTTP, WebSocket, webhook, polling, queue, stdio, and in-process calls are transport choices rather than core domains.

## Domain model

- The core lifecycle remains `WorkEvent → AgentScope → Matter → WorkThread → AgentSession → Turn → Reaction`.
- A Profile `ResourceAddress` is a provider representation; a `Matter` is the durable identity of the thing being worked on.
- A Channel is not automatically a Scope, WorkThread, or Session.
- Multiple channels and provider authorities may bind into one AgentScope when policy permits.
- A WorkThread may span channels and providers.
- Matter is the durable identity of “the thing being worked on.” Platform IDs, URLs, aliases, and natural-language phrases are representations.
- Matter resolution may remain unresolved or ambiguous. Agent-assisted linking is normally a proposal.
- One AgentSession normally serves one agent, authority, scope, WorkThread, and privacy partition.
- Executable v0 crash-resumes the same stable logical Turn. A new application retry/fork API and a separate Attempt concept are deferred.
- Every domain-complete accepted WorkEvent terminates with one Reaction, including an explicit null reaction. Infrastructure failures leave the claim recoverable.

## Scheduled work

- A proactive agent is not a separate domain type.
- The host scheduler emits a native occurrence; the configured integration or application adapter converts it into ordinary WorkEvents.
- Schedule ticks follow the normal Scope, Matter, WorkThread, Session, Turn, and Reaction lifecycle.
- Schedule registration, wake-up, overlap, timeout, and trigger retry remain host concerns.
- Cursor/checkpoint state is available through the replaceable `CheckpointStore`.
- The Runtime has no `trigger` alias and does not scan pending operations. Events enter through `ingest`; an operation worker claims one exact `callId`.

## Neutrality

- Storage is a set of behavioral ports, not a required product.
- Deployment may be embedded, single-process, sidecar, worker-based, serverless, or distributed.
- Provider-native payloads and runtime-native events remain available through lossless extension fields.
- Reference recognition, authorization, materialization, WorkThread linking, and mutation are separate decisions.

## Runtime implementation

- Domain records are immutable values with Effect Schemas, not provider-connected live objects; ingress events, application-produced terminal Reactions, Agent events, handles, and receipts are checked again at runtime boundaries.
- A ContextProjection is persisted and digest-addressed before an Agent Turn.
- Reaction plus WorkEffect intents form the durable outbox boundary and are committed before delivery. A terminal Reaction is an atomic insert-once record; completion cannot be overwritten by a late cancellation finalizer.
- Event, Session, and Effect work is claimed with expiring leases, scoped heartbeat renewal, and fenced commits. Lease requests contain durations, while each storage adapter computes expiry from its own authoritative clock inside the atomic operation.
- Outbox recovery is an explicit Runtime entry. Scheduling and queue wakeups belong to source/deployment adapters.
- Context digests accept strict JSON data only and use deterministic canonicalization before SHA-256.
- Agent Session identity includes agent, authority, Scope, WorkThread, and privacy partition; a leased mailbox serializes Turns, while Driver changes and non-resumable runtimes create explicit generations. A `creating` generation is persisted before remote creation, and its stable id is the Driver idempotency key.
- A Turn is a stable logical invocation derived from Event idempotency, Session binding, and invocation position. It persists its original ContextProjection and effective allow list; crash replay reads that input and reuses a completed result instead of invoking the Agent again.
- Turn state and OpenMAEvent writes carry the Session fence. Streams are sequence-checked; nonterminal events are checkpointed as observed, while a terminal event becomes durable only after the stream closes cleanly. Agent failure/cancellation/interruption are domain outcomes; malformed streams and transport failures remain Driver errors.
- Any persisted nonterminal Turn, including one with zero observed Agent events, may resume only in its original Session generation. Loss of that Session produces a durable `turn.interrupted`; the runtime never redispatches or splices one logical Turn across generations.
- A durable `cancelled` Turn is irreversible. Replay may repair a missing terminal checkpoint after an interrupted commit, but never revives the Agent invocation.
- Permission decisions are insert-once durable values bound to a canonical request-content fingerprint. Replay reuses the decision only when request id and content match; Drivers make repeated responses idempotent by Session/request id.
- Context grants are enforced at Agent Turn and WorkEffect creation, not merely recorded for audit. Authorization captures canonical value fingerprints, and guards return deep snapshots; caller-held references cannot mutate an authorized Context, Turn input, Reaction, or WorkEffect before commit.
- Effect interruption remains interruption while durable Turn and Reaction records become `cancelled`.
- Long-lived AsyncIterable sources and request/serverless input enter the same `acceptEffect` program.
- Integration ingress maps native observations to WorkEvents; integration egress interprets WorkEffects.
- Photon informs the coherence of the integration boundary only. OpenMatter does not adopt Spectrum's messaging object model, provider-authoring API, or managed connector plane.
