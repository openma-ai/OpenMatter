# Work Integrations and Matter References

## Purpose

A WorkIntegration maps one work system into OpenMatter without forcing that system to imitate another provider.

```ts
interface WorkIntegration {
  manifest: IntegrationManifest;
  events: EventSource;
  references: ReferenceResolver;
  context: ContextProvider;
  effects: EffectSink;
  auth: AuthProvider;
}
```

The semantic interface may be implemented in process or behind HTTP, WebSocket, webhook, polling, queue, or RPC bindings.

## Integration surfaces

### Events

Normalize provider observations into immutable WorkEvents while preserving the native payload.

Common categories include:

- message created, updated, deleted, or mentioned;
- thread or reply activity;
- slash command invocation;
- form submission and action callback;
- issue, task, card, comment, pull request, or document change;
- approval and permission response;
- schedule or polling result;
- custom provider-native events.

The core does not require a globally closed event enum.

### References

Extract structured provider references, parse links and scoped aliases, and validate address candidates.

Reference recognition does not imply authorization, materialization, or WorkThread linkage. These are separate decisions.

### Context

Materialize authorized content lazily:

- conversations, messages, and threads;
- issues, tasks, cards, comments, and boards;
- documents, pages, blocks, files, and forms;
- repositories, commits, pull requests, and build results;
- custom application records.

A URI does not grant read access.

### Effects

Compile typed WorkEffects into provider-native operations:

- reply, react, edit, delete, or post;
- open or update a form;
- request or record approval;
- create or mutate a work item;
- attach an artifact;
- execute a custom provider operation;
- deliberately perform no external action.

Effect delivery is idempotent and returns a receipt.

### Capabilities and auth

The manifest declares supported events, resources, operations, interactive surfaces, authentication modes, permission scopes, rate limits, and delivery constraints.

Provider-native extensions are allowed. Unsupported features are explicit rather than approximated silently.

## Matter reference model

Platform resources, URLs, aliases, and natural-language phrases are representations of a possible Matter.

```ts
type MatterReference =
  | {
      type: "platform";
      provider: string;
      authority: string;
      resourceType: string;
      id: string;
      path?: Record<string, string>;
      aliases?: string[];
      uri?: string;
    }
  | { type: "url"; url: string }
  | { type: "alias"; namespace: string; value: string }
  | { type: "text"; value: string }
  | { type: "conversation"; anchor: SourceAnchor }
  | { type: string; value: unknown };
```

Provider IDs are authority-scoped and often compound. Human identifiers should usually be aliases rather than canonical IDs.

## Resolution pipeline

The recommended default is deterministic and scope-aware:

```text
provider structured fields
  → entity mentions and reply relationships
  → URLs and deep links
  → scope-local syntax and aliases
  → application resolvers
  → optional agent proposal
```

Each observed mention produces one of:

```text
resolved | ambiguous | unresolved | denied
```

The original text or structured evidence, resolver identity, candidates, confidence, and provenance remain available.

Normal provider reference recognition should not require an LLM. An agent may propose a link for natural language or ambiguous cases, subject to application policy.

## Provider identity examples

| Provider | Stable address shape | Common human reference | Important rule |
| --- | --- | --- | --- |
| Slack | team + channel + message timestamp | message link | `thread_ts` identifies the root thread message. |
| Microsoft Teams | tenant/team/channel/message or chat/message | message link | `replyToId` connects replies to a root. |
| Discord | guild/channel/message | message link or mention | A thread is a child channel with a parent channel. |
| Telegram | chat + message | reply or link | Topics add `message_thread_id`. |
| Lark/Feishu | tenant/chat/message or document token | link or mention | Chat, message, document, and interactive callback IDs have different lifecycles. |
| GitHub | owner/repository/type/number or stable API ID | `#123` or URL | A number requires repository scope. |
| GitLab | project + IID or global ID | `!123` or full project reference | IID is project-scoped. |
| Jira | site + issue ID | `WEB-42` or URL | The readable issue key is an alias and may change. |
| Linear | workspace + UUID | `BLA-123` or URL | Human identifier is an alias for a stable entity ID. |
| Asana | GID | URL or task name | Membership in projects and sections is separate from identity. |
| Trello | card ID or short link | URL or board-local number | `idShort` is board-scoped and may change when moved. |
| Notion | workspace + page/block UUID | page link or mention | Database rows are pages and content is composed of blocks. |
| monday.com | account + board/item IDs | item URL or name | Board, group, item, subitem, and column are distinct resource kinds. |

## Explicit bindings

Application code should prefer explicit provider-to-scope bindings over guesses.

```ts
app.scopes.define("project", {
  async resolve(event) {
    return projectBindings.find({
      provider: event.source.provider,
      authority: event.source.authority,
      conversationId: event.source.conversationId,
    });
  },
});
```

A binding may associate multiple Slack channels, a Linear project, a GitHub repository, and a Notion workspace with one AgentScope.

Short aliases such as `#123` or `WEB-42` are resolved only after the applicable scope and namespace are known.

## Matter linking

Resolution and linking are separate:

- native provider relationships may link automatically;
- deterministic application rules may link automatically;
- user actions may explicitly link or unlink;
- agent suggestions should normally be recorded as proposals;
- uncertain references may remain unresolved without blocking the event.

One WorkThread may link many Matters. One Matter may appear in many WorkThreads with different roles.

## Commands, forms, and callbacks

Slash commands, form submissions, and interactive callbacks are normalized WorkEvents.

Integrations preserve:

- command name and arguments;
- form schema or definition reference;
- structured submitted values;
- trigger, callback, and expiry tokens;
- source and response anchors;
- actor and authorization context.

Interactive tokens are ephemeral credentials, not durable Matter identities. Form definitions and submitted artifacts may be represented as Matters when the application needs durable continuity.

## OpenTag lessons

OpenMatter adopts several useful distinctions from OpenTag:

- conversation anchors are different from work-item references;
- context pointers retain visibility and provenance;
- explicit channel-to-project binding is safer than guessing;
- context assembly benefits from observable stages and hooks.

OpenMatter generalizes beyond OpenTag by allowing multiple Matters per WorkThread, arbitrary work systems rather than repository-centered targets, and application-owned semantics rather than core command-intent classification.
