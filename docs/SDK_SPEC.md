# OpenMatter SDK Specification v0.1

| Field | Value |
| --- | --- |
| Status | Draft specification |
| Version | `0.1` |
| Default schema dialect | JSON Schema Draft 2020-12 |
| Event envelope | CloudEvents 1.0 compatible |
| Primary source format | OpenAPI 3.1 |

## 1. Abstract

The OpenMatter SDK defines a transport-neutral contract and portable profile format for describing and operating a work surface that an agent can observe and act upon.

The SDK turns API descriptions, event descriptions, and optional work semantics into one portable Work Profile containing:

- operations an agent may request;
- events an application may subscribe to;
- resources those operations and events concern;
- human interactions such as commands and forms;
- capabilities, safety properties, and provider bindings.

An OpenMatter Work Profile is JSON. It may be generated from OpenAPI or another machine-readable source, enriched by a user-authored semantic overlay, validated independently, and loaded by any conforming runtime.

The SDK does not define an agent's reasoning loop. OpenMatter uses Work Profiles and Work Bindings on the work side, and Agent Client Protocol or another `AgentDriver` on the agent side.

```text
OpenAPI / AsyncAPI / GraphQL / custom description
                         +
              optional semantic overlay
                         ↓
                OpenMatter Work Profile
                         ↓
      WorkEvent ← OpenMatter Runtime → Operation
                         ↓
                 ACP / managed agent
```

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as normative requirements.

## 2. Scope

### 2.1 Goals

The OpenMatter SDK is intended to:

1. expose an API as typed agent operations without writing a provider-specific runtime;
2. preserve work concepts that OpenAPI alone cannot express;
3. normalize events without erasing provider-native payloads;
4. make safety, authority, idempotency, and side effects inspectable;
5. support commands, forms, messages, work items, documents, and proactive sources;
6. remain portable across embedded, serverless, worker, and distributed runtimes;
7. allow independent profile authors and runtime implementers.

### 2.2 Non-goals

The OpenMatter SDK is not:

- a replacement for HTTP, OpenAPI, AsyncAPI, GraphQL, or provider SDKs;
- an agent transport or replacement for ACP;
- a workflow, prompt graph, planner, or model SDK;
- a credential vault, OAuth service, queue, scheduler, or database;
- a catalog that OpenMatter must populate one SaaS at a time;
- a globally closed taxonomy of every possible work event or resource;
- permission to access a resource merely because its address is recognized.

## 3. Relationship to adjacent standards

```text
OpenAPI     describes how an HTTP API can be called
AsyncAPI    describes event-driven channels and messages
OpenMatter  describes what an agent can observe and do at work
ACP         carries agent session input, updates, permissions, and cancellation
```

Work Profiles reuse rather than replace existing standards:

- JSON Schema Draft 2020-12 for data validation;
- CloudEvents 1.0 for event envelopes;
- RFC 9535 JSONPath for declarative selection from JSON values;
- OpenAPI bindings for HTTP execution;
- AsyncAPI bindings for event channels where available.

Transport bindings are separable. The same operation may execute through HTTP, an SDK function, MCP, RPC, or custom code while retaining one stable Work Profile identity.

## 4. Conformance roles

An implementation may conform as one or more roles.

| Role | Responsibility |
| --- | --- |
| Profile | A valid, portable description of a work surface. |
| Compiler | Converts a source description plus overlays into a Profile and diagnostics. |
| Binding | Delivers events, materializes resources, or executes operations for a Profile. |
| Runtime | Consumes WorkEvents, enforces policy, invokes operations, and records Reactions. |
| Agent adapter | Presents authorized OpenMatter context and operations to an agent runtime. |

A conforming Compiler MUST be deterministic for the same source bytes, configuration, and overlay order. A conforming Runtime MUST NOT require a specific Compiler.

## 5. Common conventions

### 5.1 Versions

`openmatter` identifies the OpenMatter feature set. This draft uses `0.1`.

Profile authors MUST separately version the described work surface using `info.version`. Changing a provider profile does not change the OpenMatter specification version.

### 5.2 IDs

Profile-local identifiers SHOULD match:

```regex
^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$
```

Examples:

```text
issue
issue.comment.create
message.mentioned
incident-triage
```

The tuple `(profile.id, profile.info.version, local identifier)` identifies a definition. Runtime records MUST additionally identify the configured provider authority.

### 5.3 Authority

An Authority identifies the provider installation, tenant, account, workspace, or equivalent security boundary against which an event is observed or an operation is executed.

```ts
interface AuthorityRef {
  profile: string;
  id: string;
}
```

An authority reference MUST NOT contain credentials. Credential resolution is a host responsibility.

### 5.4 Schemas

OpenMatter schemas use JSON Schema Draft 2020-12 unless a definition explicitly declares another supported dialect.

```ts
type JsonSchema = boolean | Record<string, unknown>;
type JsonSchemaRef = JsonSchema | { $ref: string };
```

A portable Profile SHOULD bundle referenced schemas. A Profile that retains remote references MUST record their immutable digest and MUST NOT require a runtime to dereference an untrusted URL without host approval.

### 5.5 Native data

Normalization MUST be loss-aware. A binding SHOULD retain the provider-native input when policy permits it. Native data MUST be marked with its media type, source, and visibility; it MUST NOT silently override normalized fields.

## 6. Profile document

An OpenMatter Profile has the following top-level shape:

```ts
interface WorkProfile {
  $schema?: string;
  openmatter: "0.1";
  id: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  sources?: SourceDescriptor[];
  schemas?: Record<string, JsonSchema>;
  security?: Record<string, SecurityDefinition>;
  resources?: Record<string, ResourceDefinition>;
  operations?: Record<string, OperationDefinition>;
  events?: Record<string, EventDefinition>;
  interactions?: Record<string, InteractionDefinition>;
  capabilities?: Record<string, CapabilityDefinition>;
  extensions?: Record<string, unknown>;
}
```

All maps are optional but a Profile MUST define at least one operation, event, resource, or interaction.

### 6.1 Source descriptors

Source descriptors make generated artifacts reproducible and auditable.

```ts
interface SourceDescriptor {
  kind: "openapi" | "asyncapi" | "graphql" | "overlay" | "custom";
  uri?: string;
  mediaType?: string;
  digest: string;
  compiler?: string;
}
```

`digest` MUST cover the exact source bytes used by the Compiler.

## 7. Resources

A Resource is a provider-addressable representation of something that may be observed, read, related, or changed. A Resource is not automatically an OpenMatter `Matter`; a Matter may link multiple resource addresses from several providers.

```ts
interface ResourceDefinition {
  title?: string;
  description?: string;
  schema?: JsonSchemaRef;
  identity: ResourceIdentityRule;
  aliases?: SelectorRule[];
  uri?: SelectorRule;
  parent?: ResourceRelationRule;
  capabilities?: string[];
  extensions?: Record<string, unknown>;
}
```

Identity and extraction rules use selectors rather than executable expressions:

```ts
interface ResourceIdentityRule {
  id: SelectorRule;
  containers?: Record<string, SelectorRule>;
  onMissing?: "omit" | "error";
}

interface ResourceExtractionRule {
  resource: string;
  id: SelectorRule;
  containers?: Record<string, SelectorRule>;
  aliases?: SelectorRule[];
  uri?: SelectorRule;
  role?: "subject" | "target" | "result" | "related";
}

interface ResourceRelationRule {
  relation: "parent" | "child" | "related" | string;
  address: ResourceExtractionRule;
}
```

### 7.1 Resource address

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

`id` MUST be stable within the declared authority and required containers. Human-readable keys such as `WEB-42` or `#123` SHOULD be retained as aliases when a more stable provider ID exists.

The tuple below is the canonical provider identity:

```text
profile + authority + resource type + containers + id
```

A Compiler MUST NOT invent a Resource identity when the source description does not provide sufficient evidence. It MAY emit an unbound candidate and a diagnostic requesting semantic enrichment.

### 7.2 Selectors

Declarative selectors use RFC 9535 JSONPath.

```ts
interface SelectorRule {
  from: "event" | "input" | "output" | "error" | "native";
  path: string;
  required?: boolean;
}
```

Selectors only select JSON values. Arbitrary computation belongs in an explicitly registered custom resolver; OpenMatter does not define a hidden general-purpose expression language.

## 8. Operations

An Operation is a typed capability that may be requested against a configured authority.

```ts
interface OperationDefinition {
  title?: string;
  description?: string;
  input?: JsonSchemaRef;
  output?: JsonSchemaRef;
  errors?: Record<string, JsonSchemaRef>;
  target?: string;
  resultResources?: ResourceExtractionRule[];
  behavior: OperationBehavior;
  requires?: string[];
  binding: OperationBinding;
  provenance?: SemanticProvenance;
  extensions?: Record<string, unknown>;
}
```

### 8.1 Behavior

```ts
interface OperationBehavior {
  class: "read" | "write" | "destructive";
  idempotency: "none" | "provider" | "key" | "conditional";
  confirmation: "never" | "policy" | "always";
  timeoutMs?: number;
  retry?: "never" | "safe" | "with-idempotency-key";
}
```

These fields describe safety properties; they do not grant authority.

- A Runtime MUST NOT automatically retry `write` or `destructive` operations unless their idempotency rule is satisfied.
- A generated but unreviewed `write` or `destructive` classification MUST default to `confirmation: policy` or stricter.
- `confirmation: never` means the operation does not require confirmation by definition; application policy MAY still deny it.
- `confirmation: always` MUST NOT be weakened by application policy.

### 8.2 Bindings

The v0 binding registry begins with:

```ts
type OperationBinding =
  | {
      type: "openapi";
      source: string;
      operationId: string;
      server?: string;
    }
  | {
      type: "graphql";
      source: string;
      document: string;
      operationName?: string;
    }
  | {
      type: "mcp";
      server: string;
      tool: string;
    }
  | {
      type: "custom";
      handler: string;
      config?: unknown;
    };
```

Binding configuration MUST NOT contain resolved secrets.

## 9. Events

An EventDefinition describes an observation that may enter a work loop.

```ts
interface EventDefinition {
  title?: string;
  description?: string;
  data: JsonSchemaRef;
  subjects?: ResourceExtractionRule[];
  anchor?: AnchorExtractionRule;
  actor?: ResourceExtractionRule;
  requires?: string[];
  binding?: EventBinding;
  provenance?: SemanticProvenance;
  extensions?: Record<string, unknown>;
}
```

```ts
interface AnchorExtractionRule {
  conversation?: ResourceExtractionRule;
  thread?: ResourceExtractionRule;
  message?: ResourceExtractionRule;
  interaction?: ResourceExtractionRule;
  uri?: SelectorRule;
}

type EventBinding =
  | {
      type: "asyncapi";
      source: string;
      operationId: string;
    }
  | {
      type: "webhook";
      source: string;
      event: string;
    }
  | {
      type: "poll";
      operation: string;
      cursor?: SelectorRule;
    }
  | {
      type: "custom";
      handler: string;
      config?: unknown;
    };
```

Bindings may describe webhooks, polling, queues, WebSocket streams, provider SDK callbacks, schedules, or custom ingress. The Profile describes the event surface; deployment-specific listener addresses and secrets are runtime configuration.

### 9.1 WorkEvent envelope

OpenMatter WorkEvents are valid CloudEvents 1.0 structured events with OpenMatter extension attributes.

```json
{
  "specversion": "1.0",
  "id": "evt_01J...",
  "source": "urn:authority:linear:workspace-1",
  "type": "com.linear.issue.updated",
  "subject": "urn:openmatter:resource:linear:workspace-1:issue:issue-uuid",
  "time": "2026-08-19T08:30:00Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:openmatter:profile:linear:1.0#event/issue.updated",
  "openmatterversion": "0.1",
  "openmatterprofile": "urn:openmatter:profile:linear",
  "openmatterauthority": "workspace-1",
  "data": {
    "payload": {},
    "actor": {},
    "anchor": {},
    "references": [],
    "native": {}
  }
}
```

The pair `(source, id)` MUST identify one logical event. Redelivery MUST retain that pair.

The `data` member has this normalized shape:

```ts
interface WorkEventData {
  payload: unknown;
  actor?: ResourceAddress;
  anchor?: WorkAnchor;
  references?: WorkReference[];
  native?: {
    mediaType: string;
    source: string;
    visibility: "private" | "scope" | "public";
    value: unknown;
  };
}

type WorkReference =
  | ResourceAddress
  | { type: "url"; url: string }
  | { type: "alias"; namespace: string; value: string }
  | { type: "text"; value: string; start?: number; end?: number }
  | { type: string; value: unknown };
```

Native payload retention is optional and policy-controlled. A Runtime MUST NOT expose `native.value` to an agent merely because it is present in storage.

### 9.2 Anchor

An Anchor identifies where an event happened and where a response may be directed.

```ts
interface WorkAnchor {
  conversation?: ResourceAddress;
  thread?: ResourceAddress;
  message?: ResourceAddress;
  interaction?: ResourceAddress;
  uri?: string;
}
```

An Anchor is not necessarily a Resource subject, AgentScope, WorkThread, or AgentSession.

## 10. Interactions

Interactions describe human-originated or human-facing structured surfaces.

```ts
interface InteractionDefinition {
  kind: "command" | "form" | "action" | "approval" | string;
  title?: string;
  description?: string;
  input?: JsonSchemaRef;
  output?: JsonSchemaRef;
  invokes?: string;
  emits?: string;
  expires?: string;
  binding?: Record<string, unknown>;
}
```

Examples include slash commands, modal submissions, message buttons, approval cards, and web forms.

Interaction tokens and callback URLs are ephemeral credentials. They MUST NOT be used as durable Resource identities and MUST be redacted from traces unless an explicit secure retention policy applies.

An Operation input schema MAY be rendered as a form without a separate InteractionDefinition. An explicit interaction is needed when provider callback, expiry, response, or invocation semantics matter.

## 11. Capabilities and security

### 11.1 Capability definitions

Capabilities name what a binding or authority may support.

```ts
interface CapabilityDefinition {
  title?: string;
  description?: string;
  kind: "event" | "operation" | "resource.read" | "interaction" | string;
  providerScopes?: string[];
}
```

Effective permission is computed at runtime:

```text
profile capability
  ∩ configured authority capability
  ∩ actor authority
  ∩ AgentScope policy
  ∩ agent/runtime capability
  ∩ per-turn grant or approval
```

Recognizing a ResourceAddress does not authorize reading or mutating it.

### 11.2 Security definitions

Profiles describe credential requirements but never carry credential values.

```ts
interface SecurityDefinition {
  type: "apiKey" | "oauth2" | "http" | "mutualTLS" | "custom";
  description?: string;
  scopes?: Record<string, string>;
  extensions?: Record<string, unknown>;
}
```

A host `CredentialProvider` binds a configured authority to concrete credentials. The Runtime MUST prevent the agent from selecting arbitrary credential material or overriding trusted provider hosts unless policy explicitly permits it.

## 12. Runtime messages

Profiles describe a surface. Runtime messages describe use of that surface.

### 12.1 OperationCall

```ts
interface OperationCall {
  openmatter: "0.1";
  id: string;
  profile: string;
  authority: string;
  operation: string;
  input: unknown;
  actor?: ResourceAddress;
  target?: ResourceAddress;
  requestedAt: string;
  idempotencyKey?: string;
  causation?: {
    eventSource: string;
    eventId: string;
    turnId?: string;
  };
}
```

The Runtime MUST validate `input` before execution and MUST validate a successful `output` before exposing it as trusted normalized data.

### 12.2 OperationResult

```ts
interface OperationResult {
  openmatter: "0.1";
  callId: string;
  status: "succeeded" | "failed" | "denied" | "cancelled" | "unknown";
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  };
  resources?: ResourceAddress[];
  receipt?: {
    providerRequestId?: string;
    idempotencyKey?: string;
    occurredAt: string;
    native?: unknown;
  };
}
```

`unknown` means the binding cannot determine whether a side effect occurred. A Runtime MUST NOT blindly retry an unknown write.

### 12.3 Reaction

A Reaction is the one terminal application outcome for a received WorkEvent.

```ts
interface Reaction {
  openmatter: "0.1";
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

`effects: []` is an explicit null reaction. Filtering, observing without acting, and deciding that no response is appropriate MUST still produce a Reaction rather than silently dropping a valid WorkEvent.

Invalid transport input that cannot be normalized into a WorkEvent is a delivery error, not a WorkEvent. Duplicate delivery resolves to the existing Reaction and MUST NOT create a second logical reaction.

## 13. Delivery and processing semantics

OpenMatter does not mandate a queue or transport, but conforming runtimes implement these observable semantics:

1. validate the WorkEvent envelope and referenced Profile definition;
2. record reception using `(source, id)` as the logical deduplication key;
3. process or deliberately ignore the event according to application policy;
4. produce exactly one terminal Reaction;
5. authorize and execute zero or more effects;
6. retain effect receipts and uncertainty states;
7. return the existing terminal result on duplicate delivery.

At-least-once event delivery is supported. Exactly-once provider side effects are not promised; OpenMatter provides idempotency keys, state transitions, and receipts needed to approach effectively-once behavior when the provider supports it.

Ordering is scoped. A Profile MAY declare an ordering key, but a Runtime MUST NOT assume a total order across authorities, conversations, or resources.

## 14. OpenAPI compilation

### 14.1 Supported inputs

The normative v0 Compiler target is OpenAPI 3.1.x. A Compiler MAY accept OpenAPI 3.0.x after schema conversion and MUST report lossy or unsupported constructs.

### 14.2 Operation mapping

For every selected OpenAPI Operation Object, the Compiler:

1. uses `operationId` as the preferred stable source identity;
2. produces a deterministic generated identity and warning when `operationId` is absent;
3. combines path, query, header, cookie, and request-body inputs into one object schema;
4. maps successful responses into the output schema;
5. maps documented error responses into `errors`;
6. carries descriptions, tags, deprecation, security, and server selection;
7. emits an `openapi` binding referencing the source operation;
8. records whether safety semantics were declared, inferred, or supplied by an overlay.

HTTP method inference is conservative:

| Method | Default class |
| --- | --- |
| `GET`, `HEAD`, `OPTIONS` | `read` |
| `DELETE` | `destructive` |
| all others | `write` |

Method inference is only a safety floor. A `POST` search may be enriched to `read`; a dangerous `GET` must be marked more strictly. Unreviewed generated writes require policy confirmation by default.

### 14.3 Resource mapping

OpenAPI response schemas do not prove stable resource identity. A Compiler MAY emit resource candidates from explicit links, schema metadata, or `x-openmatter` annotations, but MUST NOT assert canonical identity solely from property names such as `id`.

Resource semantics normally come from one of:

- an `x-openmatter` extension in the source document;
- a sidecar semantic overlay;
- a registered Compiler plugin;
- application code at runtime.

### 14.4 Event mapping

OpenAPI 3.1 `webhooks` and Callback Objects MAY generate EventDefinitions when message schemas and correlation data are sufficient. Generation does not imply that a runtime can automatically register the provider webhook.

AsyncAPI is the preferred source when event channels, messages, and bindings are available.

### 14.5 Security mapping

OpenAPI Security Scheme Objects map to OpenMatter SecurityDefinitions. OAuth scopes and operation security requirements are preserved.

Server URLs are trusted configuration derived from the compiled source or authority setup. Agent input MUST NOT be allowed to replace the scheme, host, or base path by default.

## 15. Semantic overlays

An overlay enriches generated definitions without replacing the source API description.

```ts
interface WorkSemanticOverlay {
  openmatter: "0.1";
  target: {
    profile: string;
    sourceDigest?: string;
  };
  resources?: Record<string, Partial<ResourceDefinition>>;
  operations?: Record<string, Partial<OperationDefinition>>;
  events?: Record<string, Partial<EventDefinition>>;
  interactions?: Record<string, Partial<InteractionDefinition>>;
  capabilities?: Record<string, Partial<CapabilityDefinition>>;
}
```

Overlays are keyed by stable definition IDs. A Compiler MUST apply overlays in explicitly declared order, record their digests, and report references to missing source definitions.

Overlay source may be JSON, YAML, or a TypeScript authoring API, but the emitted artifact MUST be equivalent JSON.

Example authoring API:

```ts
export default defineWorkProfile({
  source: openapi("./work-api.yaml"),

  resources: {
    issue: resource({
      identity: select("output", "$.id"),
      aliases: [select("output", "$.identifier")],
    }),
  },

  operations: {
    createComment: operation({
      id: "issue.comment.create",
      target: "issue",
      class: "write",
      idempotency: "key",
    }),
  },
});
```

This code is an authoring convenience. It does not execute in the portable Profile.

## 16. Extensions

Profile definitions may include `extensions`. Extension keys SHOULD be URI-qualified or use a collision-resistant reverse-domain prefix.

Source descriptions may use `x-openmatter` specification extensions. A Compiler MUST preserve unknown source extensions in diagnostics or native metadata; it MUST NOT reinterpret an unknown extension as permission.

An implementation encountering an unknown REQUIRED extension MUST reject the affected definition. Unknown optional extensions MAY be ignored while remaining preserved.

Semantic fields may carry provenance:

```ts
interface SemanticProvenance {
  kind: "declared" | "inferred" | "overlay" | "custom";
  source: string;
  confidence?: number;
}
```

Inference provenance is informational and MUST NOT itself grant a capability or lower a confirmation requirement.

## 17. Compatibility

During `0.x`, no wire compatibility promise exists across minor OpenMatter versions.

Within one OpenMatter feature version:

- adding an optional definition is backward-compatible;
- adding a new optional field is backward-compatible;
- removing or changing an existing operation, event, or schema requires a new Profile `info.version`;
- changing Resource identity rules requires a new Profile version and migration guidance;
- changing an operation from stricter to less strict safety semantics requires explicit review and MUST NOT occur through inference alone.

Runtimes SHOULD negotiate supported OpenMatter feature versions and binding types before loading a Profile.

## 18. Conformance levels

The initial harness will define these levels:

| Level | Required behavior |
| --- | --- |
| Profile Core | Schema-valid Profile, stable IDs, bundled schemas, source digests. |
| OpenAPI Compiler | Deterministic operation generation, validation, security mapping, diagnostics. |
| Event Runtime | CloudEvents-compatible ingestion, deduplication, exactly one Reaction including null. |
| Operation Runtime | Input/output validation, authorization hook, idempotency and receipt behavior. |
| Work Semantics | Resource extraction, anchor preservation, reference provenance, capability narrowing. |

Provider feature coverage is declared separately. A Profile may conform while defining only operations or only events.

## 19. End-to-end example

Given this OpenAPI operation:

```yaml
paths:
  /issues/{issueId}/comments:
    post:
      operationId: createIssueComment
      parameters:
        - in: path
          name: issueId
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [body]
              properties:
                body: { type: string }
      responses:
        "201":
          description: Created
```

The generic Compiler can emit:

```json
{
  "operations": {
    "createIssueComment": {
      "input": { "$ref": "#/schemas/createIssueComment.input" },
      "output": { "$ref": "#/schemas/createIssueComment.output" },
      "behavior": {
        "class": "write",
        "idempotency": "none",
        "confirmation": "policy",
        "retry": "never"
      },
      "binding": {
        "type": "openapi",
        "source": "work-api",
        "operationId": "createIssueComment"
      },
      "provenance": {
        "kind": "inferred",
        "source": "http-method"
      }
    }
  }
}
```

An optional overlay can rename it to `issue.comment.create`, associate it with the `issue` Resource, declare provider idempotency behavior, and extract the created comment Resource. The HTTP call itself is still executed by the generic OpenAPI binding.

This separation is the central OpenMatter rule:

> Machine descriptions provide invocation mechanics. Profiles add only the work semantics that machines cannot safely infer.
