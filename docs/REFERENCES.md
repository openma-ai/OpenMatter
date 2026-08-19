# Design References and Platform APIs

This document records the primary specifications and provider APIs used to ground the OpenMatter design. Links point to official documentation or official specification repositories where available.

## API, event, and data standards

| Standard | Reference | OpenMatter relevance |
| --- | --- | --- |
| OpenAPI 3.1.1 | [Specification](https://spec.openapis.org/oas/v3.1.1.html) | Primary compiler input for HTTP operations, schemas, security requirements, servers, callbacks, and webhooks. |
| AsyncAPI 3.1 | [Specification](https://www.asyncapi.com/docs/reference/specification/v3.1.0) | Event channels, messages, operations, correlation information, and protocol bindings. |
| JSON Schema 2020-12 | [Specification](https://json-schema.org/draft/2020-12) | Canonical portable schema dialect for Work Profiles and operation payloads. |
| CloudEvents 1.0 | [Specification repository](https://github.com/cloudevents/spec) | Transport-neutral WorkEvent envelope and event identity baseline. |
| JSONPath | [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html) | Portable selectors for Resource, actor, anchor, and result extraction. |
| GraphQL | [Specification](https://spec.graphql.org/October2021/) | Introspection plus named query or mutation documents as an additional compiler source. |

OpenMatter reuses these standards rather than replacing them. Work Profile adds agent-work semantics and provider binding references around them.

## Runtime implementation

| System | Reference | OpenMatter relevance |
| --- | --- | --- |
| Effect | [Documentation](https://effect.website/docs/) | Internal services, scopes, streams, cancellation, retry, testing, and tracing. Public APIs remain ordinary TypeScript. |

## Agent runtimes

| System | Reference | OpenMatter relevance |
| --- | --- | --- |
| Agent Client Protocol | [Introduction](https://agentclientprotocol.com/get-started/introduction) | Open AgentDriver binding for capability negotiation, sessions, updates, permissions, and cancellation. |
| Agent Client Protocol | [Specification repository](https://github.com/agentclientprotocol/agent-client-protocol) | Normative schemas and protocol evolution. |
| Claude managed runtimes | [Managed agent sessions](https://platform.claude.com/docs/en/managed-agents/sessions) | Managed AgentDriver binding for hosted sessions and event streams. |

## OpenTag

| Reference | Relevance |
| --- | --- |
| [OpenTag repository](https://github.com/amplifthq/opentag) | Coding-agent gateway and work-thread precedent. |
| [OpenTag core schema](https://github.com/amplifthq/opentag/blob/main/packages/core/src/schema.ts) | Context pointers, work-item references, conversation anchors, visibility, and provenance. |
| [OpenTag protocol model](https://github.com/amplifthq/opentag/blob/main/packages/core/src/protocol.ts) | Work-thread and event lifecycle concepts. |
| [OpenTag configuration](https://github.com/amplifthq/opentag/blob/main/docs/configuration.md) | Explicit provider and project bindings. |

OpenMatter adopts the separation of conversation anchors, work references, and context pointers. It generalizes the model to many Matters per WorkThread, arbitrary work systems, code-first application policy, and replaceable agent runtimes.

## IM and collaboration platforms

| Platform | Events and API | Identity and threading notes |
| --- | --- | --- |
| Slack | [Events API](https://docs.slack.dev/apis/events-api/), [Web API methods](https://docs.slack.dev/reference/methods/), [message events](https://docs.slack.dev/reference/events/message/), [message retrieval](https://docs.slack.dev/messaging/retrieving-messages/) | A message timestamp identifies a message inside a conversation; `thread_ts` points to the root message. Message metadata provides structured event payloads. |
| Microsoft Teams | [Microsoft Graph chatMessage](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0), [get chatMessage](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0) | Routes include tenant/team/channel/message or chat/message coordinates; `replyToId` associates replies with a root. |
| Discord | [Message resource](https://docs.discord.com/developers/resources/message), [Threads](https://docs.discord.com/developers/topics/threads), [API reference](https://docs.discord.com/developers/reference) | Messages include structured mentions and references. A thread is a channel object with a parent channel. |
| Telegram | [Bot API](https://core.telegram.org/bots/api) | `message_id` is scoped to a chat; topics use `message_thread_id`; replies carry structured relationships. |
| Lark / Feishu | [Open platform documentation](https://open.feishu.cn/document/home/index), [chat identifiers](https://open.feishu.cn/document/server-docs/group/chat-tab/list_tabs?lang=en-US), [message-card interaction](https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interaction-module?lang=en-US) | Chat IDs, message IDs, document tokens, and callback tokens have distinct scopes and lifecycles. |

## Work, kanban, code, and knowledge platforms

| Platform | API or specification | Identity notes |
| --- | --- | --- |
| GitHub | [REST API](https://docs.github.com/en/rest), [REST OpenAPI descriptions](https://github.com/github/rest-api-description), [autolinked references](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls) | Issue and pull-request numbers require repository scope. Commits use repository plus ref or SHA. |
| GitLab | [REST API](https://docs.gitlab.com/api/rest/), [Issues API](https://docs.gitlab.com/api/issues/), [Merge requests API](https://docs.gitlab.com/api/merge_requests/) | Global IDs and project-scoped IIDs are different. Short references require project context. |
| Jira Cloud | [Issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/), [Sprint API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/) | APIs accept issue IDs or readable keys. The stable ID and human alias should both be retained. |
| Linear | [GraphQL API](https://linear.app/developers/graphql), [Webhooks](https://linear.app/developers/webhooks) | Entities have stable IDs and human identifiers such as `BLA-123`. |
| Asana | [Tasks API](https://developers.asana.com/reference/tasks), [OpenAPI repository](https://github.com/Asana/openapi) | Resources use GIDs; project and section memberships are relationships rather than identity. |
| Trello | [REST API](https://developer.atlassian.com/cloud/trello/rest/), [Object definitions](https://developer.atlassian.com/cloud/trello/guides/rest-api/object-definitions/) | Card ID and short link are more stable than board-scoped `idShort`. |
| monday.com | [API reference](https://developer.monday.com/api-reference/docs), [Create item](https://developer.monday.com/api-reference/docs/create-item) | The GraphQL API exposes boards, groups, items, subitems, columns, and updates as distinct resources. |
| Notion | [API reference](https://developers.notion.com/reference/intro), [Database reference](https://developers.notion.com/reference/database) | Pages, blocks, comments, users, databases, and data sources have UUID-based identities. Database rows are pages. |

## Cross-provider design conclusions

### Preserve compound identity

A provider-local ID is rarely sufficient by itself. Canonical references include provider authority and required containers such as workspace, repository, channel, chat, board, or project.

### Treat human keys as aliases

References such as `#123`, `!123`, `WEB-42`, and Trello `idShort` depend on scope and may change. Retain stable provider identity when available and keep human keys as searchable aliases.

### Prefer structured evidence

Resolution priority should normally be:

1. structured provider IDs and relationships;
2. entity mentions and callback payloads;
3. replies, thread roots, and parent relationships;
4. URLs and deep links;
5. scope-local reference syntax;
6. user-defined aliases and resolvers;
7. optional agent proposals.

### Separate recognition from authority

Recognizing a reference does not grant permission to read it, materialize it into context, link it to a WorkThread, or mutate it. Each step has a separate decision and trace.

### Preserve raw provider semantics

Normalized records retain native payloads and extension fields so integrations can expose provider features that are not yet standardized by OpenMatter.
