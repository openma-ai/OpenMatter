import { createOpenMatter, SessionBusyError } from "@openmatter/runtime";
import type { OpenMatterApplication } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeLocalSlackRuntime } from "../packages/host-local/src/index.js";
import {
  makeSqliteInbox,
  type SqliteInbox,
} from "../packages/inbox-sqlite/src/index.js";
import { makeSlackIntegration } from "../packages/integration-slack/src/index.js";

type SocketListener = (event: {
  readonly type: string;
  readonly envelope_id: string;
  readonly body: unknown;
  readonly ack: () => Promise<void>;
}) => Promise<void> | void;

class TestSocketModeClient {
  readonly listeners = new Map<string, SocketListener[]>();

  on(event: string, listener: SocketListener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string, listener?: SocketListener): this {
    if (listener === undefined) {
      this.listeners.delete(event);
      return this;
    }
    const remaining = (this.listeners.get(event) ?? []).filter(
      (candidate) => candidate !== listener,
    );
    if (remaining.length === 0) this.listeners.delete(event);
    else this.listeners.set(event, remaining);
    return this;
  }

  async start(): Promise<unknown> {
    return { ok: true };
  }

  async disconnect(): Promise<void> {}

  async receive(
    event: string,
    body: unknown,
    ack: () => Promise<void>,
    envelopeId = "socket-envelope-1",
  ) {
    const listeners = this.listeners.get("slack_event");
    if (listeners === undefined)
      throw new Error("No listener for Slack's universal slack_event");
    for (const listener of listeners) {
      await listener({ type: event, envelope_id: envelopeId, body, ack });
    }
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

describe("local Slack Socket Mode runtime", () => {
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

  it("persists a Socket envelope before acknowledging it", async () => {
    const order: string[] = [];
    const client = new TestSocketModeClient();
    const inbox = {
      enqueue: () =>
        Effect.sync(() => {
          order.push("persisted");
          return "stored" as const;
        }),
      claim: () => Effect.succeed([]),
      complete: () => Effect.void,
      retry: () => Effect.void,
      renew: () => Effect.void,
    };
    const application = {
      acceptFromEffect: () =>
        Effect.sync(() => {
          order.push("processed");
          return [];
        }),
      recoverEffectsEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      client,
      inbox,
      recoveryIntervalMs: false,
    } as never);

    await runtime.start();
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => void order.push("acked"),
    );
    await runtime.stop();

    expect(order).toEqual(["persisted", "acked"]);
  });

  it("does not hold Slack acknowledgement open for Agent processing", async () => {
    const client = new TestSocketModeClient();
    const application = {
      acceptFromEffect: () => Effect.never,
      recoverEffectsEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
      recoveryIntervalMs: false,
      inboxPollIntervalMs: 1,
    });

    await runtime.start();
    const receipt = client.receive(
      "events_api",
      { type: "event_callback" },
      async () => undefined,
    );
    const outcome = await Promise.race([
      receipt.then(() => "acknowledged" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);
    await runtime.stop();

    expect(outcome).toBe("acknowledged");
  });

  it("does not acknowledge a Socket envelope when durable persistence fails", async () => {
    const client = new TestSocketModeClient();
    let acknowledged = false;
    const inbox = {
      enqueue: () => Effect.fail(new Error("disk unavailable")),
      claim: () => Effect.succeed([]),
      complete: () => Effect.void,
      retry: () => Effect.void,
      renew: () => Effect.void,
    };
    const application = {
      acceptFromEffect: () => Effect.succeed([]),
      recoverEffectsEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      client,
      inbox,
      recoveryIntervalMs: false,
    } as never);

    await runtime.start();
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => void (acknowledged = true),
    );
    await runtime.stop();

    expect(acknowledged).toBe(false);
  });

  it("processes a pending durable envelope when a local runtime starts", async () => {
    const client = new TestSocketModeClient();
    let claimed = false;
    let completed = false;
    let markProcessed: (() => void) | undefined;
    const processed = new Promise<void>((resolve) => {
      markProcessed = resolve;
    });
    const inbox = {
      enqueue: () => Effect.succeed("stored" as const),
      claim: () =>
        Effect.sync(() => {
          if (claimed) return [];
          claimed = true;
          return [
            {
              item: {
                id: "slack:socket-envelope-pending",
                idempotencyKey: "slack:socket-envelope-pending",
                integrationId: "slack",
                eventType: "events_api",
                body: { type: "event_callback", event_id: "EvPending" },
                receivedAt: "2026-08-20T10:00:00.000Z",
              },
              attempt: 1,
              lease: {
                token: "lease-1",
                ownerId: "local-1",
                expiresAt: "2026-08-20T10:01:00.000Z",
              },
            },
          ];
        }),
      complete: () =>
        Effect.sync(() => {
          completed = true;
        }),
      retry: () => Effect.void,
      renew: () => Effect.void,
    };
    const accepted: unknown[] = [];
    const application = {
      acceptFromEffect: (_integrationId: string, input: unknown) =>
        Effect.sync(() => {
          accepted.push(input);
          markProcessed?.();
          return [];
        }),
      recoverEffectsEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      client,
      inbox,
      recoveryIntervalMs: false,
    } as never);

    await runtime.start();
    const outcome = await Promise.race([
      processed.then(() => "processed" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);
    await runtime.stop();

    expect(outcome).toBe("processed");
    expect(accepted).toEqual([
      { type: "event_callback", event_id: "EvPending" },
    ]);
    expect(completed).toBe(true);
  });

  it("runs durable effect recovery on a host-owned interval", async () => {
    const client = new TestSocketModeClient();
    let markRecovered: (() => void) | undefined;
    const recovered = new Promise<void>((resolve) => {
      markRecovered = resolve;
    });
    let recoveries = 0;
    const application = {
      acceptFromEffect: () => Effect.succeed([]),
      recoverEffectsEffect: () =>
        Effect.sync(() => {
          recoveries += 1;
          markRecovered?.();
          return [];
        }),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
      recoveryIntervalMs: 1,
    });

    await runtime.start();
    await recovered;
    await runtime.stop();

    expect(recoveries).toBeGreaterThanOrEqual(1);
  });

  it("acknowledges a pre-authenticated envelope before passing it through the Slack adapter", async () => {
    const order: string[] = [];
    const client = new TestSocketModeClient();
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const store = makeMemoryStore();
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: {},
    });
    app.on("slack.message.mentioned", (work) => {
      order.push("handled");
      return work.react.none("received over socket mode");
    });
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application: app,
      inbox: testInbox(),
      client,
    });

    await runtime.start();
    await client.receive(
      "events_api",
      {
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvSocket",
        event: {
          type: "app_mention",
          user: "U01",
          text: "<@BCLAUDE> inspect checkout",
          ts: "1724140800.123456",
          channel: "C01",
          event_ts: "1724140800.123456",
        },
      },
      async () => {
        order.push("acked");
      },
    );
    await waitFor(() => order.includes("handled"));
    await runtime.stop();
    const snapshot = await Effect.runPromise(store.inspect);

    expect(order).toEqual(["acked", "handled"]);
    expect(snapshot.reactions).toEqual([
      expect.objectContaining({
        eventId: "slack:EvSocket",
        status: "completed",
      }),
    ]);
  });

  it("marks a Socket Mode slash command for Slack semantic normalization", async () => {
    const client = new TestSocketModeClient();
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const store = makeMemoryStore();
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: {},
    });
    app.on("slack.command.invoked", (work) =>
      work.react.none("received local command"),
    );
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application: app,
      inbox: testInbox(),
      client,
    });

    await runtime.start();
    await client.receive(
      "slash_commands",
      {
        team_id: "TWORK",
        channel_id: "C01",
        user_id: "U01",
        command: "/claude",
        text: "inspect checkout",
        trigger_id: "TrigLocal",
        response_url: "https://hooks.slack.com/commands/T/C/secret",
      },
      async () => undefined,
    );
    await waitFor(async () => {
      const snapshot = await Effect.runPromise(store.inspect);
      return snapshot.reactions.length === 1;
    });
    await runtime.stop();
    const snapshot = await Effect.runPromise(store.inspect);

    expect(snapshot.reactions).toEqual([
      expect.objectContaining({
        eventId: "slack:command:TrigLocal",
        status: "completed",
      }),
    ]);
  });

  it("contains one failed ingestion and reports it without rejecting the Socket Mode listener", async () => {
    const client = new TestSocketModeClient();
    const errors: unknown[] = [];
    const application = {
      acceptFromEffect: () =>
        Effect.fail(new Error("store temporarily unavailable")),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await expect(
      client.receive(
        "events_api",
        { type: "event_callback" },
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
    await waitFor(() => errors.length === 1);
    await runtime.stop();

    expect(errors).toEqual([
      expect.objectContaining({
        _tag: "LocalRuntimeError",
        phase: "ingest",
        message: "Unable to process durable events_api envelope",
      }),
    ]);
  });

  it("keeps the durable consumer alive after an application defect", async () => {
    const client = new TestSocketModeClient();
    const errors: unknown[] = [];
    let attempts = 0;
    let markSucceeded: (() => void) | undefined;
    const succeeded = new Promise<void>((resolve) => {
      markSucceeded = resolve;
    });
    const application = {
      acceptFromEffect: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("unexpected adapter defect");
        return Effect.sync(() => {
          markSucceeded?.();
          return [];
        });
      },
      recoverEffectsEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
      retryDelayMs: 0,
      inboxPollIntervalMs: 1,
      recoveryIntervalMs: false,
      onError: (error) => errors.push(error),
    });

    await runtime.start();
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => undefined,
    );
    const outcome = await Promise.race([
      succeeded.then(() => "processed" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);
    await runtime.stop();

    expect(outcome).toBe("processed");
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("does not duplicate listeners when Socket Mode start is retried", async () => {
    class FlakySocketModeClient extends TestSocketModeClient {
      private attempts = 0;

      override async start(): Promise<unknown> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error("connection unavailable");
        return { ok: true };
      }
    }

    const client = new FlakySocketModeClient();
    let accepted = 0;
    let acknowledged = 0;
    const application = {
      acceptFromEffect: () =>
        Effect.sync(() => {
          accepted += 1;
          return [];
        }),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
    });

    await expect(runtime.start()).rejects.toBeDefined();
    await runtime.start();
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => void (acknowledged += 1),
    );
    await waitFor(() => accepted === 1);
    await runtime.stop();

    expect(acknowledged).toBe(1);
    expect(accepted).toBe(1);
  });

  it("coalesces concurrent start calls into one listener lifecycle", async () => {
    class GatedSocketModeClient extends TestSocketModeClient {
      private readonly startResolvers: Array<() => void> = [];

      override start(): Promise<unknown> {
        return new Promise((resolve) => {
          this.startResolvers.push(() => resolve({ ok: true }));
        });
      }

      releaseStarts() {
        for (const resolve of this.startResolvers.splice(0)) resolve();
      }
    }

    const client = new GatedSocketModeClient();
    let acknowledged = 0;
    const application = {
      acceptFromEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
    });

    const first = runtime.start();
    const second = runtime.start();
    const releaseTimer = setInterval(() => client.releaseStarts(), 1);
    try {
      await Promise.all([first, second]);
    } finally {
      clearInterval(releaseTimer);
    }
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => void (acknowledged += 1),
    );
    await runtime.stop();

    expect(acknowledged).toBe(1);
  });

  it("interrupts in-flight envelope work before stop completes", async () => {
    const client = new TestSocketModeClient();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let interrupted = 0;
    const application = {
      acceptFromEffect: () =>
        Effect.sync(() => markStarted?.()).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1;
            }),
          ),
        ),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
    });

    await runtime.start();
    const delivery = client.receive(
      "events_api",
      { type: "event_callback" },
      async () => undefined,
    );
    await started;
    await runtime.stop();
    const outcome = await Promise.race([
      delivery.then(() => "completed" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);

    expect(outcome).toBe("completed");
    expect(interrupted).toBe(1);
  });

  it("allows disconnect to be retried after a transient stop failure", async () => {
    class FlakyDisconnectClient extends TestSocketModeClient {
      disconnectCalls = 0;

      override async disconnect(): Promise<void> {
        this.disconnectCalls += 1;
        if (this.disconnectCalls === 1) {
          throw new Error("socket still closing");
        }
      }
    }

    const client = new FlakyDisconnectClient();
    const application = {
      acceptFromEffect: () => Effect.succeed([]),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
    });

    await runtime.start();
    await expect(runtime.stop()).rejects.toBeDefined();
    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(client.disconnectCalls).toBe(2);
  });

  it("retries acknowledged work in-process when a Session lease is busy", async () => {
    const client = new TestSocketModeClient();
    let attempts = 0;
    let markSucceeded: (() => void) | undefined;
    const succeeded = new Promise<void>((resolve) => {
      markSucceeded = resolve;
    });
    const application = {
      acceptFromEffect: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new SessionBusyError({
                  bindingKey: "claude:slack:TWORK:C01",
                  retryAt: "2026-08-20T10:00:00.000Z",
                  message: "Session is already leased",
                }),
              )
            : Effect.sync(() => {
                markSucceeded?.();
                return [];
              });
        }),
    } as unknown as OpenMatterApplication;
    const runtime = makeLocalSlackRuntime({
      appToken: "xapp-test",
      application,
      inbox: testInbox(),
      client,
      clock: () => Date.parse("2026-08-20T10:00:00.000Z"),
      retryDelayMs: 0,
      inboxPollIntervalMs: 1,
    });

    await runtime.start();
    await client.receive(
      "events_api",
      { type: "event_callback" },
      async () => undefined,
    );
    await succeeded;
    await runtime.stop();

    expect(attempts).toBe(2);
  });
});
