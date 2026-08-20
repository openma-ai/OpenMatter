# HTTP framework components

OpenMatter framework components solve only the final transport step:

```text
Integration or application
  └─ HttpEndpoint (Request → Response)
       ├─ @openmatter/fastify
       └─ @openmatter/hono
```

`@openmatter/http` is deliberately smaller than a server abstraction. Its
`HttpEndpoint` contains a method, a path, and a Web-standard handler. The
endpoint owner decides how to verify a provider request, decode its payload,
submit durable work, and acknowledge the provider. Fastify and Hono do not know
about Slack, Agent sessions, ContextProjection, or orchestration.

## Fastify

```ts
import Fastify from "fastify";
import { openMatter } from "@openmatter/fastify";
import type { HttpEndpoint } from "@openmatter/http";

const endpoint: HttpEndpoint = {
  method: "POST",
  path: "/work/events",
  handle: async (request) => {
    const nativeInput: unknown = await request.json();
    await application.acceptFrom("work", nativeInput);
    return new Response(null, { status: 202 });
  },
};

const server = Fastify();
await server.register(openMatter({ endpoints: [endpoint] }));
await server.listen({ port: 3000 });
```

The plugin installs an encapsulated raw-body parser so an Integration can
verify the exact bytes delivered by its provider. It does not call `listen()`
or close the server.

## Hono

```ts
import { Hono } from "hono";
import { openMatter } from "@openmatter/hono";

const server = new Hono().route("/", openMatter({ endpoints: [endpoint] }));
```

Hono already exposes an untouched Web `Request`, which is forwarded directly.
The endpoint's `Response` is returned unchanged.

## Slack composition

`@openmatter/integration-slack` owns Slack's signature and acknowledgement
semantics and exposes them as the same portable endpoint:

```ts
import Fastify from "fastify";
import { openMatter } from "@openmatter/fastify";
import { makeSlackHttpEndpoint } from "@openmatter/integration-slack";

const slack = makeSlackHttpEndpoint({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  submit: (input) => application.acceptFrom("slack", input),
});

const server = Fastify();
await server.register(openMatter({ endpoints: [slack] }));
await server.listen({ port: 3000 });
```

The same endpoint can be mounted by Hono. `submit` may call the application
directly for a minimal deployment or enqueue the portable native payload for
a durable consumer. The endpoint returns `503` when submission fails so Slack
can retry.

## Ingress durability

Calling `application.acceptFrom()` directly is a useful minimal or local shape,
but it ties provider acknowledgement latency to Agent execution. Production
webhooks should normally make `handle` verify and enqueue immutable native
input, return the provider acknowledgement, and call `acceptFromEffect()` from
a durable consumer. The framework component does not hide or select that
policy.
