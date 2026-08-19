# Current Design Decisions

This is a compact record of the decisions represented by the v0 briefs.

## Product

- OpenMatter is an embeddable framework, not a hosted Hub or required SaaS.
- The public name is OpenMatter; the framework focuses on integration and context for work agents.
- The framework manages work around the agent and leaves reasoning, planning, and internal tools to the agent.

## Programming model

- The SDK is code-first TypeScript.
- OpenMatter supplies conventions and typed lifecycle APIs rather than a closed declarative language.
- User code may replace or extend scope resolution, Matter resolution, context assembly, thread selection, session policy, and reaction compilation.
- Component manifests, domain state, execution traces, and receipts are JSON-serializable; executable user code is not.
- Visualization is based on manifests, runtime topology, and traces. Opaque user functions remain visible as custom-code nodes.

## Boundaries

- `WorkIntegration` is the semantic interface for work platforms.
- `AgentDriver` is the semantic interface for agent runtimes.
- ACP is the first open AgentDriver binding, not a protocol replaced by OpenMatter.
- Claude managed runtimes and custom SDKs use independent drivers.
- HTTP, WebSocket, webhook, polling, queue, stdio, and in-process calls are transport choices rather than core domains.

## Domain model

- The core lifecycle is `WorkEvent → AgentScope → Matter → WorkThread → AgentSession → Turn → Reaction`.
- A channel is not automatically a Scope, WorkThread, or Session.
- Multiple channels may bind to one AgentScope.
- A WorkThread may span channels and providers.
- Matter is the durable identity of “the thing being worked on.” Platform IDs, URLs, aliases, and natural-language phrases are representations.
- Matter resolution may remain unresolved or ambiguous. Agent-assisted linking is normally a proposal.
- One AgentSession normally serves one agent, authority, scope, WorkThread, and privacy partition.
- Public v0 uses Turn with direct retry; a separate Attempt concept and fork semantics are deferred.
- Every accepted WorkEvent terminates with one Reaction, including an explicit null reaction.

## Scheduled work

- “Proactive agent” is not a separate domain type.
- Applications define scheduled tasks using ordinary handler code.
- Every schedule tick becomes a WorkEvent and follows the normal lifecycle.
- Checkpoints, leases, overlap, retry, and timeout are generic scheduling concerns.

## Neutrality

- Storage is a set of behavioral ports, not a required product.
- Deployment may be embedded, single-process, sidecar, worker-based, serverless, or distributed.
- Provider-native payloads and runtime-native events remain available through lossless extension fields.
- Reference recognition, authorization, materialization, WorkThread linking, and mutation are separate decisions.
