# Project structure

| Field            | Value                                 |
| ---------------- | ------------------------------------- |
| Status           | Executable canonical v0 foundation    |
| Runtime baseline | Node.js 22.5+, TypeScript 6, Effect 3 |

The package split follows runtime responsibility rather than provider or
product. The kernel, the Loop guest SDK, and the provider packages that have an
outside consumer are published to npm (see [Releasing](RELEASING.md));
every other workspace package is `private` until it has a consumer outside this
repository.

```text
packages/
├── matter               @openma/matter — the kernel, one subpath per port
│   ├── src/index.ts         .              immutable portable domain Schemas
│   ├── src/credentials      ./credentials  authority-scoped live credential resolver port
│   ├── src/bond             ./bond         Bond kernel: links, grants, principals, token custody
│   ├── src/store            ./store        durable claims, snapshots, outbox and fencing port
│   ├── src/inbox            ./inbox        durable native-ingress claim and fencing port
│   ├── src/integration      ./integration  work-platform ingress/egress port
│   ├── src/agent            ./agent        AgentDriver port, OpenMAEvent stream, and the
│   │                                       OpenMA connector → AgentDriver bridge
│   ├── src/runtime          ./runtime      Effect orchestration and Promise facades
│   └── src/http             ./http         provider-neutral portable HTTP endpoint
├── loop                 @openma/matter-loop — dependency-free guest SDK for Loops run in an isolate
├── gitlab               @openma/matter-gitlab — ./bond: GitLab Bond provider, webhook
│                        ingest, note Effects, HTTP decoder, and Loop templates
├── feishu               @openma/matter-feishu — ./bond: Feishu/Lark Bond provider for
│                        self-built apps, device and OAuth user links, chat catalog,
│                        encrypted webhook decoder, and event normalization;
│                        ./long-connection: Node long-connection source
│
│   One package per provider, @openma/matter-<provider>. ./bond holds the
│   Binding and the Integration; the Integration depends only on the
│   credentials port. Private until published:
├── slack                ./bond: Slack events, operations and signed HTTP decoder
├── github               ./bond: GitHub App events, Context, Effects and HTTP decoder
├── linear               ./bond: Linear events, Context, Effects and HTTP decoder
│
│   private (not published)
├── store-memory         process-local Store reference adapter
├── store-sqlite         embedded Node Store adapter
├── store-mysql          MySQL Store adapter for hosted Projects
├── inbox-sqlite         embedded Node durable-inbox adapter
├── integration-mock     executable work-platform reference adapter
├── agent-mock           executable Agent Driver reference adapter
├── orchestration        built-in application-level Loops (coordinator, Claude tag, Linear)
├── project              project commands, controls and WorkIntegration
├── project-host         local project composition: config, inbox and coordinator
├── project-mcp          MCP binding for project controls and thread goals
├── project-worker       multi-tenant cloud Projects HTTP service
├── host-cloudflare      Worker HTTP ingress and Queue consumer binding
├── host-local           Node long-connection host; Slack Socket Mode adapter
├── fastify              Fastify endpoint component
└── hono                 Hono endpoint component
```

`@openma/matter/runtime` exposes one application model: `createOpenMatter()`. The repository is still pre-v1, so competing prototypes are removed instead of preserved as public compatibility debt.

Inside `@openma/matter` the subpaths import each other by relative path, so a
bundler or Node resolves one copy of every Context tag and error class.

## Dependency direction

Inside the kernel:

```text
bond ──────→ credentials
agent ─────→ core + @openma/common/agent-contract
store ─────→ agent + core
inbox / integration → core
runtime ───→ store + integration + agent + core + @openma/matter-loop
http       (no dependencies)
```

`@openma/matter-loop` depends on nothing, not even Effect, because Loop code
bundled into an isolate should carry only itself. `/runtime` adapts its
Promise protocol to the Effect `WorkContext`.

Everything else depends on `@openma/matter`:

```text
gitlab ──────────→ matter + @openma/matter-loop (templates)
store-* / inbox-sqlite / *-mock → matter
slack / github / linear → matter
orchestration ───→ matter/runtime
project ─────────→ matter + orchestration
project-host ────→ project + store-sqlite + inbox-sqlite + matter
project-mcp ─────→ project + project-host
host-cloudflare ─→ matter/runtime + slack/bond
host-local ──────→ matter/runtime + matter/inbox (+ Slack Socket Mode SDK for the adapter)
fastify / hono ──→ matter/http
```

All canonical packages except `@openma/matter-loop` share Effect as a peer dependency so Context tags, Fibers, Streams, and error channels come from the application's one Effect runtime. Provider SDKs, ACP clients, databases, queues, and cloud runtimes remain adapter dependencies.

## Storage boundary

The canonical Store is behavior-oriented. It owns authoritative lease time, fencing, immutable snapshots, insert-once decisions, terminal Reactions, effect intents, and delivery receipts. The Memory Store implements the same behavior for tests but is not a production durability claim.

`DurableInbox` is a separate transport boundary. It persists provider-native
envelopes before an early ACK and replays them into the Runtime. Keeping it
separate prevents Slack/queue receipt state from leaking into domain storage.

Both contracts ship framework-neutral conformance suites, so a host that
writes its own adapter, such as one over its existing database, proves the
same behavior as the bundled ones. `storeConformanceCases({ makeStore })`
from `@openma/matter/store` covers exclusive event leases, expired-lease
takeover with stale-token fencing, one terminal Reaction per event, effect
intents claimed until delivered, Session binding handover, and Session-fenced
Turn and Agent event writes where a terminal event wins.
`inboxConformanceCases({ makeInbox })` from `@openma/matter/inbox` covers
idempotent enqueue and key collisions, exclusive and expiring claims, retry
delays, renewal, fencing, and claim limits. Each returns cases that throw on
failure; run them in your own test runner against the real database. Expiry
cases use real time, so the adapter's own clock decides. The memory, SQLite,
and MySQL Stores and the SQLite inbox run them in this repository.

## Verification

```bash
pnpm install
pnpm check
```

The root check formats the active foundation, runs its tests, type-checks every package/example, and produces neutral ESM builds for all workspace projects.
