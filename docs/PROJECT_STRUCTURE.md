# Project structure

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| Status           | Executable canonical v0 foundation  |
| Runtime baseline | Node.js 22+, TypeScript 6, Effect 3 |

The canonical package split follows runtime responsibility rather than provider or product:

```text
packages/
├── core                 immutable portable domain Schemas
├── store                durable claims, snapshots, outbox and fencing port
├── store-memory         process-local Store reference adapter
├── integration          work-platform ingress/egress port
├── integration-mock     executable work-platform reference adapter
├── integration-slack    Slack events, operations and signed HTTP decoder
├── agent                AgentDriver and OpenMAEvent stream port
├── agent-mock           executable Agent Driver reference adapter
├── agent-claude         OpenMA common connector → Effect AgentDriver bridge
├── runtime              Effect orchestration and Promise facades
├── orchestration        built-in application-level orchestration presets
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
integration-mock → integration ─┼─→ core
agent-mock ─────→ agent ────────┤
agent-claude ───→ agent + @openma/common
runtime ────────→ store + integration + agent + core
integration-slack → integration + core
orchestration ───→ runtime + core
host-cloudflare ─→ runtime + integration-slack + core
host-local ──────→ runtime + Slack Socket Mode SDK
fastify / hono ──→ http
```

All canonical packages share Effect as a peer dependency so Context tags, Fibers, Streams, and error channels come from the application's one Effect runtime. Provider SDKs, ACP clients, databases, queues, and cloud runtimes remain adapter dependencies.

## Storage boundary

The canonical Store is behavior-oriented. It owns authoritative lease time, fencing, immutable snapshots, insert-once decisions, terminal Reactions, effect intents, and delivery receipts. The Memory Store implements the same behavior for tests but is not a production durability claim.

## Verification

```bash
pnpm install
pnpm check
```

The root check formats the active foundation, runs its tests, type-checks every package/example, and produces neutral ESM builds for all workspace projects.
