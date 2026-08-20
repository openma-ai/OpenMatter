# Project structure

OpenMatter begins with five physical packages and two executable examples. The
package split follows runtime responsibility rather than provider or product.

```text
OpenMatter
├── packages
│   ├── core          portable contracts and ports
│   ├── openapi       executable HTTP operation plans
│   ├── runtime       Effect-based orchestration
│   ├── agent-openma  bridge to the OpenMA Agent Contract
│   └── testing       Memory Store and Mock Work Adapter
└── examples
    ├── basic         one event, reaction plan, and mock operation
    └── deployment-shapes
                      Node embedded and Cloudflare-like composition
```

## Dependency direction

```text
@openmatter/openapi ───────┐
@openmatter/runtime ───────┼──→ @openmatter/core
@openmatter/testing ───────┤
@openmatter/agent-openma ──┘
             ⋮ structurally bridges
@openma/common Agent Contract
```

`core` has no dependency on Effect, ACP, React, a database, or a provider SDK.
`runtime` uses Effect internally but returns Promise and ordinary TypeScript
values. `agent-openma` is structurally compatible with the vendor-neutral
connector being prepared in `openma-common`; it does not implement ACP again.

`deployment-shapes` is executable documentation, not a deployment framework.
It composes the same Runtime with either a long-lived Node host or request,
timer, and queue callbacks shaped like a serverless platform.

## Package ownership

| Package | Owns | Does not own |
| --- | --- | --- |
| `core` | WorkEvent, qualified references, ReactionDecision, operations, AgentDriver, Storage and Work Adapter ports | Execution, transport, persistence implementation |
| `openapi` | Self-contained HTTP execution plans and request construction | Credentials, trusted hosts, policy |
| `runtime` | Event claim, decision, Reaction commit, orchestration | Agent reasoning, provider wire formats |
| `agent-openma` | OpenMA connector to AgentDriver lifecycle mapping | ACP implementation or UI projection |
| `testing` | Deterministic in-memory Store and controllable Work Adapter | Production durability guarantees |

## Storage boundary

The Store is behavior-oriented. It claims an event with a lease and commits the
unique ReactionDecision together with outbound operation intents. The Memory
Store implements the same interface for tests and examples. Production SQL,
Durable Object, or event-log adapters can implement the port without copying a
repository-shaped database model. Operations are claimed by exact `callId`
through a lease and fencing token; there is no required pending scan. An expired
worker cannot commit a late result after a replacement worker takes ownership.

## Dependency policy

- Node.js 24 LTS is the runtime baseline.
- TypeScript, Vitest, and pnpm track their current stable releases.
- Effect tracks the latest stable 3.x release; beta majors are not production
  baselines.
- The lockfile is committed and pnpm supply-chain age checks remain enabled.

Run the complete verification suite with:

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm --filter @openmatter/example-basic start
```
