import { InboxError } from "@openma/matter/inbox";
import type { OpenMatterApplication } from "@openma/matter/runtime";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  feishuDeliveryId,
  feishuEventId,
  normalizeFeishuEvents,
} from "../packages/feishu/src/bond/index.js";
import {
  makeFeishuLongConnectionSource,
  type FeishuConnectionState,
  type FeishuWsClient,
  type FeishuWsClientParams,
} from "../packages/feishu/src/long-connection/index.js";
import { makeLocalLongConnectionRuntime } from "../packages/host-local/src/runtime/index.js";
import {
  makeSqliteInbox,
  type SqliteInbox,
} from "../packages/inbox-sqlite/src/index.js";

type Invoke = (data: unknown) => Promise<unknown>;

/** Plays the SDK: hands frames to `invoke` and treats a throw as a failed ack. */
class FakeWsClient implements FeishuWsClient {
  invoke: Invoke | undefined;
  closed = 0;
  failStart = false;
  constructor(readonly params: FeishuWsClientParams) {}
  async start(p: { eventDispatcher: { invoke: Invoke } }) {
    if (this.failStart) throw new Error("connect refused");
    this.invoke = p.eventDispatcher.invoke;
    this.params.onReady();
  }
  close() {
    this.closed += 1;
  }
  /** What Feishu sees: "ok" with the response, or "retry". */
  async frame(data: unknown) {
    try {
      return { ack: "ok" as const, response: await this.invoke!(data) };
    } catch {
      return { ack: "retry" as const };
    }
  }
}

const message = (
  eventId: string,
  messageId: string,
  appId = "cli_0123456789abcdef",
) => ({
  schema: "2.0",
  header: {
    event_id: eventId,
    event_type: "im.message.receive_v1",
    create_time: "1792000000000",
    app_id: appId,
    tenant_key: "tk_test",
  },
  event: {
    sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_test",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hi" }),
      mentions: [],
    },
  },
});

const baseOptions = {
  baseUrl: "https://open.feishu.cn",
  appId: "cli_0123456789abcdef",
  appSecret: "test-secret",
  authority: "bond_fs",
  botOpenId: "ou_bot",
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("Feishu long-connection source", () => {
  it("refuses an app id the SDK would silently not connect", () => {
    expect(() =>
      makeFeishuLongConnectionSource({ ...baseOptions, appId: "cli_test_app" }),
    ).toThrow("self-built app id");
  });

  it("builds the client for the brand and reports connection state", async () => {
    const clients: FakeWsClient[] = [];
    const states: FeishuConnectionState[] = [];
    const source = makeFeishuLongConnectionSource({
      ...baseOptions,
      baseUrl: "https://accounts.larksuite.com",
      onState: (s) => states.push(s),
      createClient: (params) => {
        const c = new FakeWsClient(params);
        clients.push(c);
        return c;
      },
    });
    await source.start(async () => undefined);
    await source.start(async () => undefined);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.params).toMatchObject({
      appId: "cli_0123456789abcdef",
      appSecret: "test-secret",
      domain: "https://open.larksuite.com",
    });
    clients[0]!.params.onReconnecting();
    clients[0]!.params.onError(new Error("revoked"));
    expect(states.map((s) => s.state)).toEqual([
      "connected",
      "reconnecting",
      "failed",
    ]);
    await source.stop();
    expect(clients[0]!.closed).toBe(1);
  });

  it("hands the full envelope over with the normalizer's id, and acks only after ack", async () => {
    let client: FakeWsClient | undefined;
    const received: unknown[] = [];
    let ackIt = true;
    const source = makeFeishuLongConnectionSource({
      ...baseOptions,
      createClient: (p) => (client = new FakeWsClient(p)),
    });
    await source.start(async (envelope) => {
      received.push(envelope);
      if (ackIt) await envelope.ack();
    });
    const frame = message("ev_1", "om_1");
    expect(await client!.frame(frame)).toEqual({
      ack: "ok",
      response: undefined,
    });
    expect(received[0]).toMatchObject({
      integrationId: "feishu",
      idempotencyKey: "feishu:bond_fs:event:ev_1",
      eventType: "im.message.receive_v1",
      body: {
        kind: "feishu.event",
        authority: "bond_fs",
        transport: "long_connection",
        botOpenId: "ou_bot",
        envelope: frame,
      },
    });
    const [event] = await Effect.runPromise(
      normalizeFeishuEvents((received[0] as { body: unknown }).body),
    );
    expect(event!.id).toBe(feishuEventId("bond_fs", frame));
    expect(event!.id).toBe("feishu:bond_fs:om_1");
    expect(feishuDeliveryId("bond_fs", frame)).toBe(
      "feishu:bond_fs:event:ev_1",
    );

    ackIt = false;
    expect((await client!.frame(message("ev_2", "om_2"))).ack).toBe("retry");
  });

  it("refuses other apps, answers card actions, and acks frames it cannot use", async () => {
    let client: FakeWsClient | undefined;
    const keys: string[] = [];
    const source = makeFeishuLongConnectionSource({
      ...baseOptions,
      cardActionResponse: { toast: { type: "info", content: "Queued" } },
      createClient: (p) => (client = new FakeWsClient(p)),
    });
    await source.start(async (envelope) => {
      keys.push(envelope.idempotencyKey);
      await envelope.ack();
    });
    expect(
      (await client!.frame(message("ev_1", "om_1", "cli_other"))).ack,
    ).toBe("retry");
    expect(
      await client!.frame({
        schema: "2.0",
        header: {
          event_id: "ev_card",
          event_type: "card.action.trigger",
          app_id: "cli_0123456789abcdef",
        },
        event: { action: { tag: "button" } },
      }),
    ).toEqual({
      ack: "ok",
      response: { toast: { type: "info", content: "Queued" } },
    });
    expect(
      await client!.frame({ uuid: "u1", event: { type: "app_ticket" } }),
    ).toEqual({ ack: "ok", response: undefined });
    expect(keys).toEqual(["feishu:bond_fs:event:ev_card"]);
  });

  it("refuses events after stop and can start again after a failed start", async () => {
    const clients: FakeWsClient[] = [];
    let failNext = true;
    const source = makeFeishuLongConnectionSource({
      ...baseOptions,
      createClient: (p) => {
        const c = new FakeWsClient(p);
        c.failStart = failNext;
        failNext = false;
        clients.push(c);
        return c;
      },
    });
    const ack = async (e: { ack: () => Promise<void> }) => e.ack();
    await expect(source.start(ack)).rejects.toThrow("connect refused");
    expect(clients[0]!.closed).toBe(1);
    await source.start(ack);
    expect((await clients[1]!.frame(message("ev_1", "om_1"))).ack).toBe("ok");
    await source.stop();
    expect((await clients[1]!.frame(message("ev_2", "om_2"))).ack).toBe(
      "retry",
    );
  });
});

describe("Feishu long connection on the local runtime", () => {
  const inboxes: SqliteInbox[] = [];
  afterEach(async () => {
    for (const inbox of inboxes.splice(0)) await Effect.runPromise(inbox.close);
  });

  it("stores before acking, dedups both kinds of redelivery, and lets Feishu retry a failed write", async () => {
    let client: FakeWsClient | undefined;
    const inner = makeSqliteInbox({ filename: ":memory:" });
    inboxes.push(inner);
    let failWrites = false;
    const order: string[] = [];
    const inbox = {
      ...inner,
      enqueue: (item: Parameters<SqliteInbox["enqueue"]>[0]) =>
        failWrites
          ? Effect.fail(new InboxError({ message: "disk unavailable" }))
          : inner
              .enqueue(item)
              .pipe(Effect.tap((r) => order.push(`${r}:${item.id}`))),
    };
    // Stands in for the kernel, which claims an Event once by its id.
    const claimed = new Set<string>();
    const processed: string[] = [];
    const application = {
      acceptFromEffect: (integrationId: string, input: unknown) =>
        normalizeFeishuEvents(input).pipe(
          Effect.tap((events) =>
            Effect.sync(() => {
              for (const e of events) {
                if (claimed.has(e.id)) continue;
                claimed.add(e.id);
                processed.push(`${integrationId}:${e.id}`);
              }
            }),
          ),
        ),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalLongConnectionRuntime({
      source: makeFeishuLongConnectionSource({
        ...baseOptions,
        createClient: (p) => (client = new FakeWsClient(p)),
      }),
      application,
      inbox,
      recoveryIntervalMs: false,
      inboxPollIntervalMs: 1,
      envelopeLabel: "Feishu",
      connectionLabel: "Feishu long connection",
      onError: () => undefined,
    });
    await runtime.start();

    const first = await client!.frame(message("ev_1", "om_1"));
    order.push(`acked:${first.ack}`);
    // The same delivery again, then the same message under a new event id.
    expect((await client!.frame(message("ev_1", "om_1"))).ack).toBe("ok");
    expect((await client!.frame(message("ev_2", "om_1"))).ack).toBe("ok");
    expect(order).toEqual([
      "stored:feishu:bond_fs:event:ev_1",
      "acked:ok",
      "duplicate:feishu:bond_fs:event:ev_1",
      "stored:feishu:bond_fs:event:ev_2",
    ]);
    await waitFor(() => claimed.size === 1 && order.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(processed).toEqual(["feishu:feishu:bond_fs:om_1"]);

    failWrites = true;
    expect((await client!.frame(message("ev_3", "om_3"))).ack).toBe("retry");
    failWrites = false;
    expect((await client!.frame(message("ev_3", "om_3"))).ack).toBe("ok");
    await waitFor(() => processed.length === 2);

    await runtime.stop();
    expect((await client!.frame(message("ev_4", "om_4"))).ack).toBe("retry");
  });
});
