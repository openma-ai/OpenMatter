# OpenMatter: Product and Architecture Brief

| Field | Value |
| --- | --- |
| Status | v0 design brief |
| Category | Work-surface compiler and context runtime for external agents |
| Primary API | Code-first TypeScript SDK |
| Portable artifact | Work Profile JSON |
| Work boundary | Work Profile plus capability-specific bindings |
| Agent boundary | `AgentDriver`, beginning with ACP |

## Product statement

OpenMatter turns work-system APIs and events into an interface an external agent can safely work with.

It compiles OpenAPI and other machine descriptions into portable Work Profiles. Applications may enrich those Profiles with Resource, event, interaction, risk, and relationship semantics without reimplementing the underlying API client.

At runtime OpenMatter receives work events, constructs authorized context, creates or resumes an Agent Session, exposes allowed operations, and records one terminal Reaction for every valid event.

```text
work API descriptions                         agent runtimes
        ↓                                           ↑
OpenMatter Compiler → Work Profile → Runtime → AgentDriver
                                         ↓
                         Scope · Matter · WorkThread
                         Context · Reaction · Receipts
```

## The problem

OpenAPI can describe how to call an endpoint, but an agent working inside a team also needs to know:

- which objects are durable Resources;
- which identifiers require workspace, repository, or conversation scope;
- which events and operations concern the same work;
- what is read-only, mutating, destructive, retryable, or approval-gated;
- which context is authorized and relevant;
- which events should continue one Agent Session;
- how a response becomes an auditable external effect.

Existing connector and workflow platforms solve this inside their own hosted or self-hosted runtimes. OpenMatter provides the smaller, embeddable boundary needed by applications that want to keep deployment, storage, policy, and agent choice under their control.

## Product shape

### Compiler

```text
OpenAPI / AsyncAPI / named GraphQL operations
                    +
          optional semantic overlay
                    ↓
             Work Profile JSON
```

The compiler generates broad mechanical coverage. It does not require OpenMatter maintainers to create a package for every SaaS.

### Work Profile

A Profile describes:

- typed operations and events;
- Resource identities and relationships when known;
- commands, forms, actions, and approvals;
- security requirements and capabilities;
- side-effect, confirmation, and idempotency behavior;
- provider bindings without live credentials.

### Runtime

The Runtime owns the governed work loop:

```text
WorkEvent
  → AgentScope
  → Matter resolution
  → WorkThread
  → ContextProjection
  → AgentSession / Turn
  → Reaction
  → authorized Operations and receipts
```

### AgentDriver

The agent edge maps sessions, turns, context, operation grants, event streams, permissions, cancellation, and results to ACP, managed-agent runtimes, in-process SDKs, MCP tools, or custom agents.

## Work semantics

OpenMatter distinguishes provider representation from durable work identity:

- `ResourceAddress` identifies one provider object.
- `Matter` represents the durable thing being worked on and may link many Resources.
- `AgentScope` defines shared authority, policy, subscriptions, and candidate context.
- `WorkThread` carries one structured line of ongoing work across events and providers.
- `AgentSession` carries runtime continuity for one agent; it does not replace durable work state.

This allows a Slack discussion, Linear issue, GitHub pull request, and design document to participate in the same work without pretending they share one provider model.

## Code-first, portable where it matters

Applications use ordinary TypeScript to decide activation, scope, context, session reuse, operation grants, and reaction policy.

OpenMatter serializes the stable boundaries:

- Work Profiles and source diagnostics;
- WorkEvents and Resource addresses;
- Scope, Matter, WorkThread, Session, and Turn state;
- context provenance and authorization decisions;
- operation grants, calls, results, and provider receipts;
- Reactions, including explicit null Reactions;
- execution traces.

This supports visualization, replay, and conformance without forcing application logic into JSON.

## Integration strategy

OpenMatter provides three levels of use:

1. **Generic:** compile a raw OpenAPI description into typed operations.
2. **Enriched:** add a small semantic overlay for Resources, events, risk, and interactions.
3. **Custom:** register code for provider behavior that no portable description captures.

Official examples validate the model; they are not the start of a mandatory connector catalog. Users, SaaS vendors, and the community can publish Profiles and bindings independently.

## Safety model

```text
effective operation grant
  = Profile capability
  ∩ configured authority
  ∩ actor authority
  ∩ AgentScope policy
  ∩ agent/runtime capability
  ∩ Turn grant or approval
```

Resource recognition and authorization remain separate. Generated writes are conservative; destructive floors cannot be weakened silently; unknown write outcomes are not blindly retried.

## Deployment and storage

OpenMatter supports:

- embedded applications and bots;
- serverless event handlers;
- long-running processes and sidecars;
- ingress plus worker pools;
- remote bindings when chosen by the Host.

Storage, scheduler, queue, clock, secrets, and tracing are replaceable ports. No OpenMatter Hub is required.

## What OpenMatter is not

- Not a connector marketplace OpenMatter must fill one SaaS at a time.
- Not a partial embedded copy of a workflow platform.
- Not a new agent brain, planner, or prompt graph.
- Not a replacement for OpenAPI, AsyncAPI, GraphQL, ACP, or MCP.
- Not a mandatory credential service, database, queue, or cloud.
- Not a closed workflow DSL.

## First milestone

The first executable milestone proves one vertical path:

1. compile a small OpenAPI 3.1 description;
2. apply an optional TypeScript-authored semantic overlay;
3. load the emitted Work Profile;
4. accept a WorkEvent;
5. construct a ContextProjection;
6. run a Turn through a fake then ACP AgentDriver;
7. invoke one authorized operation through the generic HTTP binding;
8. persist a terminal Reaction and receipt;
9. pass black-box conformance tests.

The implementation remains provisional until this path works without provider-specific shortcuts.
