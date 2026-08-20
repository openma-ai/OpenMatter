# `@openmatter/fastify`

Fastify component for provider-neutral OpenMatter HTTP endpoints.

```ts
import Fastify from "fastify";
import { openMatter } from "@openmatter/fastify";

const server = Fastify();
await server.register(openMatter({ endpoints }));
await server.listen({ port: 3000 });
```

The plugin is encapsulated. It captures exact request bytes for provider
signature verification and converts the endpoint's Web-standard `Response`
back to Fastify without owning server startup or shutdown.
