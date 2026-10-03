# Projects worker

`@openmatter/project-worker` is the cloud Projects service. Backchat and a
future web app talk to it over HTTP. OpenMA stays the execution substrate:
the worker calls the public Sessions API with the caller's API key and
`x-active-tenant`. It does not add project tables to OpenMA.

One process serves every tenant. Storage queries and remote calls carry the
tenant from `x-active-tenant`. Project ids are unique inside a tenant.

## Run next to a self-hosted OpenMA

```sh
pnpm install
pnpm build:projects
export PROJECT_WORKER_OPENMA_URL=https://oma.example
export PROJECT_WORKER_CREDENTIAL_KEY="$(openssl rand -base64 32)"
export PROJECT_WORKER_STORE=mysql
export PROJECT_WORKER_MYSQL_URL=mysql://openmatter:openmatter@127.0.0.1:3306/openmatter_projects
export PROJECT_WORKER_GITHUB_TOKEN=github_pat_...
export PROJECT_WORKER_LISTEN=127.0.0.1:8788
node packages/project-worker/dist/index.js
```

Put TLS in front of the listener. Backchat rejects remote worker URLs that are
not HTTPS. `127.0.0.1` is allowed over HTTP for local development.

SQLite is the same code path with `PROJECT_WORKER_STORE=sqlite` (the default)
and `PROJECT_WORKER_DATA_DIR`. Use it for a single machine. Hosted and
multi-tenant deployments use MySQL, which is what self-hosted OpenMA already
runs.

`deploy/project-worker/` has a compose file and a container image that build
this package beside MySQL. Point `PROJECT_WORKER_OPENMA_URL` at the OpenMA
process. Do not commit hosted production secrets into this repo.

## Current backchat handshake

Backchat `ProjectCloudRouter` calls `GET /info` with no API key and no
`x-active-tenant`, then requires `workspaceId` and `openmaUrl` to match the
saved OpenMA workspace.

Set `PROJECT_WORKER_WORKSPACE_ID` to that workspace. Unauthenticated
`GET /info` then returns:

```json
{ "workspaceId": "ws_...", "openmaUrl": "https://oma.example" }
```

Requests whose `x-active-tenant` is a different workspace are rejected. This
is the compatibility mode until backchat sends a tenant on `/info`.

## Multi-tenant handshake

Leave `PROJECT_WORKER_WORKSPACE_ID` unset.

- `GET /info` with no tenant returns `{ "multiTenant": true, "openmaUrl" }`
  and no `workspaceId`. Current backchat will refuse to bind, which is safer
  than attaching every workspace to one id.
- `GET /info` with `authorization: Bearer <apiKey>` and `x-active-tenant`
  returns `{ "multiTenant": true, "workspaceId", "openmaUrl" }` after the key
  is checked against OpenMA.

Every other route requires both headers. The worker calls
`GET /v1/oma/me` with `x-api-key` and `x-active-tenant`. A key that does not
belong to that tenant is `401`. Successful checks are cached for about a
minute. The API key is encrypted with `PROJECT_WORKER_CREDENTIAL_KEY` in the
credential table, not inside the project record, so a restarted worker can
keep calling OpenMA.

## HTTP contract

`/projects/*` uses `authorization: Bearer <apiKey>`, `x-active-tenant`, and
JSON. Errors are `{ "error": string }`. Successful responses are JSON.

| Method | Path                     | Body                   | Response                                |
| ------ | ------------------------ | ---------------------- | --------------------------------------- |
| GET    | `/info`                  | none                   | handshake above                         |
| GET    | `/projects?cursor&limit` | none                   | `{ data, nextCursor }`                  |
| GET    | `/projects/:id`          | none                   | `ProjectWorkView` plus `remoteSessions` |
| PUT    | `/projects/:id`          | `{ project, config }`  | saved `ProjectWorkConfig`               |
| DELETE | `/projects/:id`          | none                   | `{}`                                    |
| POST   | `/projects/:id/commands` | `ProjectWorkCommand`   | `{ accepted: true }`                    |
| POST   | `/projects/:id/goal`     | `ProjectWorkGoalInput` | `{ goal }`                              |

`remoteSessions` lists coordinator and worker OpenMA session ids, placement
(`cloud` or `local`), runtime status, and the thread branch. Backchat ignores
unknown fields. A web app can open the existing OpenMA session page from
`sessionId`.

Command ids are idempotent per tenant. The same id with a different body is
rejected. Pending work blocks project deletion.

## Execution

The worker runs OpenMatter's `coordinatorLoop` with an OMA session driver.

- Coordinator and worker agents come from `coordinatorAgent` and `workerAgent`,
  with `coordinatorEnvironment` and `workerEnvironment` for cloud sandboxes.
- Session create uses a stable title `openmatter:<creationKey>`. If the
  response is lost, the worker looks up that title before creating another
  session. Metadata `{ projectId, creationKey, workThreadId, role }` is
  written with `POST /v1/sessions/:id` because the public create route does
  not persist metadata itself.
- Turn input uses `POST /v1/sessions/:id/events` with `Idempotency-Key` set to
  the work event id, then reads `GET /v1/sessions/:id/events`.
- `config.repositories` creates a GitHub branch with
  `PROJECT_WORKER_GITHUB_TOKEN` and passes it as a `github_repository` session
  resource. The token is not stored on the project.

Local machines use the agent's `_oma.runtime_binding`. The worker reads
`GET /v1/agents/:id` and `GET /v1/oma/runtimes`. An offline runtime fails the
thread with an explicit error and does not switch that thread to a cloud
environment. `GET /v1/oma/runtimes` is a user-auth route in OpenMA today; if
an API key cannot read it, the worker records runtime status `unverified` and
still submits the session to the bound agent. It does not invent a second
local execution protocol. Node self-host (`apps/main-node`) does not mount
the runtime routes; that gap stays in OpenMA.

The public Sessions API cannot attach an ad-hoc MCP server. Project controls
are still available as worker commands and through `makeProjectMcpServer`.
Point the coordinator agent's `mcp_servers` at a deployment that exposes that
server if the model should call delegate, steer, cancel, and complete itself.

## Usage hook

`PROJECT_WORKER_TOKEN_QUOTA` is optional. Reported turn tokens are stored per
tenant, project, and turn. At the quota, later turns are refused with a quota
error and no new session is created. Replace this hook in the deployment to
connect billing. The worker does not charge anyone.

## Recovery

Commands live in the catalog with a lease. A restart claims expired leases,
reuses the stored OpenMA session id, and posts input again under the same
idempotency key. Repeating a `commandId` does not enqueue a second copy.

## Tests

```sh
pnpm test
PROJECT_WORKER_MYSQL_URL=mysql://openmatter:openmatter@127.0.0.1:3306/openmatter_projects pnpm exec vitest run packages/store-mysql packages/project-worker
```

Without `PROJECT_WORKER_MYSQL_URL`, MySQL cases skip and say why. SQLite
covers the same worker routes.
