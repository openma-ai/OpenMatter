import type { WorkEvent } from "@openma/matter";
import {
  FEISHU_TOOLS,
  bindFeishuToolInput,
  feishuMarkdownCard,
  observeFeishuEvent,
} from "@openma/matter-feishu/bond";
import { describe, expect, it } from "vitest";

const event = (
  type: string,
  payload: Record<string, unknown>,
  message: Record<string, string> = {},
): WorkEvent => ({
  schemaVersion: "0.1",
  id: `feishu:bond_fs:${String(payload.messageId ?? "x")}`,
  type,
  occurredAt: "2026-10-18T00:00:00.000Z",
  receivedAt: "2026-10-18T00:00:01.000Z",
  idempotencyKey: "k",
  source: { provider: "feishu", authority: "bond_fs" },
  payload: payload as WorkEvent["payload"],
  raw: { event: { message } },
});

const asked = (activation: "mention" | "direct" = "mention") =>
  event("feishu.message.mentioned", {
    chatId: "oc_eng",
    messageId: "om_ask",
    activation,
    sender: { openId: "ou_alice" },
    senderType: "user",
    text: "why?",
  });

describe("Feishu conversation observation", () => {
  it("maps messages to their topic or the main flow, with sender and text", () => {
    expect(observeFeishuEvent(asked())).toEqual({
      conversationId: "oc_eng",
      kind: "mention",
      threadId: "main",
      messageId: "om_ask",
      sender: { id: "ou_alice", kind: "human" },
      text: "why?",
    });
    const inTopic = event(
      "feishu.message.received",
      {
        chatId: "oc_eng",
        messageId: "om_2",
        sender: { openId: "ou_bot2" },
        senderType: "app",
      },
      { thread_id: "omt_1", root_id: "om_root" },
    );
    expect(observeFeishuEvent(inTopic)).toMatchObject({
      kind: "message",
      threadId: "omt_1",
      sender: { id: "ou_bot2", kind: "app" },
    });
    // A quote reply shows in the main flow.
    const quote = event(
      "feishu.message.received",
      { chatId: "oc_eng", messageId: "om_3" },
      { root_id: "om_root" },
    );
    expect(observeFeishuEvent(quote)).toMatchObject({ threadId: "main" });
    expect(observeFeishuEvent(quote)?.sender).toBeUndefined();
  });

  it("maps a recall to the recalled message and ignores other events", () => {
    expect(
      observeFeishuEvent(
        event("feishu.message.recalled", {
          chatId: "oc_eng",
          messageId: "om_ask",
        }),
      ),
    ).toEqual({
      conversationId: "oc_eng",
      kind: "recall",
      messageId: "om_ask",
    });
    expect(
      observeFeishuEvent(
        event("feishu.message.recalled", { chatId: "oc_eng" }),
      ),
    ).toBeUndefined();
    expect(
      observeFeishuEvent(event("feishu.reaction.added", { chatId: "oc_eng" })),
    ).toBeUndefined();
    expect(
      observeFeishuEvent(
        event("feishu.message.received", { messageId: "om_1" }),
      ),
    ).toBeUndefined();
  });
});

describe("Feishu reply tool", () => {
  it("is described for the Agent and checked for freshness", () => {
    expect(Object.keys(FEISHU_TOOLS)).toEqual(["message.reply"]);
    expect(FEISHU_TOOLS["message.reply"]).toMatchObject({
      freshness: "best-effort",
      inputSchema: { required: ["markdown"], additionalProperties: false },
    });
  });

  it("binds the target, authority, and topic from the message that asked", () => {
    expect(
      bindFeishuToolInput("message.reply", { markdown: "**hi**" }, asked()),
    ).toEqual({
      input: {
        authority: "bond_fs",
        messageId: "om_ask",
        card: feishuMarkdownCard("**hi**"),
        inThread: true,
      },
    });
    expect(
      bindFeishuToolInput("message.reply", { markdown: "hi" }, asked("direct")),
    ).toEqual({
      input: {
        authority: "bond_fs",
        messageId: "om_ask",
        card: feishuMarkdownCard("hi"),
      },
    });
  });

  it("refuses anything the Agent must not choose or a trigger that is not a message", () => {
    const refused = (r: ReturnType<typeof bindFeishuToolInput>) =>
      "refused" in r ? r.refused : undefined;
    expect(
      refused(bindFeishuToolInput("message.send", { markdown: "x" }, asked())),
    ).toBe("Feishu has no tool message.send");
    for (const input of [
      { markdown: "x", messageId: "om_other" },
      { markdown: "" },
      { text: "x" },
      "x",
    ]) {
      expect(
        refused(bindFeishuToolInput("message.reply", input, asked())),
      ).toBe("A reply needs exactly one non-empty markdown string");
    }
    expect(
      refused(
        bindFeishuToolInput(
          "message.reply",
          { markdown: "x" },
          event("feishu.card.action", { chatId: "oc_eng", messageId: "om_1" }),
        ),
      ),
    ).toBe("This Turn was not started by a Feishu message");
    expect(
      refused(
        bindFeishuToolInput(
          "message.reply",
          { markdown: "x" },
          {
            ...asked(),
            source: { provider: "slack", authority: "w" },
          },
        ),
      ),
    ).toBe("This Turn was not started by a Feishu message");
  });
});
