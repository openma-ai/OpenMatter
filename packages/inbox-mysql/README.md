# `@openma/matter-inbox-mysql`

MySQL (or MariaDB 10.6+) adapter for `@openma/matter/inbox`, for hosts that run
as several stateless replicas over one database.

```ts
import { makeMysqlInbox } from "@openma/matter-inbox-mysql";

const inbox = makeMysqlInbox({
  url: process.env.DATABASE_URL!, // or `pool`, shared with other adapters
  tenantId: "connection-1", // one partition per inbox
});
```

Every replica may enqueue every delivery: the idempotency key is unique per
partition, so a delivery is stored once. A claim takes rows with
`SELECT … FOR UPDATE SKIP LOCKED` inside a transaction, so two replicas never
lease the same item, and lease expiry uses the database clock, so replica
clocks do not matter. An item whose lease expires (its replica died) is
claimed again by another replica. Completed rows are kept for deduplication.

The table is `openmatter_inbox`, created on first use, and holds every
partition. Pass `pool` to share a pool with other adapters (the caller ends
it); with `url` the inbox owns its pool and `close` ends it.
