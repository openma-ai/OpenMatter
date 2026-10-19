import { readFileSync } from "node:fs";
import type { WorkEvent } from "@openma/matter";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { makeMockIntegration } from "@openma/matter-integration-mock";
import { defineLoop as defineGuestLoop, loadLoop } from "@openma/matter-loop";
import {
  createOpenMatter,
  installLoadedLoop,
  makeLoopHost,
} from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { describe, expect, it } from "vitest";
import guestReplyLoop from "./fixtures/guest-reply-loop.js";

const messageEvent = (id: string): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type: "chat.message.received",
  occurredAt: "2026-08-23T08:00:00.000Z",
  receivedAt: "2026-08-23T08:00:01.000Z",
  idempotencyKey: `chat:${id}`,
  source: {
    provider: "chat",
    authority: "workspace-1",
    conversationId: "channel-1",
    messageId: id,
  },
  payload: { text: "hello" },
});

const makeApp = () => {
  const chat = makeMockIntegration({ id: "chat" });
  const worker = makeMockAgentDriver({ id: "worker", output: "answer" });
  const app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { chat: chat.integration },
    agents: { worker: worker.driver },
  });
  return { app, chat };
};

describe("guest Loops on the runtime", () => {
  it("runs a Loop module that imports only @openma/matter-loop through app.loop", async () => {
    const source = readFileSync(
      new URL("./fixtures/guest-reply-loop.ts", import.meta.url),
      "utf8",
    );
    expect(
      [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ).toEqual(["@openma/matter-loop"]);

    const { app, chat } = makeApp();
    expect(app.loop(guestReplyLoop, { agentId: "worker", prefix: "> " })).toBe(
      app,
    );

    const receipt = await app.accept(messageEvent("message-1"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "completed",
        reason: "turn completed",
      }),
    );
    expect(receipt.reaction.effects).toHaveLength(1);
    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        integrationId: "chat",
        operation: "message.reply",
        status: "delivered",
      }),
    ]);
    expect(chat.delivered()).toEqual([
      expect.objectContaining({ input: { text: "> answer" } }),
    ]);
  });

  it("rejects an invalid configuration and installs nothing", async () => {
    const { app, chat } = makeApp();
    expect(() => app.loop(guestReplyLoop, { prefix: "x" })).toThrow(
      "Invalid configuration for Loop guest-reply",
    );

    const receipt = await app.accept(messageEvent("message-2"));
    expect(receipt.reaction.reason).toBe(
      "No handler registered for chat.message.received",
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("surfaces a refused capability to the guest as an Error named by its tag", async () => {
    const { app, chat } = makeApp();
    const errors: { name: string; message: string }[] = [];
    const loop = defineGuestLoop({ id: "overreach" }, (loopApp) =>
      loopApp.on("chat.message.received", async (work) => {
        const context = await work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.react"],
        });
        try {
          await work.effect(context, {
            integrationId: "chat",
            operation: "message.reply",
            input: { text: "not allowed" },
          });
        } catch (error) {
          const { name, message } = error as Error;
          errors.push({ name, message });
        }
        return work.react.none("refused");
      }),
    );
    app.loop(loop);

    const receipt = await app.accept(messageEvent("message-3"));

    expect(errors).toEqual([
      {
        name: "AuthorizationError",
        message:
          "Effect operation is not authorized by context grants: chat.message.reply",
      },
    ]);
    expect(receipt.reaction).toEqual(
      expect.objectContaining({ status: "completed", reason: "refused" }),
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("marks the Reaction failed when a guest handler throws", async () => {
    const { app } = makeApp();
    app.loop(
      defineGuestLoop({ id: "thrower" }, (loopApp) =>
        loopApp.on("chat.message.received", () => {
          throw new Error("guest exploded");
        }),
      ),
    );

    const receipt = await app.accept(messageEvent("message-4"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({ status: "failed", reason: "guest exploded" }),
    );
  });

  it("lets a host install a LoadedLoop and hand guests a JSON-only LoopHost", async () => {
    const { app, chat } = makeApp();
    const hosts: unknown[] = [];
    const loaded = loadLoop(guestReplyLoop, { agentId: "worker" });
    // An isolate runner wraps the isolate's `handle` like this and serves the
    // LoopHost it receives as the RPC stub.
    installLoadedLoop(app, {
      ...loaded,
      handle: (event, host) => {
        hosts.push(host);
        return loaded.handle(event, host);
      },
    });

    const receipt = await app.accept(messageEvent("message-5"));

    expect(receipt.reaction.status).toBe("completed");
    expect(chat.delivered()).toEqual([
      expect.objectContaining({ input: { text: "answer" } }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(Object.keys(hosts[0] as object).sort()).toEqual([
      "acknowledge",
      "agentCancel",
      "agentTurn",
      "createEffect",
      "projectContext",
    ]);
    expect(typeof makeLoopHost).toBe("function");
  });

  it("returns an Agent Turn summary that survives structured cloning", async () => {
    const { app } = makeApp();
    let summary: unknown;
    app.loop(
      defineGuestLoop({ id: "summary" }, (loopApp) =>
        loopApp.on("chat.message.received", async (work) => {
          const context = await work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [work.context.event()],
          });
          summary = await work
            .agent("worker")
            .session({
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "team",
            })
            .turn({ context });
          return work.react.none();
        }),
      ),
    );

    await app.accept(messageEvent("message-6"));

    expect(summary).toEqual({
      sessionId: expect.any(String),
      turnId: expect.any(String),
      outcome: "completed",
      output: "answer",
      events: expect.any(Array),
    });
    expect(structuredClone(summary)).toEqual(summary);
    expect((summary as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
});
