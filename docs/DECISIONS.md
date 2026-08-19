# Current Design Decisions

This document records the active v0 decisions. Earlier briefs that conflict with this file are superseded.

## Product

- OpenMatter is an embeddable SDK, not a hosted Hub or required SaaS.
- It compiles work-system descriptions into portable Work Profiles and orchestrates agents against configured work surfaces.
- It is not a connector catalog. OpenMatter maintainers do not hand-code every SaaS API.
- OpenMatter leaves reasoning, planning, transcript, and private tools to the agent.
- Work Profile and runtime records are contracts of the OpenMatter SDK rather than an independent protocol or product.

## Input and artifact

- OpenAPI 3.1 is the first complete compiler input.
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
- Small `OperationBinding`, `EventBinding`, and `ResourceBinding` interfaces replace the earlier monolithic integration boundary.
- The generic OpenAPI operation binding performs HTTP invocation without provider-specific client code.
- Provider-specific webhook verification or subscription behavior may be supplied as small independent bindings.
- `AgentDriver` remains the semantic boundary for ACP, managed agents, in-process SDKs, and custom runtimes.

## Programming model

- The public SDK is code-first TypeScript.
- Work Profiles and semantic overlays are declarative and JSON-serializable.
- Application orchestration remains ordinary code rather than a closed workflow DSL.
- Component manifests, domain state, execution traces, and receipts are serializable; arbitrary user code is not.
- Effect is used internally for services, scopes, streams, cancellation, retry, and tracing.
- Public APIs use Promise, AsyncIterable, AbortSignal, and plain values. Users do not need to know Effect or Actors.

## Domain model

- The core lifecycle remains `WorkEvent → AgentScope → Matter → WorkThread → AgentSession → Turn → Reaction`.
- A Profile `ResourceAddress` is a provider representation; a `Matter` is the durable identity of the thing being worked on.
- A Channel is not automatically a Scope, WorkThread, or Session.
- Multiple channels and provider authorities may bind into one AgentScope when policy permits.
- A WorkThread may span channels and providers.
- One AgentSession normally serves one agent, runtime authority, AgentScope, WorkThread, and privacy partition.
- Public v0 uses Turn with direct retry; a separate Attempt concept and fork semantics remain deferred.
- Every valid received WorkEvent terminates with one Reaction, including an explicit null Reaction.

## Safety and authority

- Recognizing a Resource does not grant read, context, link, or mutation authority.
- Credentials are resolved by the Host for an authority and are never exposed as ordinary agent input.
- Generated write operations require policy confirmation by default.
- Unknown write outcomes are not automatically retried.
- Trusted provider servers cannot be replaced by agent-controlled URLs by default.
- Provider-native payloads and runtime-native events remain available only under provenance and redaction policy.

## Scheduled work

- A proactive agent is not a separate domain type.
- Embedded or external schedulers emit ordinary WorkEvents.
- Schedule ticks follow the normal Scope, Matter, WorkThread, Session, Turn, and Reaction lifecycle.
- Cursor, overlap, timeout, lease, and retry are scheduler/runtime concerns rather than Profile semantics.

## Neutrality

- Storage is a set of behavioral ports, not a required database.
- Deployment may be embedded, serverless, sidecar, worker-based, or distributed.
- HTTP, WebSocket, webhook, polling, queues, stdio, SDK calls, MCP, and in-process calls are binding choices.
- OpenMatter does not partially embed a workflow platform. Applications choosing Activepieces, Zapier, or another platform should use it as a complete external system behind a binding.

## Deferred decisions

- Exact physical monorepo package count.
- Reference OpenAPI parser and RFC 9535 implementation, pending conformance spikes.
- Durable reference store choice after in-memory behavior is proven.
- ACP operation delivery mechanism where a client cannot provide dynamic tools; MCP and negotiated extensions are candidate bindings.
- Network-level OpenMatter bindings. They will be standardized only after independent implementations require them.
