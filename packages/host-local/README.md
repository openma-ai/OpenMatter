# `@openmatter/host-local`

Slack Socket Mode host component for a long-running Node.js process. It needs no
public webhook URL and uses a caller-provided `DurableInbox`:

```ts
const host = makeLocalSlackRuntime({
  appToken: process.env.SLACK_APP_TOKEN!,
  application: app,
  inbox,
});

await host.start();
```

For every native Socket Mode envelope the host validates portable data,
persists it, and only then calls Slack `ack()`. A supervised consumer claims
pending or expired items, renews their leases during long Agent Turns, and
completes or durably reschedules them. Graceful shutdown interrupts owned
Fibers and releases their items for replay.

`@openmatter/inbox-sqlite` is the embedded reference adapter. The inbox and the
domain `OpenMatterStore` are separate dependencies and both must be durable for
a crash-safe standalone deployment.
