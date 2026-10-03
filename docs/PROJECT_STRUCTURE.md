# Project structure

| Field            | Value                                 |
| ---------------- | ------------------------------------- |
| Status           | Executable canonical v0 foundation    |
| Runtime baseline | Node.js 22.5+, TypeScript 6, Effect 3 |

The canonical package split follows runtime responsibility rather than provider or product:

```text
packages/
├── core                 immutable portable domain Schemas
├── credentials          authority-scoped live credential resolver port
├── store                durable claims, snapshots, outbox and fencing port
├── store-memory         process-local Store reference adapter
├── store-sqlite         embedded Node Store adapter
├── store-mysql          MySQL Store adapter for hosted Projects
├── project              project commands, controls and WorkIntegration
├── project-host         local project composition: config, inbox and coordinator
├── project-mcp          MCP binding for project controls and thread goals
├── project-worker       multi-tenant cloud Projects HTTP service
├── inbox                durable native-ingress claim and fencing port
├── inbox-sqlite         embedded Node durable-inbox adapter
├── integration          work-platform ingress/egress port
├── integration-mock     executable work-platform reference adapter
├── integration-slack    Slack events, operations and signed HTTP decoder
├── integration-github   GitHub App events, Context, Effects and HTTP decoder
├── integration-linear   Linear events, Context, Effects and HTTP decoder
├── agent                AgentDriver and OpenMAEvent stream port
├── agent-mock           executable Agent Driver reference adapter
├── agent-claude         OpenMA common connector → Effect AgentDriver bridge
├── runtime              Effect orchestration and Promise facades
├── orchestration        built-in application-level Loops
├── host-cloudflare      Worker HTTP ingress and Queue consumer binding
├── host-local           Node Slack Socket Mode lifecycle binding
├── http                 provider-neutral portable HTTP endpoint
├── fastify              Fastify endpoint component
└── hono                 Hono endpoint component
```

`@openmatter/runtime` exposes one application model: `createOpenMatter()`. The repository is still pre-v1, so competing prototypes are removed instead of preserved as public compatibility debt.

## Dependency direction

```text
store-memory ──→ store ──┐
store-sqlite ───→ store ──┤
project ─────────→ core + inbox + integration + orchestration + runtime
project-host ────→ project + store-sqlite + inbox-sqlite + runtime
project-mcp ─────→ project + project-host
inbox-sqlite ──→ inbox ───┤
integration-mock → integration ─┼─→ core
agent-mock ─────→ agent ────────┤
agent-claude ───→ agent + @openma/common
runtime ────────→ store + integration + agent + core
integration-slack / integration-github / integration-linear
                  → integration + credentials + http + core
orchestration ───→ runtime + core
host-cloudflare ─→ runtime + integration-slack + core
host-local ──────→ runtime + inbox + Slack Socket Mode SDK
fastify / hono ──→ http
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
