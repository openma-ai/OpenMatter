# `@openma/matter-host-local`

Long-connection host for a long-running Node.js process. It needs no public
webhook URL and uses a caller-provided `DurableInbox`.

## Generic runtime

`makeLocalLongConnectionRuntime` (also exported from
`@openma/matter-host-local/runtime`) runs any provider that delivers events
over an outbound connection. The provider supplies a `LongConnectionSource`:

```ts
const host = makeLocalLongConnectionRuntime({
  source: {
    start: async (onEnvelope) => {
      // Connect, then call onEnvelope for every provider message:
      // { integrationId, idempotencyKey, eventType, body, ack }
    },
    stop: async () => {
      // Stop delivery and disconnect.
    },
  },
  application: app,
  inbox,
});

await host.start();
```

For every envelope the host validates portable data, persists it with the
envelope's `idempotencyKey`, and only then calls `ack()`. A redelivered message
with the same key is processed once. A supervised consumer claims pending or
expired items, renews their leases during long Agent Turns, and completes or
durably reschedules them. Graceful shutdown stops accepting envelopes,
interrupts owned Fibers, and releases their items for replay.

## Slack Socket Mode

`makeLocalSlackRuntime` adapts Slack's Socket Mode client with
`socketModeSource` and runs it on the generic runtime:

```ts
const host = makeLocalSlackRuntime({
  appToken: process.env.SLACK_APP_TOKEN!,
  application: app,
  inbox,
});

await host.start();
```

`@openma/matter-inbox-sqlite` is the embedded reference adapter. The inbox and the
domain `OpenMatterStore` are separate dependencies and both must be durable for
a crash-safe standalone deployment.
