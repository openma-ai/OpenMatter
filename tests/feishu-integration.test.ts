import type { WorkEffect } from "@openma/matter";
import { makeCredentialResolver } from "@openma/matter/credentials";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  FEISHU_EVENT_TYPES,
  FEISHU_OPERATIONS,
  feishuMarkdownCard,
  makeFeishuIntegration,
} from "../packages/feishu/src/bond/index.js";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const failure = async <A, E>(e: Effect.Effect<A, E>) => {
  const r = await Effect.runPromise(Effect.either(e));
  if (Either.isRight(r)) throw new Error("expected a failure");
  return r.left as unknown as { message: string; retryable: boolean };
};

type Handler = (
  url: URL,
  init: RequestInit,
) => { status: number; body?: unknown };
const fakeFetch = (handler: Handler) => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
    });
  }) as typeof fetch;
  return { impl, calls };
};
const ok = (data: unknown) => ({
  status: 200,
  body: { code: 0, msg: "ok", data },
});
const json = (init: RequestInit) =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

const effect = (
  operation: string,
  input: unknown,
  idempotencyKey = "feishu:bond_fs:om_1:effect:0",
): WorkEffect =>
  ({
    schemaVersion: "0.1",
    id: `${idempotencyKey}:id`,
    eventId: "feishu:bond_fs:om_1",
    integrationId: "feishu",
    operation,
    idempotencyKey,
    input,
  }) as WorkEffect;

const credentials = { baseUrl: "https://open.feishu.cn", token: "t-1" };

describe("Feishu integration", () => {
  it("declares its events and operations", () => {
    const integration = makeFeishuIntegration({ credentials });
    expect(integration.manifest).toEqual({
      id: "feishu",
      displayName: "Feishu",
      events: FEISHU_EVENT_TYPES,
      operations: FEISHU_OPERATIONS,
    });
  });

  it("sends text and cards to a chat with a stable uuid per Effect", async () => {
    const { impl, calls } = fakeFetch(() =>
      ok({ message_id: "om_new", chat_id: "oc_test" }),
    );
    const integration = makeFeishuIntegration({ credentials, fetch: impl });
    const result = await run(
      integration.deliver(
        effect("message.send", {
          authority: "bond_fs",
          chatId: "oc_test",
          text: "hi",
        }),
      ),
    );
    expect(result).toEqual({ providerReceipt: { messageId: "om_new" } });
    const call = calls[0]!;
    expect(call.url.toString()).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    );
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer t-1",
    );
    const body = json(call.init);
    expect(body).toMatchObject({
      receive_id: "oc_test",
      msg_type: "text",
      content: JSON.stringify({ text: "hi" }),
    });
    expect(String(body.uuid)).toMatch(/^[0-9a-f]{32}$/);

    await run(
      integration.deliver(
        effect("message.send", {
          authority: "bond_fs",
          chatId: "oc_test",
          text: "hi",
        }),
      ),
    );
    await run(
      integration.deliver(
        effect(
          "message.send",
          {
            authority: "bond_fs",
            chatId: "oc_test",
            card: feishuMarkdownCard("**hi**"),
          },
          "feishu:bond_fs:om_1:effect:1",
        ),
      ),
    );
    expect(json(calls[1]!.init).uuid).toBe(body.uuid);
    const card = json(calls[2]!.init);
    expect(card.uuid).not.toBe(body.uuid);
    expect(card.msg_type).toBe("interactive");
    expect(JSON.parse(String(card.content))).toEqual({
      schema: "2.0",
      config: { update_multi: true },
      body: { elements: [{ tag: "markdown", content: "**hi**" }] },
    });
  });

  it("replies in thread, reacts, and updates a card", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname.endsWith("/reactions")
        ? ok({ reaction_id: "r_1" })
        : ok({ message_id: "om_reply", thread_id: "omt_1" }),
    );
    const integration = makeFeishuIntegration({ credentials, fetch: impl });
    expect(
      await run(
        integration.deliver(
          effect("message.reply", {
            authority: "bond_fs",
            messageId: "om_1",
            text: "on it",
            inThread: true,
          }),
        ),
      ),
    ).toEqual({
      providerReceipt: { messageId: "om_reply", threadId: "omt_1" },
    });
    expect(calls[0]!.url.pathname).toBe("/open-apis/im/v1/messages/om_1/reply");
    expect(json(calls[0]!.init)).toMatchObject({
      msg_type: "text",
      reply_in_thread: true,
    });

    expect(
      await run(
        integration.deliver(
          effect("reaction.add", {
            authority: "bond_fs",
            messageId: "om_1",
            emoji: "THUMBSUP",
          }),
        ),
      ),
    ).toEqual({ providerReceipt: { reactionId: "r_1" } });
    expect(json(calls[1]!.init)).toEqual({
      reaction_type: { emoji_type: "THUMBSUP" },
    });

    await run(
      integration.deliver(
        effect("card.update", {
          authority: "bond_fs",
          messageId: "om_card",
          card: feishuMarkdownCard("done", { title: "Bug triage" }),
        }),
      ),
    );
    expect(calls[2]!.init.method).toBe("PATCH");
    expect(calls[2]!.url.pathname).toBe("/open-apis/im/v1/messages/om_card");
    expect(JSON.parse(String(json(calls[2]!.init).content))).toMatchObject({
      header: { title: { tag: "plain_text", content: "Bug triage" } },
    });
  });

  it("refuses malformed input before calling Feishu", async () => {
    const { impl, calls } = fakeFetch(() => ok({}));
    const integration = makeFeishuIntegration({ credentials, fetch: impl });
    const bad = async (operation: string, input: unknown) =>
      (await failure(integration.deliver(effect(operation, input)))).message;
    expect(await bad("message.delete", { authority: "a" })).toContain(
      "does not support",
    );
    expect(
      await bad("message.send", { chatId: "oc_test", text: "x" }),
    ).toContain("authority");
    expect(
      await bad("message.send", { authority: "a", chatId: "oc_test" }),
    ).toContain("exactly one of text and card");
    expect(
      await bad("message.send", {
        authority: "a",
        chatId: "oc_test",
        text: "x",
        card: {},
      }),
    ).toContain("exactly one");
    expect(
      await bad("message.send", { authority: "a", chatId: "../x", text: "x" }),
    ).toContain("chatId");
    expect(
      await bad("message.reply", {
        authority: "a",
        messageId: "om_1/../../x",
        text: "x",
      }),
    ).toContain("messageId");
    expect(
      await bad("message.send", {
        authority: "a",
        chatId: "oc_test",
        text: "x".repeat(160 * 1024),
      }),
    ).toContain("exceeds");
    expect(
      await bad("reaction.add", {
        authority: "a",
        messageId: "om_1",
        emoji: "a b",
      }),
    ).toContain("emoji_type");
    expect(calls).toHaveLength(0);
  });

  it("marks rate limits and server errors retryable, and Feishu codes on HTTP 200 as failures", async () => {
    let answer: { status: number; body?: unknown } = ok({});
    const { impl } = fakeFetch(() => answer);
    const integration = makeFeishuIntegration({ credentials, fetch: impl });
    const send = () =>
      failure(
        integration.deliver(
          effect("message.send", {
            authority: "a",
            chatId: "oc_test",
            text: "secret plan",
          }),
        ),
      );
    answer = { status: 429, body: { code: 99991400, msg: "limit" } };
    expect((await send()).retryable).toBe(true);
    answer = { status: 503 };
    expect((await send()).retryable).toBe(true);
    answer = { status: 200, body: { code: 230002, msg: "bot not in chat" } };
    const notInChat = await send();
    expect(notInChat.retryable).toBe(false);
    expect(notInChat.message).toContain("230002");
    expect(notInChat.message).not.toContain("secret plan");
  });

  it("resolves credentials per authority and rejects a non-Feishu origin", async () => {
    const seen: string[] = [];
    const { impl, calls } = fakeFetch(() => ok({ message_id: "om_x" }));
    const integration = makeFeishuIntegration({
      credentials: makeCredentialResolver(({ authority }) => {
        seen.push(authority);
        return {
          baseUrl: "https://accounts.larksuite.com",
          token: `t-${authority}`,
        };
      }),
      fetch: impl,
    });
    await run(
      integration.deliver(
        effect("message.send", {
          authority: "bond_lark",
          chatId: "oc_test",
          text: "x",
        }),
      ),
    );
    expect(seen).toEqual(["bond_lark"]);
    expect(calls[0]!.url.origin).toBe("https://open.larksuite.com");
    expect(
      (calls[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer t-bond_lark");

    const evil = makeFeishuIntegration({
      credentials: { baseUrl: "https://evil.example.com", token: "t" },
      fetch: impl,
    });
    const error = await failure(
      evil.deliver(
        effect("message.send", {
          authority: "a",
          chatId: "oc_test",
          text: "x",
        }),
      ),
    );
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
