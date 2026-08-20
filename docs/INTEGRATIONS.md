# Work Profiles, Bindings, and Matter References

## Purpose

OpenMatter does not require one hand-written integration object per SaaS. It composes:

- a portable `WorkProfile` describing the surface;
- capability-specific runtime bindings;
- optional application resolvers and policy.

```text
machine description → Work Profile
                           +
authority configuration → Work Surface
                           +
small executable bindings → events / operations / resources
```

## Three levels of integration

### Generic

Compile OpenAPI into typed operations and execute them with the generic HTTP binding.

```ts
const profile = await compileWorkProfile({
  sources: [openapi("./api.yaml")],
});

const surface = createWorkSurface({
  profile,
  authority,
  operations: openApiOperations({ fetch, credentials }),
});
```

No provider-specific client is required. Unknown work semantics remain unknown.

### Enriched

Add a portable semantic overlay:

- stable Resource identity and aliases;
- parent and subject relationships;
- event anchors and correlation keys;
- operation safety and idempotency;
- forms, commands, and approvals;
- capabilities and provider-scope hints.

The overlay still contains no executable code or credentials.

### Custom

Register a named binding or resolver when the provider requires behavior that machine descriptions cannot express:

- webhook signature verification;
- OAuth installation callbacks;
- provider SDK event streams;
- dynamic resource expansion;
- non-HTTP operations;
- natural-language or application-specific reference resolution.

Custom code is explicit and independently packageable. It does not turn the Profile into a hidden provider runtime.

## Runtime binding surfaces

```ts
interface WorkIntegration {
  manifest: {
    id: string;
    displayName: string;
    events: readonly string[];
    operations: readonly string[];
  };
  ingest(input: unknown): Effect<readonly WorkEvent[], IntegrationError>;
  deliver(effect: WorkEffect): Effect<ProviderDeliveryResult, IntegrationError>;
}

interface ResourceMaterializer {
  materialize(
    address: ResourceAddress,
    options?: MaterializeOptions,
  ): Promise<MaterializedResource>;
}
```

A Work Integration owns provider normalization and effect delivery. Host event
sources remain ordinary application code and feed the same integration:

```text
Webhook callback     app.acceptFrom("slack", requestBody)
WebSocket / poller   source → integration.ingest → app.consume
Host timer           app.acceptFrom("schedule", nativeOccurrence)
OpenAPI operation    WorkIntegration.deliver generated from a Profile binding
Custom platform      custom WorkIntegration
```

## Events

Events normalize provider observations into CloudEvents-compatible `WorkEvent` records while retaining provider data under provenance and redaction policy.

Common event classes include:

- message, mention, reply, reaction, or deletion;
- slash command, form submission, or action callback;
- issue, task, card, comment, pull request, or document change;
- approval or permission response;
- schedule or polling result;
- custom application event.

The core does not require a globally closed event enum.

OpenAPI webhooks and callbacks or AsyncAPI messages can generate EventDefinitions. They do not automatically solve subscription registration or provider signature verification; those are binding concerns.

Every successfully normalized event enters `app.accept` through `acceptFrom` or
`consume`. Application filtering returns an explicit reaction with no effects
instead of silently dropping the event.

## Operations

Operations are typed agent-visible capabilities. The generic OpenAPI binding constructs HTTP requests from the compiled binding and validates inputs and outputs.

Operation semantics include:

- `read`, `write`, or `destructive` classification;
- confirmation floor;
- idempotency and retry rules;
- required capabilities and provider scopes;
- target and result Resource extraction;
- provider binding identity.

An operation definition is not permission. Effective grants are computed per Turn.

## Resources and Matter

A Profile `ResourceAddress` identifies a provider representation:

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

An OpenMatter `Matter` identifies the durable thing being worked on:

```text
Matter
├── Linear issue ResourceAddress
├── GitHub pull request ResourceAddress
├── Slack thread ResourceAddress
├── URL
├── team-local alias
└── unresolved natural-language evidence
```

Resource recognition, Matter resolution, WorkThread linking, context materialization, and mutation authority are separate decisions.

## Recognition pipeline

The default pipeline is deterministic and scope-aware:

```text
provider structured fields
  → entity mentions and reply relationships
  → Profile Resource selectors
  → URLs and deep links
  → scope-local syntax and aliases
  → application resolvers
  → optional agent proposal
```

Each observed reference produces one of:

```text
resolved | ambiguous | unresolved | denied
```

The original evidence, resolver identity, candidates, confidence, and provenance remain available.

Normal provider reference recognition should not require an LLM. An agent may propose a link for ambiguous natural language, but application policy decides whether to accept it.

## Provider identity examples

| Provider        | Stable address shape                        | Common human reference   | Important rule                                                        |
| --------------- | ------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Slack           | team + channel + message timestamp          | message link             | `thread_ts` identifies the root message.                              |
| Microsoft Teams | tenant/team/channel/message or chat/message | message link             | `replyToId` connects replies to a root.                               |
| Discord         | guild/channel/message                       | link or mention          | A thread is a child channel with a parent channel.                    |
| Telegram        | chat + message                              | reply or link            | Topics add `message_thread_id`.                                       |
| Lark / Feishu   | tenant/chat/message or document token       | link or mention          | Message, document, and callback identifiers have distinct lifecycles. |
| GitHub          | owner/repository/type/number or API ID      | `#123` or URL            | A number requires repository scope.                                   |
| GitLab          | project + IID or global ID                  | `!123` or full reference | IID is project-scoped.                                                |
| Jira            | site + issue ID                             | `WEB-42` or URL          | The readable key is an alias and may change.                          |
| Linear          | workspace + UUID                            | `BLA-123` or URL         | Human identifier is an alias for a stable entity ID.                  |
| Asana           | GID                                         | URL or task name         | Project and section membership are relationships.                     |
| Trello          | card ID or short link                       | URL or board number      | `idShort` is board-scoped and may change when moved.                  |
| Notion          | workspace + page/block UUID                 | link or mention          | Database rows are pages and content is composed of blocks.            |
| monday.com      | account + board/item IDs                    | item URL or name         | Board, group, item, subitem, and column are distinct Resources.       |

Human keys should be aliases when a stable provider ID exists. A raw field named `id` is not enough evidence for the Compiler to assert identity.

## Explicit Scope bindings

Provider authority and conversation coordinates are evidence for Scope resolution, not the Scope itself.

```ts
app.scopes.define("project", {
  async resolve(event) {
    return projectBindings.find({
      profile: event.openmatterprofile,
      authority: event.openmatterauthority,
      conversation: event.data.anchor?.conversation,
    });
  },
});
```

One Scope may bind multiple chat channels, an issue project, a repository, and a document workspace. Short aliases such as `#123` or `WEB-42` are resolved only after the applicable Scope and namespace are known.

## Commands, forms, and callbacks

Commands and forms are `InteractionDefinition`s and produce ordinary WorkEvents.

Profiles preserve:

- command name and argument schema;
- form input/output schema;
- action and approval semantics;
- event or operation invoked;
- provider response anchors;
- callback expiry requirements.

Interactive tokens are ephemeral credentials. They are never durable Matter identities and are redacted by default.

An operation's JSON Schema may be rendered as a form without a separate interaction. A separate definition is needed when slash-command dispatch, provider callbacks, modal lifecycle, approval, or expiry semantics matter.

## Packaging strategy

Independent packages may provide any of:

```text
Profile only                    portable semantics
Profile + operation binding    custom execution protocol
Profile + event binding        webhook/stream subscription
Full work-surface package      composed convenience export
```

This lets SaaS vendors, users, and the community publish reusable support without requiring OpenMatter core to become a connector marketplace.

A complete workflow platform may also sit behind a remote binding. In that case OpenMatter treats it as an external system and does not emulate half of its runtime in-process.
