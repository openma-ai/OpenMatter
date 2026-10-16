# `@openma/matter`

The OpenMatter kernel. One package, one subpath per port. Provider bindings,
reference adapters, and hosts live in separate packages.

| Import                       | Contents                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| `@openma/matter`             | Immutable portable domain Schemas: WorkEvent, Context, Reaction, JSON       |
| `@openma/matter/credentials` | Authority-scoped live credential resolver port                              |
| `@openma/matter/bond`        | Bond kernel: installations, user links, principals, token custody, adapters |
| `@openma/matter/store`       | Durable claims, snapshots, outbox, and fencing port                         |
| `@openma/matter/inbox`       | Durable native-ingress claim and fencing port                               |
| `@openma/matter/integration` | Work-platform ingress and egress port                                       |
| `@openma/matter/agent`       | AgentDriver port, OpenMAEvent stream, OpenMA connector bridge               |
| `@openma/matter/runtime`     | `createOpenMatter()`: Effect orchestration and Promise facades              |
| `@openma/matter/http`        | Provider-neutral portable HTTP endpoint                                     |

`effect` is a peer dependency, so Context tags, Fibers, Streams, and error
channels come from the application's one Effect runtime.

## Agent connectors

`makeConnectorAgentDriver` adapts any `OpenMAAgentConnector` from
`@openma/common/agent-contract` into the Effect `AgentDriver` port. The
connector may target Claude Managed Agents, ACP, an in-process SDK, a
subprocess, or a private runtime. OpenMatter persists only the canonical
immutable `OpenMAEvent` facts the connector emits.

```ts
import { makeConnectorAgentDriver } from "@openma/matter/agent";

const driver = makeConnectorAgentDriver({ connector, agentId: "claude-code" });
```

## HTTP endpoints

```ts
import type { HttpEndpoint } from "@openma/matter/http";

const endpoint: HttpEndpoint = {
  method: "POST",
  path: "/work/events",
  handle: async (request) => {
    await application.acceptFrom("work", await request.json());
    return new Response(null, { status: 202 });
  },
};
```

An Integration or application owns signature verification, decoding,
acknowledgement, and durable queue submission inside `handle`.

## Durable inbox

`DurableInbox` stores immutable portable envelopes for hosts that must
acknowledge a native transport before the application finishes processing it.
It claims them with expiring fenced leases and records completion or a
scheduled retry. It is separate from `OpenMatterStore`: the inbox owns
transport receipt and replay; the Store owns normalized work facts, Context,
Sessions, Reactions, and the effect outbox.

See the [repository](https://github.com/openma-ai/OpenMatter) for the
architecture documents.
