# Project structure

| Field            | Value                                 |
| ---------------- | ------------------------------------- |
| Status           | Executable canonical v0 foundation    |
| Runtime baseline | Node.js 22.5+, TypeScript 6, Effect 3 |

The package split follows runtime responsibility rather than provider or
product. Only two packages are published to npm (see [Releasing](RELEASING.md));
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
├── gitlab               @openma/matter-gitlab — ./bond: GitLab Bond provider
│
│   private (not published)
├── store-memory         process-local Store reference adapter
├── store-sqlite         embedded Node Store adapter
├── store-mysql          MySQL Store adapter for hosted Projects
├── inbox-sqlite         embedded Node durable-inbox adapter
├── integration-mock     executable work-platform reference adapter
├── integration-slack    Slack events, operations and signed HTTP decoder
├── integration-github   GitHub App events, Context, Effects and HTTP decoder
├── integration-linear   Linear events, Context, Effects and HTTP decoder
├── agent-mock           executable Agent Driver reference adapter
├── orchestration        built-in application-level Loops (coordinator, Claude tag, Linear)
├── project              project commands, controls and WorkIntegration
├── project-host         local project composition: config, inbox and coordinator
├── project-mcp          MCP binding for project controls and thread goals
├── project-worker       multi-tenant cloud Projects HTTP service
├── host-cloudflare      Worker HTTP ingress and Queue consumer binding
├── host-local           Node Slack Socket Mode lifecycle binding
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
runtime ───→ store + integration + agent + core
http       (no dependencies)
```

Everything else depends on `@openma/matter`:

```text
gitlab ──────────→ matter/bond
store-* / inbox-sqlite / *-mock → matter
integration-slack / integration-github / integration-linear → matter
orchestration ───→ matter/runtime
project ─────────→ matter + orchestration
project-host ────→ project + store-sqlite + inbox-sqlite + matter
project-mcp ─────→ project + project-host
host-cloudflare ─→ matter/runtime + integration-slack
host-local ──────→ matter/runtime + matter/inbox + Slack Socket Mode SDK
fastify / hono ──→ matter/http
```

All canonical packages share Effect as a peer dependency so Context tags, Fibers, Streams, and error channels come from the application's one Effect runtime. Provider SDKs, ACP clients, databases, queues, and cloud runtimes remain adapter dependencies.

## Storage boundary

The canonical Store is behavior-oriented. It owns authoritative lease time, fencing, immutable snapshots, insert-once decisions, terminal Reactions, effect intents, and delivery receipts. The Memory Store implements the same behavior for tests but is not a production durability claim.

`DurableInbox` is a separate transport boundary. It persists provider-native
envelopes before an early ACK and replays them into the Runtime. Keeping it
separate prevents Slack/queue receipt state from leaking into domain storage.

## Verification

```bash
pnpm install
pnpm check
```

The root check formats the active foundation, runs its tests, type-checks every package/example, and produces neutral ESM builds for all workspace projects.
