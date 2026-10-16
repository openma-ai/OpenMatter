# GitLab Work Integration

| Field  | Value                                                        |
| ------ | ------------------------------------------------------------ |
| Status | Executable v0                                                |
| Scope  | Webhook ingress, note Effects, and the GitLab Loop templates |

`@openma/matter-gitlab/bond` turns GitLab project and group webhooks into
`WorkEvent`s and posts merge request and issue notes as Effects. It also ships
two Loop templates, `gitlab-mr-review` and `gitlab-mention`. Who acts and with
which credential is Bond's job (`@openma/matter-gitlab/bond`, docs/BONDS.md);
this package only asks a credential resolver for a token.

## Ingress

`decodeGitLabHttpRequest(request, { webhookToken, authority })` verifies and
decodes one delivery:

- `X-Gitlab-Token` is compared with the configured secret token in constant
  time. Both values are hashed with SHA-256 first, so the comparison does not
  reveal the secret's length. An empty configured token never matches.
- The delivery id is the first of `webhook-id` and `Idempotency-Key`, which
  stay the same across GitLab retries (GitLab 17.4+), and
  `X-Gitlab-Event-UUID` (GitLab 14.8+). The Event id is
  `gitlab:<authority>:<delivery id>`, so a retry is the same Event.
- `authority` is chosen by the host, for example a Bond id. It becomes the
  Event source authority and selects the credential for replies. A host that
  serves many authorities from one route looks up the token and authority for
  the request, then calls the decoder. `makeGitLabHttpEndpoint` covers the
  single-authority case.
- GitLab's newer HMAC `webhook-signature` header is not checked yet.

## Events

| Webhook       | Event types                                                                                                                | Work Thread                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Merge request | `gitlab.merge_request.{opened, reopened, updated, closed, merged, approved, unapproved, approval_added, approval_removed}` | `merge_request:<iid>`                                       |
| Note          | `gitlab.{merge_request, issue, commit, snippet}.note.{created, updated}`                                                   | the parent: `merge_request:<iid>`, `issue:<iid>`, and so on |
| Pipeline      | `gitlab.pipeline.<status>`, with GitLab's status names                                                                     | the merge request when there is one, else `pipeline:<id>`   |
| Anything else | `gitlab.event.received`                                                                                                    | none                                                        |

`source.conversationId` is the project path. The payload carries
`resource: "project:<id>"`, the same resource id the GitLab Bond catalog uses,
so a Loop can match the projects it is configured for. Merge request Events
add `newCommits`, true on open, reopen, and an update that pushed commits
(GitLab sets `oldrev` only then). Note Events add `text`, `discussionId`, and
`system`. Provider data stays in `raw`, with credential-shaped keys removed.

## Effects

| Operation                        | Input                                               | GitLab API                                                                |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `merge_request.note.create`      | `authority`, `projectId`, `mergeRequestIid`, `body` | `POST /projects/:id/merge_requests/:iid/notes`                            |
| `merge_request.discussion.reply` | the same, plus `discussionId`                       | `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes` |
| `issue.note.create`              | `authority`, `projectId`, `issueIid`, `body`        | `POST /projects/:id/issues/:iid/notes`                                    |
| `issue.discussion.reply`         | the same, plus `discussionId`                       | `POST /projects/:id/issues/:iid/discussions/:discussion_id/notes`         |

`projectId` is a numeric id or a full path. Credentials are fixed
`{ baseUrl, token }` or a resolver keyed by authority, so one integration can
serve several GitLab instances. HTTP 429 and 5xx are retryable; `Retry-After`
or `RateLimit-Reset` sets `retryAt`. Other failures are not retried.

## Templates

Both templates are guest Loops (docs/LOOPS.md, "Guest Loops"): they import only
`@openma/matter-loop` and their definitions are JSON a console renders as a form.

- `gitlab-mr-review` reviews a merge request when it opens, reopens, or gets
  new commits, and posts the review as a note. Title and label edits do not
  trigger it. Drafts are skipped unless `skipDrafts` is false.
- `gitlab-mention` answers a merge request comment that mentions the
  configured `username`, in the same discussion. System notes and the Agent's
  own notes are ignored, so a reply never triggers another reply.

Both take `agentId`, `projects` (Bond resource ids), and optional
`instructions`. Both use one Session per merge request
(`scopeId: gitlab:<authority>:project:<id>`, `workThreadId: merge_request:<iid>`),
so an Agent that reviewed a merge request remembers it when mentioned there.
The Agent reads code by fetching through the GitLab Bond.

GitLab webhooks are unattended, so both templates declare `runAs: "app"` and
`requiredBonds: [{ provider: "gitlab", operations: ["fetch", "comment_mr"] }]`.
A host enables them only when the Bond has an app principal (a GitLab bot
credential, docs/BONDS.md "GitLab bot accounts") and resolves that credential
for the Event's authority.
