import { readFileSync } from "node:fs";
import type { ContextProjection, OperationCallResult } from "@openma/matter";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { OPERATION_CALL_METHOD } from "@openma/matter/agent";
import {
  TEMPLATE_OPERATION_CALL_METHOD,
  feishuAgent,
  feishuMarkdownCard,
  feishuTemplates,
  makeFeishuIntegration,
  type FeishuEventInput,
} from "@openma/matter-feishu/bond";
import {
  isGuestLoop,
  loopConfigSchemaProblems,
  loopRunAs,
} from "@openma/matter-loop";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { describe, expect, it } from "vitest";

const BOT = "ou_bot";
let seq = 0;

const message = (
  opts: {
    readonly chatType?: "p2p" | "group";
    readonly chatId?: string;
    readonly text?: string;
    readonly mentionBot?: boolean;
    readonly sender?: string;
    readonly senderType?: string;
    readonly rootId?: string;
    readonly threadId?: string;
  } = {},
): FeishuEventInput => {
  seq += 1;
  const mentionBot = opts.mentionBot ?? true;
  return {
    kind: "feishu.event",
    authority: "bond_fs",
    transport: "long_connection",
    botOpenId: BOT,
    envelope: {
      schema: "2.0",
      header: {
        event_id: `ev_${seq}`,
        event_type: "im.message.receive_v1",
        create_time: "1792000000000",
        app_id: "cli_0123456789abcdef",
      },
      event: {
        sender: {
          sender_id: { open_id: opts.sender ?? "ou_alice" },
          sender_type: opts.senderType ?? "user",
        },
        message: {
          message_id: `om_${seq}`,
          ...(opts.rootId === undefined ? {} : { root_id: opts.rootId }),
          ...(opts.threadId === undefined ? {} : { thread_id: opts.threadId }),
          chat_id: opts.chatId ?? "oc_eng",
          chat_type: opts.chatType ?? "group",
          message_type: "text",
          content: JSON.stringify({
            text:
              opts.text ??
              (mentionBot ? "@_user_1 why does login 500?" : "lunch anyone?"),
          }),
          mentions: mentionBot
            ? [{ key: "@_user_1", id: { open_id: BOT }, name: "OMA Bot" }]
            : [],
        },
      },
    },
  };
};

const recall = (messageId: string, chatId = "oc_eng"): FeishuEventInput => {
  seq += 1;
  return {
    kind: "feishu.event",
    authority: "bond_fs",
    transport: "long_connection",
    botOpenId: BOT,
    envelope: {
      schema: "2.0",
      header: {
        event_id: `ev_${seq}`,
        event_type: "im.message.recalled_v1",
        create_time: "1792000000000",
      },
      event: {
        message_id: messageId,
        chat_id: chatId,
        recall_type: "message_owner",
      },
    },
  };
};

const ANSWER = "Found it: `auth/session.ts:42` returns null.";

/**
 * A Feishu app with one Agent. The Agent replies with `replies` through the
 * tool (none: it does not reply); `during` arrive while it works.
 */
const makeHarness = (
  opts: {
    readonly replies?: readonly string[];
    readonly during?: () => readonly FeishuEventInput[];
    /** Feishu's `code` for a reaction call (0: it is added). */
    readonly reactionCode?: number;
  } = {},
) => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  /** Reactions added, kept apart from the messages in `posted`. */
  const reactions: { url: string; body: Record<string, unknown> }[] = [];
  /** What happened, in order: `turn` or `reaction`. */
  const order: string[] = [];
  const contexts: ContextProjection[] = [];
  const sessions: unknown[] = [];
  let app: ReturnType<typeof createOpenMatter> | undefined;
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: (opts.replies ?? [ANSWER]).map((markdown, i) => ({
      callId: `reply-${i + 1}`,
      integrationId: "feishu",
      operation: "message.reply",
      input: { markdown },
    })),
    beforeEvents: async () => {
      for (const input of opts.during?.() ?? []) {
        await app!.acceptFrom("feishu", input);
      }
    },
  });
  const driver = {
    ...worker.driver,
    turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
      contexts.push(input.context);
      order.push("turn");
      return worker.driver.turn(input);
    },
  };
  const feishu = makeFeishuIntegration({
    credentials: { baseUrl: "https://open.feishu.cn", token: "t-bot" },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      if (call.url.endsWith("/reactions")) {
        reactions.push(call);
        order.push("reaction");
        const code = opts.reactionCode ?? 0;
        return Response.json(
          code === 0
            ? { code, data: { reaction_id: `r_${reactions.length}` } }
            : { code, msg: "no permission" },
        );
      }
      posted.push(call);
      return Response.json({
        code: 0,
        data: { message_id: `om_reply_${posted.length}` },
      });
    }) as typeof globalThis.fetch,
  });
  app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { feishu },
    agents: { worker: driver },
  });
  const send = async (input: FeishuEventInput) => {
    const receipts = await app!.acceptFrom("feishu", input);
    return receipts[0];
  };
  const results = () =>
    worker
      .callbackResponses()
      .map((r) => r.result as unknown as OperationCallResult);
  return {
    app,
    send,
    posted,
    reactions,
    order,
    contexts,
    sessions,
    worker,
    results,
  };
};

const config = { agentId: "worker" };

describe("Feishu Loop templates", () => {
  it("ship a portable feishu-agent that acts for the requester and replies as the bot", () => {
    expect(feishuTemplates.map((l) => l.definition.id)).toEqual([
      "feishu-agent",
    ]);
    const d = feishuAgent.definition;
    expect(isGuestLoop(feishuAgent)).toBe(true);
    expect(Object.isFrozen(d)).toBe(true);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(loopConfigSchemaProblems(d.configSchema!)).toEqual([]);
    // The Session acts for the person who asked; the reply is the bot's.
    expect(d.runAs).toBe("requester");
    expect(loopRunAs(d, "gitlab", "read")).toBe("requester");
    expect(loopRunAs(d, "feishu", "im_send")).toBe("app");
    expect(loopRunAs(d, "feishu", "im_react")).toBe("app");
    // Tools and behaviour belong to the Agent, not the template.
    expect(d.requiredBonds!.map((b) => b.provider)).toEqual(["feishu"]);
    expect(Object.keys(d.configSchema!.properties).sort()).toEqual([
      "acknowledge",
      "agentId",
      "chats",
      "freshness",
      "sessionScope",
    ]);
    expect(d.configSchema!.properties.freshness).toMatchObject({
      default: "thread",
      "x-oma-widget": "freshness",
    });
    expect(d.spec).toMatchObject({
      observes: ["feishu.message.received", "feishu.message.recalled"],
      reaction: "tools",
    });
    expect(d.configSchema!.required).toEqual(["agentId"]);
    expect(d.configSchema!.properties.chats).toMatchObject({
      "x-oma-widget": "bond-resources",
      "x-bond-provider": "feishu",
    });
    expect(TEMPLATE_OPERATION_CALL_METHOD).toBe(OPERATION_CALL_METHOD);
    const source = readFileSync(
      new URL(
        "../packages/feishu/src/bond/integration/templates.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      ),
    ).toEqual(["@openma/matter-loop"]);
  });

  it("answers a group mention in its topic with a markdown card the Agent posts through the tool", async () => {
    const { app, send, posted, contexts, worker, results } = makeHarness();
    app.loop(feishuAgent, config);

    const receipt = await send(message());

    expect(receipt!.reaction).toMatchObject({
      status: "completed",
      reason: "The Agent called the reply tool",
      effects: [],
    });
    // Posted during the Turn, not as an Effect after it.
    expect(receipt!.deliveries).toEqual([]);
    expect(results()).toEqual([
      { status: "delivered", receipt: { messageId: "om_reply_1" } },
    ]);
    expect(worker.turnInputs()[0]!.tools?.map((t) => t.name)).toEqual([
      "feishu.message.reply",
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toMatch(
      /\/open-apis\/im\/v1\/messages\/om_\d+\/reply$/,
    );
    expect(posted[0]!.body).toMatchObject({
      msg_type: "interactive",
      reply_in_thread: true,
    });
    expect(JSON.parse(String(posted[0]!.body.content))).toEqual(
      feishuMarkdownCard(ANSWER),
    );
    expect(contexts[0]).toMatchObject({
      scopeId: "feishu:bond_fs:chat:oc_eng",
      grants: ["feishu.message.reply", "feishu.reaction.add"],
    });
    expect(contexts[0]!.workThreadId).toMatch(/^thread:om_\d+$/);
    const instructions = String(
      contexts[0]!.items.find((i) => i.kind === "instructions")?.value,
    );
    expect(instructions).toContain("ou_alice");
    expect(instructions).toContain("mentioned you in a group chat");
    expect(instructions).toContain("on their behalf");
    expect(instructions).toContain("feishu.message.reply");
    expect(instructions).not.toMatch(/gitlab/i);
  });

  it("answers a direct message without a topic, and keeps a thread's Session", async () => {
    const { app, send, posted, contexts } = makeHarness();
    app.loop(feishuAgent, config);
    await send(
      message({
        chatType: "p2p",
        chatId: "oc_dm",
        mentionBot: false,
        text: "hi",
      }),
    );
    expect(posted[0]!.body.reply_in_thread).toBeUndefined();
    expect(
      String(contexts[0]!.items.find((i) => i.kind === "instructions")?.value),
    ).toContain("messaged you directly");

    await send(message({ rootId: "om_root" }));
    await send(message({ rootId: "om_root" }));
    expect(contexts[1]!.workThreadId).toBe("thread:om_root");
    expect(contexts[2]!.workThreadId).toBe("thread:om_root");
  });

  it("scopes Sessions per chat or per person when configured", async () => {
    const perUser = makeHarness();
    perUser.app.loop(feishuAgent, { ...config, sessionScope: "chat_user" });
    await perUser.send(message({ sender: "ou_bob" }));
    expect(perUser.contexts[0]!.workThreadId).toBe("user:ou_bob");

    const perChat = makeHarness();
    perChat.app.loop(feishuAgent, { ...config, sessionScope: "chat" });
    await perChat.send(message());
    expect(perChat.contexts[0]!.workThreadId).toBe("chat");
  });

  it("stays quiet outside watched chats, for bots, other messages, and empty replies", async () => {
    const { app, send, posted, reactions } = makeHarness();
    app.loop(feishuAgent, { ...config, chats: ["chat:oc_eng"] });
    expect(
      (await send(message({ chatId: "oc_random" })))!.reaction.reason,
    ).toBe("Chat is not watched");
    expect((await send(message({ senderType: "app" })))!.reaction.reason).toBe(
      "A bot's message",
    );
    // A direct message is answered even with a chat list.
    await send(
      message({ chatType: "p2p", chatId: "oc_dm", mentionBot: false }),
    );
    expect(posted).toHaveLength(1);
    // A group message that does not mention the bot is not for this Loop.
    const ignored = await send(message({ mentionBot: false }));
    expect(ignored?.deliveries ?? []).toEqual([]);
    expect(posted).toHaveLength(1);

    // A bare mention carries no question.
    expect((await send(message({ text: "@_user_1  " })))!.reaction.reason).toBe(
      "Empty message",
    );
    expect(posted).toHaveLength(1);

    // Only the direct message was taken, so only it was acknowledged.
    expect(reactions).toHaveLength(1);

    const silent = makeHarness({ replies: [] });
    silent.app.loop(feishuAgent, config);
    expect((await silent.send(message()))!.reaction.reason).toBe(
      "The Agent did not reply",
    );
    expect(silent.posted).toEqual([]);

    const blank = makeHarness({ replies: ["   "] });
    blank.app.loop(feishuAgent, config);
    await blank.send(message());
    expect(blank.results()[0]).toEqual({
      status: "refused",
      reason: "A reply needs exactly one non-empty markdown string",
    });
    expect(blank.posted).toEqual([]);
  });

  it("acknowledges a message it takes with a reaction before the Agent works", async () => {
    const t = makeHarness();
    t.app.loop(feishuAgent, config);
    await t.send(message());

    expect(t.order).toEqual(["reaction", "turn"]);
    expect(t.reactions).toEqual([
      {
        url: `https://open.feishu.cn/open-apis/im/v1/messages/om_${seq}/reactions`,
        body: { reaction_type: { emoji_type: "OnIt" } },
      },
    ]);
    // The Agent may still only reply.
    expect(t.worker.turnInputs()[0]!.tools?.map((x) => x.name)).toEqual([
      "feishu.message.reply",
    ]);

    const custom = makeHarness();
    custom.app.loop(feishuAgent, { ...config, acknowledge: "THUMBSUP" });
    await custom.send(message());
    expect(custom.reactions[0]!.body).toEqual({
      reaction_type: { emoji_type: "THUMBSUP" },
    });

    const off = makeHarness();
    off.app.loop(feishuAgent, { ...config, acknowledge: "" });
    await off.send(message());
    expect(off.reactions).toEqual([]);
    expect(off.contexts[0]!.grants).toEqual(["feishu.message.reply"]);
    expect(off.posted).toHaveLength(1);

    // Not an emoji_type name: refused before Feishu, and the answer goes on.
    const bad = makeHarness();
    bad.app.loop(feishuAgent, { ...config, acknowledge: "<b>" });
    await bad.send(message());
    expect(bad.reactions).toEqual([]);
    expect(bad.posted).toHaveLength(1);
  });

  it("answers even when the acknowledgement fails", async () => {
    const t = makeHarness({ reactionCode: 99991672 });
    t.app.loop(feishuAgent, config);
    const receipt = await t.send(message());

    expect(t.reactions).toHaveLength(1);
    expect(receipt!.reaction).toMatchObject({
      status: "completed",
      reason: "The Agent called the reply tool",
    });
    expect(t.posted).toHaveLength(1);
  });

  it("refuses a configuration without an Agent or with an unknown scope", () => {
    const { app } = makeHarness();
    expect(() => app.loop(feishuAgent, {})).toThrow(
      "Invalid configuration for Loop feishu-agent",
    );
    expect(() =>
      app.loop(feishuAgent, { ...config, sessionScope: "forever" }),
    ).toThrow("Invalid configuration for Loop feishu-agent");
  });

  it("returns a correction posted while the Agent works, and posts the revised reply", async () => {
    const t = makeHarness({
      replies: ["Login 500s because of X", "On staging it is Y"],
      during: () => [
        message({ mentionBot: false, text: "sorry, I meant on staging" }),
      ],
    });
    t.app.loop(feishuAgent, config);
    await t.send(message());

    expect(t.results().map((r) => r.status)).toEqual(["conflict", "delivered"]);
    expect(t.results()[0]).toMatchObject({
      conflict: {
        messages: [
          {
            kind: "message",
            threadId: "main",
            sender: { id: "ou_alice", kind: "human" },
            text: "sorry, I meant on staging",
          },
        ],
      },
    });
    expect(t.posted).toHaveLength(1);
    expect(JSON.parse(String(t.posted[0]!.body.content))).toEqual(
      feishuMarkdownCard("On staging it is Y"),
    );
  });

  it("returns the recall of the question, and ignores other topics and bots", async () => {
    const recalled = makeHarness({
      replies: ["answer"],
      during: () => [recall(`om_${seq}`)],
    });
    recalled.app.loop(feishuAgent, config);
    await recalled.send(message());
    expect(recalled.results()[0]).toMatchObject({
      status: "conflict",
      conflict: { messages: [{ kind: "recall", threadId: "main" }] },
    });
    expect(recalled.posted).toEqual([]);

    const unrelated = makeHarness({
      during: () => [
        message({ mentionBot: false, threadId: "omt_other" }),
        message({ mentionBot: false, senderType: "app", sender: "ou_bot2" }),
        message({ mentionBot: false, chatId: "oc_other" }),
      ],
    });
    unrelated.app.loop(feishuAgent, config);
    await unrelated.send(message());
    expect(unrelated.results().map((r) => r.status)).toEqual(["delivered"]);
  });

  it("posts regardless of newer messages when freshness is off", async () => {
    const t = makeHarness({
      during: () => [message({ mentionBot: false, text: "never mind" })],
    });
    t.app.loop(feishuAgent, { ...config, freshness: "off" });
    await t.send(message());
    expect(t.results().map((r) => r.status)).toEqual(["delivered"]);
  });
});
