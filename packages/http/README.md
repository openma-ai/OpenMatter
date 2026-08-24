# `@openmatter/http`

Portable HTTP endpoint contract shared by OpenMatter framework components.

```ts
import type { HttpEndpoint } from "@openmatter/http";

const endpoint: HttpEndpoint = {
  method: "POST",
  path: "/work/events",
  handle: async (request) => {
    const input: unknown = await request.json();
    await application.acceptFrom("work", input);
    return new Response(null, { status: 202 });
  },
};
```

An Integration or application owns signature verification, decoding,
acknowledgement, and durable queue submission inside `handle`. This package
does not prescribe those policies and does not depend on the OpenMatter
Runtime.
