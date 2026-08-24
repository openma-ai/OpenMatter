import type { WorkEvent } from "@openmatter/core";
import { createOpenMatter, defineLoop } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { describe, expect, it } from "vitest";

const event = (id: string): WorkEvent => ({
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

describe("OpenMatter Loops", () => {
  it("installs a user-defined Loop as a persistent event behavior", async () => {
    const handled: string[] = [];
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: {},
      agents: {},
    });
    const observer = defineLoop(
      {
        id: "observe-chat",
        version: "0.1.0",
        spec: {
          sources: ["chat.message.received"],
          reaction: "none",
        },
      },
      (loopApp) =>
        loopApp.on("chat.message.received", (work) => {
          handled.push(work.event.id);
          return work.react.none("observed");
        }),
    );

    expect(app.loop(observer)).toBe(app);

    const receipt = await app.accept(event("message-1"));

    expect(handled).toEqual(["message-1"]);
    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "completed",
        effects: [],
        reason: "observed",
      }),
    );
  });

  it("keeps the portable Loop definition separate from executable setup", () => {
    const loop = defineLoop(
      {
        id: "issue-triage",
        version: "0.1.0",
        description: "Triage issue updates with an agent",
        spec: {
          sources: ["linear.issue.updated"],
          workThread: "linear.issue",
          session: "per-work-thread",
        },
      },
      () => undefined,
    );

    expect(JSON.parse(JSON.stringify(loop.definition))).toEqual({
      id: "issue-triage",
      version: "0.1.0",
      description: "Triage issue updates with an agent",
      spec: {
        sources: ["linear.issue.updated"],
        workThread: "linear.issue",
        session: "per-work-thread",
      },
    });
  });

  it("snapshots and freezes the portable definition", () => {
    const sources = ["chat.message.received"];
    const loop = defineLoop(
      {
        id: "immutable-loop",
        spec: { sources },
      },
      () => undefined,
    );

    sources[0] = "chat.message.deleted";

    expect(loop.definition.spec).toEqual({
      sources: ["chat.message.received"],
    });
    expect(Object.isFrozen(loop.definition)).toBe(true);
    expect(Object.isFrozen(loop.definition.spec)).toBe(true);
  });
});
