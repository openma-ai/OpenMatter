import { Effect, Either } from "effect";
import type { DurableInbox, InboxItem } from "./index.js";

/**
 * One conformance case. Framework-neutral: run each `run()` inside your test
 * runner. A case throws on failure.
 */
export interface InboxConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface InboxConformanceOptions {
  /** Returns a fresh, empty inbox for each case. */
  readonly makeInbox: () => DurableInbox | Promise<DurableInbox>;
  /**
   * Lease lifetime used by expiry cases. The suite waits slightly longer, so
   * the inbox's own clock decides expiry. Default 60 ms.
   */
  readonly shortLeaseMs?: number;
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`DurableInbox conformance: ${message}`);
};
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const fails = async (effect: Effect.Effect<unknown, unknown>) =>
  Either.isLeft(await Effect.runPromise(Effect.either(effect)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG = 60_000;

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  idempotencyKey: `conformance:${id}`,
  integrationId: "conformance",
  eventType: "message.received",
  body: { text: id },
  receivedAt: "2026-08-20T10:00:00.000Z",
  ...over,
});

/**
 * The delivery contract every DurableInbox adapter must meet, written against
 * the port only. Run it against the real adapter and database. Expiry cases
 * use real time, so adapters keep their authoritative clock.
 */
export const inboxConformanceCases = (
  options: InboxConformanceOptions,
): readonly InboxConformanceCase[] => {
  const short = options.shortLeaseMs ?? 60;
  const expire = () => sleep(short * 2 + 20);
  const fresh = () => Promise.resolve(options.makeInbox());
  const claim = (inbox: DurableInbox, ownerId: string, durationMs = LONG) =>
    run(inbox.claim({ ownerId, durationMs, limit: 10 }));

  return [
    {
      name: "an item is stored once per idempotency key and completed once",
      run: async () => {
        const inbox = await fresh();
        const a = item("item-once");
        assert(
          (await run(inbox.enqueue(a))) === "stored",
          "first enqueue is stored",
        );
        assert(
          (await run(
            inbox.enqueue({ ...a, receivedAt: "2026-08-20T10:00:05.000Z" }),
          )) === "duplicate",
          "a redelivery with the same data is a duplicate",
        );
        const claims = await claim(inbox, "w1");
        assert(
          claims.length === 1 &&
            claims[0]!.item.id === a.id &&
            claims[0]!.attempt === 1 &&
            claims[0]!.lease.ownerId === "w1",
          "one claim with attempt 1",
        );
        await run(inbox.complete(a.id, claims[0]!.lease.token));
        assert(
          (await run(inbox.enqueue(a))) === "duplicate",
          "a completed item stays a duplicate",
        );
        assert(
          (await claim(inbox, "w2")).length === 0,
          "a completed item is not claimed",
        );
      },
    },
    {
      name: "an idempotency key reused with different data is rejected",
      run: async () => {
        const inbox = await fresh();
        await run(inbox.enqueue(item("item-collision")));
        assert(
          await fails(
            inbox.enqueue(
              item("item-collision", { body: { text: "changed" } }),
            ),
          ),
          "different immutable data under the same key fails",
        );
      },
    },
    {
      name: "a live claim is exclusive and an expired one is reclaimed with a fenced token",
      run: async () => {
        const inbox = await fresh();
        const a = item("item-expiry");
        await run(inbox.enqueue(a));
        const first = await claim(inbox, "w1", short);
        assert(first.length === 1, "first claim succeeds");
        assert(
          (await claim(inbox, "w2")).length === 0,
          "a live claim is exclusive",
        );
        await expire();
        const second = await claim(inbox, "w2");
        assert(
          second.length === 1 &&
            second[0]!.attempt === 2 &&
            second[0]!.lease.token !== first[0]!.lease.token,
          "an expired claim is reclaimed as attempt 2 with a new token",
        );
        assert(
          await fails(inbox.complete(a.id, first[0]!.lease.token)),
          "a stale token cannot complete",
        );
        assert(
          await fails(
            inbox.renew(a.id, first[0]!.lease.token, { durationMs: LONG }),
          ),
          "a stale token cannot renew",
        );
        await run(inbox.complete(a.id, second[0]!.lease.token));
      },
    },
    {
      name: "a retry releases the item after its delay and fences the old token",
      run: async () => {
        const inbox = await fresh();
        const a = item("item-retry");
        await run(inbox.enqueue(a));
        const first = await claim(inbox, "w1");
        await run(
          inbox.retry(a.id, first[0]!.lease.token, {
            delayMs: short,
            error: "Session busy",
          }),
        );
        assert(
          (await claim(inbox, "w2")).length === 0,
          "a delayed retry is not claimable yet",
        );
        await expire();
        const second = await claim(inbox, "w2");
        assert(
          second.length === 1 && second[0]!.attempt === 2,
          "the retried item is claimed as attempt 2",
        );
        assert(
          await fails(inbox.complete(a.id, first[0]!.lease.token)),
          "the pre-retry token cannot complete",
        );
        await run(inbox.complete(a.id, second[0]!.lease.token));
      },
    },
    {
      name: "renewing a claim keeps it from being reclaimed",
      run: async () => {
        const inbox = await fresh();
        const a = item("item-renew");
        await run(inbox.enqueue(a));
        const first = await claim(inbox, "w1", short);
        await run(
          inbox.renew(a.id, first[0]!.lease.token, { durationMs: LONG }),
        );
        await expire();
        assert(
          (await claim(inbox, "w2")).length === 0,
          "a renewed claim is still exclusive",
        );
        await run(inbox.complete(a.id, first[0]!.lease.token));
      },
    },
    {
      name: "claim honours the limit",
      run: async () => {
        const inbox = await fresh();
        for (const id of ["item-l1", "item-l2", "item-l3"]) {
          await run(inbox.enqueue(item(id)));
        }
        const two = await run(
          inbox.claim({ ownerId: "w1", durationMs: LONG, limit: 2 }),
        );
        assert(two.length === 2, "at most `limit` items are claimed");
        const rest = await claim(inbox, "w2");
        assert(
          rest.length === 1 && !two.some((c) => c.item.id === rest[0]!.item.id),
          "the remaining item goes to the next worker",
        );
      },
    },
  ];
};
