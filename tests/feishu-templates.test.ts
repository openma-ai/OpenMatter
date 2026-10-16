import { readFileSync } from "node:fs";
import type { ContextProjection } from "@openma/matter";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import {
  feishuAgent,
  feishuMarkdownCard,
  feishuTemplates,
  makeFeishuIntegration,
  templateMarkdownCard,
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

const makeHarness = (
  agentOutput = "Found it: `auth/session.ts:42` returns null.",
) => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const contexts: ContextProjection[] = [];
  const sessions: unknown[] = [];
  const worker = makeMockAgentDriver({ id: "worker", output: agentOutput });
  const driver = {
    ...worker.driver,
    turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
      contexts.push(input.context);
      return worker.driver.turn(input);
    },
  };
  const feishu = makeFeishuIntegration({
    credentials: { baseUrl: "https://open.feishu.cn", token: "t-bot" },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({
        code: 0,
        data: { message_id: `om_reply_${posted.length}` },
      });
    }) as typeof globalThis.fetch,
  });
  const app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { feishu },
    agents: { worker: driver },
  });
  const send = async (input: FeishuEventInput) => {
    const receipts = await app.acceptFrom("feishu", input);
    return receipts[0];
  };
  return { app, send, posted, contexts, sessions };
};

const config = { agentId: "worker", gitlabProjects: ["project:42"] };

describe("Feishu Loop templates", () => {
  it("ship a portable feishu-agent that reads GitLab as the requester and replies as the bot", () => {
    expect(feishuTemplates.map((l) => l.definition.id)).toEqual([
      "feishu-agent",
    ]);
    const d = feishuAgent.definition;
    expect(isGuestLoop(feishuAgent)).toBe(true);
    expect(Object.isFrozen(d)).toBe(true);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(loopConfigSchemaProblems(d.configSchema!)).toEqual([]);
    expect(loopRunAs(d, "gitlab", "fetch")).toBe("requester");
    expect(loopRunAs(d, "gitlab", "read")).toBe("requester");
    expect(loopRunAs(d, "feishu", "im_send")).toBe("app");
    expect(d.configSchema!.properties.gitlabProjects).toMatchObject({
      "x-oma-widget": "bond-resources",
      "x-bond-provider": "gitlab",
    });
    expect(d.configSchema!.properties.chats).toMatchObject({
      "x-oma-widget": "bond-resources",
      "x-bond-provider": "feishu",
    });
    expect(templateMarkdownCard("**x**")).toEqual(feishuMarkdownCard("**x**"));
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

  it("answers a group mention in its topic with a markdown card", async () => {
    const { app, send, posted, contexts } = makeHarness();
    app.loop(feishuAgent, { ...config, instructions: "  Triage bugs.  " });

    const receipt = await send(message());

    expect(receipt!.reaction.status).toBe("completed");
    expect(receipt!.deliveries).toEqual([
      expect.objectContaining({
        integrationId: "feishu",
        operation: "message.reply",
        status: "delivered",
      }),
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
      feishuMarkdownCard("Found it: `auth/session.ts:42` returns null."),
    );
    expect(contexts[0]).toMatchObject({
      scopeId: "feishu:bond_fs:chat:oc_eng",
      grants: ["feishu.message.reply"],
    });
    expect(contexts[0]!.workThreadId).toMatch(/^thread:om_\d+$/);
    const instructions = String(
      contexts[0]!.items.find((i) => i.kind === "instructions")?.value,
    );
    expect(instructions).toContain("project:42");
    expect(instructions).toContain("as the person who asked");
    expect(instructions).toMatch(/\n\nTriage bugs\.$/);
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
    const { app, send, posted } = makeHarness();
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

    const silent = makeHarness("   ");
    silent.app.loop(feishuAgent, config);
    expect((await silent.send(message()))!.reaction.reason).toBe(
      "The Agent produced no reply",
    );
    expect(silent.posted).toEqual([]);
  });

  it("refuses a configuration without GitLab projects or with an unknown scope", () => {
    const { app } = makeHarness();
    expect(() =>
      app.loop(feishuAgent, { agentId: "worker", gitlabProjects: [] }),
    ).toThrow("Invalid configuration for Loop feishu-agent");
    expect(() =>
      app.loop(feishuAgent, { ...config, sessionScope: "forever" }),
    ).toThrow("Invalid configuration for Loop feishu-agent");
  });
});
