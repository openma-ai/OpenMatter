import { readFileSync } from "node:fs";
import type { ContextProjection } from "@openma/matter";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import {
  makeSlackIntegration,
  slackAgent,
  slackTemplates,
} from "@openma/matter-slack/bond";
import { isGuestLoop, loopConfigSchemaProblems } from "@openma/matter-loop";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { describe, expect, it } from "vitest";

let eventId = 0;
const envelope = (event: Record<string, unknown>) => ({
  type: "event_callback",
  team_id: "TWORK",
  event_id: `Ev${(eventId += 1)}`,
  event_time: 1724140800,
  event: { ts: "1724140800.123456", channel: "C01", user: "U01", ...event },
});

const mention = (text: string, extra: Record<string, unknown> = {}) =>
  envelope({ type: "app_mention", text: `<@BBOT> ${text}`, ...extra });

const direct = (text: string) =>
  envelope({ type: "message", channel: "D01", channel_type: "im", text });

const makeHarness = (agentOutput = "Retries back off *exponentially*.") => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const contexts: ContextProjection[] = [];
  const worker = makeMockAgentDriver({ id: "worker", output: agentOutput });
  const driver = {
    ...worker.driver,
    turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
      contexts.push(input.context);
      return worker.driver.turn(input);
    },
  };
  const slack = makeSlackIntegration({
    botToken: "xoxb-test",
    botUserId: "BBOT",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: new URL(String(input)).pathname.replace("/api/", ""),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true, ts: `1724140900.00000${calls.length}` });
    }) as typeof globalThis.fetch,
  });
  const app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { slack: slack.integration },
    agents: { worker: driver },
  });
  const send = async (input: unknown) => {
    const [receipt] = await app.acceptFrom("slack", input as never);
    return receipt;
  };
  return { app, send, calls, contexts };
};

describe("Slack Loop templates", () => {
  it("ship a portable definition that imports only the Loop SDK", () => {
    expect(slackTemplates.map((loop) => loop.definition.id)).toEqual([
      "slack-agent",
    ]);
    for (const loop of slackTemplates) {
      expect(isGuestLoop(loop)).toBe(true);
      expect(Object.isFrozen(loop.definition)).toBe(true);
      expect(JSON.parse(JSON.stringify(loop.definition))).toEqual(
        loop.definition,
      );
      expect(loopConfigSchemaProblems(loop.definition.configSchema!)).toEqual(
        [],
      );
    }
    const source = readFileSync(
      new URL("../packages/slack/src/bond/templates.ts", import.meta.url),
      "utf8",
    );
    expect(
      [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["@openma/matter-loop"]);
  });

  it("acknowledges a mention and posts the Agent's answer in its thread", async () => {
    const { app, send, calls, contexts } = makeHarness();
    app.loop(slackAgent, { agentId: "worker" });

    const receipt = await send(mention("how do retries work?"));

    expect(receipt?.reaction.status).toBe("completed");
    expect(receipt?.deliveries).toEqual([
      expect.objectContaining({
        integrationId: "slack",
        operation: "message.reply",
        status: "delivered",
      }),
    ]);
    expect(calls).toEqual([
      {
        method: "reactions.add",
        body: { channel: "C01", timestamp: "1724140800.123456", name: "eyes" },
      },
      {
        method: "chat.postMessage",
        body: {
          channel: "C01",
          thread_ts: "1724140800.123456",
          text: "Retries back off *exponentially*.",
        },
      },
    ]);
    expect(contexts[0]).toMatchObject({
      scopeId: "slack:TWORK:channel:C01",
      workThreadId: "thread:1724140800.123456",
      grants: ["slack.message.reply", "slack.message.react"],
    });
  });

  it("answers a direct message and continues the thread's Session on a reply", async () => {
    const { app, send, calls, contexts } = makeHarness();
    app.loop(slackAgent, { agentId: "worker", acknowledge: "" });
    await send(direct("hello"));
    await send(
      mention("and timeouts?", {
        ts: "1724140850.000001",
        thread_ts: "1724140800.123456",
      }),
    );
    expect(
      calls.map((c) => [c.method, c.body.channel, c.body.thread_ts]),
    ).toEqual([
      ["chat.postMessage", "D01", "1724140800.123456"],
      ["chat.postMessage", "C01", "1724140800.123456"],
    ]);
    expect(contexts.map((c) => c.workThreadId)).toEqual([
      "thread:1724140800.123456",
      "thread:1724140800.123456",
    ]);
    expect(contexts.map((c) => c.scopeId)).toEqual([
      "slack:TWORK:channel:D01",
      "slack:TWORK:channel:C01",
    ]);
  });

  it("ignores channel chatter, bots, unwatched channels and turned-off direct messages", async () => {
    const { app, send, calls } = makeHarness();
    app.loop(slackAgent, {
      agentId: "worker",
      channels: ["C02"],
      directMessages: false,
    });
    const reasons = [
      (await send(envelope({ type: "message", text: "lunch?" })))?.reaction
        .reason,
      (await send(mention("hi")))?.reaction.reason,
      (await send(direct("hi")))?.reaction.reason,
      (await send(mention("   ", { channel: "C02" })))?.reaction.reason,
    ];
    expect(reasons).toEqual([
      "Not addressed to the bot",
      "Channel is not watched",
      "Direct messages are off",
      "Empty message",
    ]);
    // The bot's own message is an observation the template never takes.
    expect(
      (await send(envelope({ type: "message", user: "BBOT", text: "done" })))
        ?.reaction.reason,
    ).toBe("No handler registered for slack.event.received");
    expect(calls).toEqual([]);
  });

  it("posts nothing when the Agent produces no output", async () => {
    const { app, send, calls } = makeHarness("  ");
    app.loop(slackAgent, { agentId: "worker", acknowledge: "" });
    const receipt = await send(mention("hi"));
    expect(receipt?.reaction.reason).toBe("The Agent produced no reply");
    expect(calls).toEqual([]);
  });
});
