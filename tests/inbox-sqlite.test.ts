import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeSqliteInbox } from "../packages/inbox-sqlite/src/index.js";

const item = {
  id: "slack:envelope-1",
  idempotencyKey: "slack:envelope-1",
  integrationId: "slack",
  eventType: "events_api",
  body: { type: "event_callback", event_id: "Ev01" },
  receivedAt: "2026-08-20T10:00:00.000Z",
} as const;

describe("SQLite durable inbox", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("claims an envelope after the process reopens the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatter-inbox-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "inbox.sqlite");
    const first = makeSqliteInbox({ filename });

    expect(await Effect.runPromise(first.enqueue(item))).toBe("stored");
    await Effect.runPromise(first.close);

    const second = makeSqliteInbox({
      filename,
      makeLeaseToken: () => "lease-restart",
    });
    const claims = await Effect.runPromise(
      second.claim({ ownerId: "runtime-2", durationMs: 60_000, limit: 10 }),
    );

    expect(claims).toEqual([
      {
        item,
        attempt: 1,
        lease: {
          token: "lease-restart",
          ownerId: "runtime-2",
          expiresAt: expect.any(String),
        },
      },
    ]);
    await Effect.runPromise(second.complete(item.id, claims[0]!.lease.token));
    expect(
      await Effect.runPromise(
        second.enqueue({
          ...item,
          receivedAt: "2026-08-20T10:00:05.000Z",
        }),
      ),
    ).toBe("duplicate");
    expect(
      await Effect.runPromise(
        second.claim({ ownerId: "runtime-2", durationMs: 60_000, limit: 10 }),
      ),
    ).toEqual([]);
    await Effect.runPromise(second.close);
  });

  it("fences a stale claim after scheduling a retry", async () => {
    let token = 0;
    const inbox = makeSqliteInbox({
      filename: ":memory:",
      makeLeaseToken: () => `lease-${++token}`,
    });
    await Effect.runPromise(inbox.enqueue(item));
    const first = (
      await Effect.runPromise(
        inbox.claim({ ownerId: "runtime-1", durationMs: 60_000, limit: 1 }),
      )
    )[0]!;
    await Effect.runPromise(
      inbox.retry(item.id, first.lease.token, {
        delayMs: 0,
        error: "Session busy",
      }),
    );
    const second = (
      await Effect.runPromise(
        inbox.claim({ ownerId: "runtime-2", durationMs: 60_000, limit: 1 }),
      )
    )[0]!;

    expect(second.attempt).toBe(2);
    expect(second.lease.token).toBe("lease-2");
    expect(
      await Effect.runPromise(
        Effect.flip(inbox.complete(item.id, first.lease.token)),
      ),
    ).toMatchObject({ _tag: "InboxError" });
    await Effect.runPromise(inbox.complete(item.id, second.lease.token));
    await Effect.runPromise(inbox.close);
  });

  it("allows only one SQLite connection to claim an envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatter-inbox-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "inbox.sqlite");
    const first = makeSqliteInbox({
      filename,
      makeLeaseToken: () => "lease-first",
    });
    const second = makeSqliteInbox({
      filename,
      makeLeaseToken: () => "lease-second",
    });
    await Effect.runPromise(first.enqueue(item));

    const claims = await Promise.all([
      Effect.runPromise(
        first.claim({ ownerId: "runtime-1", durationMs: 60_000, limit: 1 }),
      ),
      Effect.runPromise(
        second.claim({ ownerId: "runtime-2", durationMs: 60_000, limit: 1 }),
      ),
    ]);

    expect(claims.flat()).toHaveLength(1);
    await Effect.runPromise(first.close);
    await Effect.runPromise(second.close);
  });

  it("rejects an idempotency collision with different immutable data", async () => {
    const inbox = makeSqliteInbox({ filename: ":memory:" });
    await Effect.runPromise(inbox.enqueue(item));

    expect(
      await Effect.runPromise(
        Effect.flip(
          inbox.enqueue({
            ...item,
            body: { type: "event_callback", event_id: "EvChanged" },
          }),
        ),
      ),
    ).toMatchObject({ _tag: "InboxError" });
    await Effect.runPromise(inbox.close);
  });
});
