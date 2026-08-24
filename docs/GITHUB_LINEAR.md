# GitHub and Linear Work Integrations

| Field  | Value                                                    |
| ------ | -------------------------------------------------------- |
| Status | Executable v0                                            |
| Scope  | Signed ingress, Context readers, credentials and Effects |

`@openmatter/integration-github` and `@openmatter/integration-linear` are
full Work Integrations. They normalize provider input into the same immutable
`WorkEvent` envelope used by Slack and expose provider reads and writes through
the same Context and WorkEffect boundaries.

They do not decide whether an event should invoke an Agent. Mention rules,
labels, assignments, self-event suppression, Scope and WorkThread association,
Session reuse, Context projection, grants, and proactive polling remain Loop or
host policy.

## Standard event shape

Both packages preserve the provider-qualified event name while sharing the
portable envelope:

```ts
interface WorkEvent {
  schemaVersion: string;
  id: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  idempotencyKey: string;
  source: {
    provider: "github" | "linear";
    authority: string;
    conversationId?: string;
    threadId?: string;
    messageId?: string;
    uri?: string;
  };
  payload?: JsonValue;
  raw?: JsonValue;
}
```

Known event payloads include `activation`, `action`, `resourceType`, stable
`resourceId`, optional human `resourceKey`, and a bounded actor summary.
`resourceKey` always aliases that same resource; comment, review, document, and
provider-session events use `parentResourceType`, `parentResourceId`, and
`parentResourceKey` when their work-item parent is known.
Provider-native data remains under recursively redacted `raw`; credentials and
bearer capabilities never enter the Event, Context, Agent input, or receipt.
Unknown provider event families produce a generic observation instead of being
mistaken for an Agent activation.

## GitHub

GitHub ingress verifies `X-Hub-Signature-256` against the exact request body and
uses `X-GitHub-Delivery` as delivery identity. `installation.id` is the
credential authority; repository owner/name is Resource location, not the
security boundary.

```ts
import { makeCredentialResolver } from "@openmatter/credentials";
import {
  makeGitHubHttpEndpoint,
  makeGitHubIntegration,
} from "@openmatter/integration-github";

const github = makeGitHubIntegration({
  credentials: makeCredentialResolver(({ authority }) =>
    githubApps.installationToken(authority),
  ),
});

const endpoint = makeGitHubHttpEndpoint({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  submit: (native) => app.acceptFrom("github", native),
});
```

Context readers cover repositories, issues, issue comments, pull requests,
pull-request files and reviews, and workflow runs. Lists are explicitly paged.

The finite Effect surface covers issue comments and updates, issue/comment
reactions, pull-request reviews and review comments, merge, and workflow
dispatch. There is deliberately no arbitrary REST operation. Destructive or
high-impact operations such as merge become usable only when the Loop grants
their exact operation names.

## Linear

Linear ingress verifies `Linear-Signature` against the exact request body,
rejects stale deliveries, and uses `Linear-Delivery` as delivery identity.
`organizationId` is the credential authority. OAuth tokens use Bearer
authentication; personal API keys use Linear's raw Authorization value.

```ts
import { makeCredentialResolver } from "@openmatter/credentials";
import {
  makeLinearHttpEndpoint,
  makeLinearIntegration,
} from "@openmatter/integration-linear";

const linear = makeLinearIntegration({
  credentials: makeCredentialResolver(({ authority }) =>
    installations.linear(authority),
  ),
});

const endpoint = makeLinearHttpEndpoint({
  signingSecret: env.LINEAR_WEBHOOK_SECRET,
  submit: (native) => app.acceptFrom("linear", native),
});
```

Context readers cover issues, cursor-paged issue comments, projects, and
documents. The finite Effect surface covers issue create/update, issue comment
create/update/delete, project update, and document update. Arbitrary GraphQL is
not an Effect.

Linear `AppUserNotification`, `AgentSessionEvent`, and follow-up Comment facts
are normalized because they are useful inputs to a Loop. Their provider session
objects do not replace OpenMatter Agent Sessions.

## OpenMA capability parity

The integrations use OpenMA's deployed GitHub and Linear adapters as a
regression inventory, not as a wire contract. The following stay outside the
provider adapters:

- label, mention, assignment, review-request, and self-loop activation policy;
- per-issue or per-pull-request Agent Session continuity;
- polling schedules and proactive sweeps;
- OAuth setup pages, token refresh, vault storage, and installation lifecycle;
- MCP server selection and Agent tool injection;
- deployment routing, queues, audit storage, and UI state.

Those responsibilities compose around the standard Work Integration through a
Loop, credential resolver, Agent Driver, host, and Store.

## Delivery semantics

OpenMatter commits each WorkEffect before provider delivery and records its
receipt afterward. This closes local crash-replay gaps, but it cannot create a
provider idempotency primitive that GitHub or Linear does not expose. A crash
after a successful provider write and before receipt persistence may therefore
repeat operations such as comment or issue creation. The v0 integrations claim
durable at-least-once delivery, not provider exactly-once delivery. Loops should
grant mutation operations deliberately, and deployments that need stronger
deduplication should use provider-supported preconditions or application-level
markers.
