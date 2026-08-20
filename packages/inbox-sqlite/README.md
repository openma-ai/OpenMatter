# `@openmatter/inbox-sqlite`

Embedded Node.js adapter for `@openmatter/inbox`, implemented with the built-in
`node:sqlite` module. It is intended for a single-machine service, laptop,
private server, or container with a persistent volume.

```ts
import { makeSqliteInbox } from "@openmatter/inbox-sqlite";

const inbox = makeSqliteInbox({
  filename: "./data/openmatter-inbox.sqlite",
});
```

The adapter uses SQLite transactions, WAL, full synchronous commits, the
database clock, retained completed rows for deduplication, and fenced leases.
Use a real filesystem path on a persistent volume; `:memory:` is for tests.
The application owns the adapter lifecycle and should run `inbox.close` after
its host has stopped.
