import { SessionBusyError } from "@openma/matter/runtime";
import type { OpenMatterApplication } from "@openma/matter/runtime";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeLocalLongConnectionRuntime,
  type LocalRuntimeError,
  type LongConnectionSource,
  type ReceivedEnvelope,
} from "../packages/host-local/src/runtime/index.js";
import {
  makeSqliteInbox,
  type SqliteInbox,
} from "../packages/inbox-sqlite/src/index.js";

class FakeSource implements LongConnectionSource {
  onEnvelope: ((envelope: ReceivedEnvelope) => Promise<void>) | undefined;
  stopCalls = 0;

  async start(onEnvelope: (envelope: ReceivedEnvelope) => Promise<void>) {
    this.onEnvelope = onEnvelope;
  }

  async stop() {
    this.stopCalls += 1;
    this.onEnvelope = undefined;
  }

  async deliver(
    envelope: Partial<ReceivedEnvelope> & { readonly idempotencyKey: string },
  ) {
    const onEnvelope = this.onEnvelope;
    if (onEnvelope === undefined) throw new Error("Source is not started");
    await onEnvelope({
      integrationId: "fake",
      eventType: "message",
      body: { type: "message" },
      ...envelope,
    });
  }
}

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("local long-connection runtime", () => {
  const inboxes: SqliteInbox[] = [];
  const testInbox = () => {
    const inbox = makeSqliteInbox({ filename: ":memory:" });
    inboxes.push(inbox);
    return inbox;
  };

  afterEach(async () => {
    for (const inbox of inboxes.splice(0)) {
      await Effect.runPromise(inbox.close);
    }
  });

  it("enqueues an envelope durably before acknowledging the provider", async () => {
    const order: string[] = [];
    const source = new FakeSource();
    const inner = testInbox();
    const inbox = {
      ...inner,
      enqueue: (item: Parameters<SqliteInbox["enqueue"]>[0]) =>
        inner.enqueue(item).pipe(Effect.tap(() => order.push("persisted"))),
    };
    const application = {
      acceptFromEffect: (integrationId: string, input: unknown) =>
        Effect.sync(() => {
          order.push(`processed:${integrationId}:${JSON.stringify(input)}`);
          return [];
        }),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application,
      inbox,
      recoveryIntervalMs: false,
      inboxPollIntervalMs: 1,
    });

    await runtime.start();
    await source.deliver({
      idempotencyKey: "fake:1",
      body: { text: "hi" },
      ack: async () => void order.push("acked"),
    });
    await waitFor(() => order.length === 3);
    await runtime.stop();

    expect(order).toEqual([
      "persisted",
      "acked",
      'processed:fake:{"text":"hi"}',
    ]);
  });

  it("does not acknowledge an envelope when durable enqueue fails", async () => {
    const source = new FakeSource();
    const errors: LocalRuntimeError[] = [];
    let acknowledged = false;
    const inbox = {
      ...testInbox(),
      enqueue: () => Effect.fail(new Error("disk unavailable")),
    };
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () => Effect.succeed([]),
      } as unknown as OpenMatterApplication,
      inbox: inbox as never,
      recoveryIntervalMs: false,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await source.deliver({
      idempotencyKey: "fake:1",
      ack: async () => void (acknowledged = true),
    });
    await runtime.stop();

    expect(acknowledged).toBe(false);
    expect(errors).toEqual([
      expect.objectContaining({
        phase: "ingest",
        message: "Unable to persist long connection message envelope",
      }),
    ]);
  });

  it("rejects an envelope without an idempotency key before acknowledging it", async () => {
    const source = new FakeSource();
    const errors: LocalRuntimeError[] = [];
    let acknowledged = false;
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () => Effect.succeed([]),
      } as unknown as OpenMatterApplication,
      inbox: testInbox(),
      recoveryIntervalMs: false,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await source.deliver({
      idempotencyKey: "",
      ack: async () => void (acknowledged = true),
    });
    await runtime.stop();

    expect(acknowledged).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("processes a duplicate idempotency key only once", async () => {
    const source = new FakeSource();
    let accepted = 0;
    let acknowledged = 0;
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () =>
          Effect.sync(() => {
            accepted += 1;
            return [];
          }),
      } as unknown as OpenMatterApplication,
      inbox: testInbox(),
      recoveryIntervalMs: false,
      inboxPollIntervalMs: 1,
    });

    await runtime.start();
    for (let index = 0; index < 2; index += 1) {
      await source.deliver({
        idempotencyKey: "fake:dup",
        ack: async () => void (acknowledged += 1),
      });
    }
    await waitFor(() => accepted === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.stop();

    expect(acknowledged).toBe(2);
    expect(accepted).toBe(1);
  });

  it("retries a retryable failure and then succeeds", async () => {
    const source = new FakeSource();
    const errors: LocalRuntimeError[] = [];
    let attempts = 0;
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(
                  new SessionBusyError({
                    bindingKey: "fake:scope",
                    retryAt: "2026-08-20T10:00:00.000Z",
                    message: "Session is already leased",
                  }),
                )
              : Effect.succeed([]);
          }),
      } as unknown as OpenMatterApplication,
      inbox: testInbox(),
      clock: () => Date.parse("2026-08-20T10:00:00.000Z"),
      retryDelayMs: 0,
      inboxPollIntervalMs: 1,
      recoveryIntervalMs: false,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await source.deliver({ idempotencyKey: "fake:retry" });
    await waitFor(() => attempts === 2);
    await runtime.stop();

    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("stops retrying after maxAttempts and reports every failure", async () => {
    const source = new FakeSource();
    const errors: LocalRuntimeError[] = [];
    let attempts = 0;
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(
              new SessionBusyError({
                bindingKey: "fake:scope",
                retryAt: "2026-08-20T10:00:00.000Z",
                message: "Session is already leased",
              }),
            );
          }),
      } as unknown as OpenMatterApplication,
      inbox: testInbox(),
      clock: () => Date.parse("2026-08-20T10:00:00.000Z"),
      retryDelayMs: 0,
      maxAttempts: 2,
      inboxPollIntervalMs: 1,
      recoveryIntervalMs: false,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await source.deliver({ idempotencyKey: "fake:exhausted" });
    await waitFor(() => errors.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.stop();

    expect(attempts).toBe(2);
    expect(errors).toEqual([
      expect.objectContaining({
        phase: "ingest",
        message: "Unable to process durable message envelope",
      }),
      expect.objectContaining({
        phase: "ingest",
        message: "Unable to process durable message envelope",
      }),
    ]);
  });

  it("stops the source and ignores envelopes after stop", async () => {
    const source = new FakeSource();
    const runtime = makeLocalLongConnectionRuntime({
      source,
      application: {
        acceptFromEffect: () => Effect.succeed([]),
      } as unknown as OpenMatterApplication,
      inbox: testInbox(),
      recoveryIntervalMs: false,
    });

    await runtime.start();
    const onEnvelope = source.onEnvelope;
    await runtime.stop();
    let acknowledged = false;
    await onEnvelope?.({
      integrationId: "fake",
      idempotencyKey: "fake:late",
      eventType: "message",
      body: {},
      ack: async () => void (acknowledged = true),
    });

    expect(source.stopCalls).toBe(1);
    expect(acknowledged).toBe(false);
  });
});
