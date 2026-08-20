# `@openmatter/hono`

Hono component for provider-neutral OpenMatter HTTP endpoints.

```ts
import { Hono } from "hono";
import { openMatter } from "@openmatter/hono";

const server = new Hono().route("/", openMatter({ endpoints }));
```

Hono exposes the untouched Web-standard `Request`, so the component passes it
directly to each endpoint and returns its `Response` unchanged. The host owns
deployment and lifecycle.
