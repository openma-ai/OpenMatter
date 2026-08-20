# Deployment shapes

This example demonstrates host composition. It is not an OpenMatter deployment
framework and does not prescribe a database, queue, HTTP router, or scheduler.

## Embedded Node

`src/node.ts` lets the application own a `WorkEventSource` and Node timer. Both
paths decode to ordinary WorkEvents and use the `runtime.accept` convenience
composition. A production process should connect its own signal handling,
logging, and durable Store.

## Cloudflare-like serverless host

`src/cloudflare.ts` keeps the durable units separate:

```text
fetch / scheduled
  → decode native input
  → runtime.ingest
  → queue { kind: "event.process", event }
  → runtime.process
  → queue { kind: "operation.deliver", callId }
  → runtime.deliver
```

The queue and environment types are deliberately structural so the example has
no Cloudflare package dependency. In a real Worker, generate `Env` from
`wrangler.jsonc` with `wrangler types`; pass the native `ScheduledController`
shape to a `TimerAdapter`, and construct the Runtime with a durable
`OpenMatterStore` inside `createRuntime(env)`.

The queue payloads in `src/jobs.ts` are application-owned JSON examples, not a
new OpenMatter wire protocol.
