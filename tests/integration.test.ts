import { makeMockIntegration } from "@openmatter/integration-mock";
import { createOpenMatter } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("Work integration boundary", () => {
  it("normalizes a provider-native observation into a WorkEvent", async () => {
    const chat = makeMockIntegration({ id: "chat" });

    const events = await Effect.runPromise(
      chat.integration.ingest({
        id: "native-message-1",
        type: "message.received",
        authority: "workspace-1",
        conversationId: "channel-1",
        occurredAt: "2026-08-20T08:00:00.000Z",
        receivedAt: "2026-08-20T08:00:01.000Z",
        payload: { text: "hello" },
      }),
    );

    expect(events).toEqual([
      {
        schemaVersion: "0.1",
        id: "chat:native-message-1",
        type: "chat.message.received",
        occurredAt: "2026-08-20T08:00:00.000Z",
        receivedAt: "2026-08-20T08:00:01.000Z",
        idempotencyKey: "chat:native-message-1",
        source: {
          provider: "chat",
          authority: "workspace-1",
          conversationId: "channel-1",
        },
        payload: { text: "hello" },
        raw: {
          id: "native-message-1",
          type: "message.received",
          authority: "workspace-1",
          conversationId: "channel-1",
          occurredAt: "2026-08-20T08:00:00.000Z",
          receivedAt: "2026-08-20T08:00:01.000Z",
          payload: { text: "hello" },
        },
      },
    ]);
  });

  it("accepts native input through the same serverless execution path", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", async (work) => work.react.none());

    const receipts = await app.acceptFrom("chat", {
      id: "native-message-2",
      type: "message.received",
      authority: "workspace-1",
      occurredAt: "2026-08-20T08:00:00.000Z",
      receivedAt: "2026-08-20T08:00:01.000Z",
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reaction).toEqual(
      expect.objectContaining({
        eventId: "chat:native-message-2",
        status: "completed",
      }),
    );
  });
});
