import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  FEISHU_EVENT_TYPES,
  decodeFeishuHttpRequest,
  decryptFeishuPayload,
  feishuSignature,
  makeFeishuHttpEndpoint,
  normalizeFeishuEvents,
  type FeishuEventInput,
} from "../packages/feishu/src/bond/index.js";

const ENCRYPT_KEY = "test-encrypt-key";
const TOKEN = "test-verification-token";
const APP_ID = "cli_test_app";
const BOT = "ou_bot";
const NOW_S = 1_792_000_000;
const nowMs = () => NOW_S * 1000;
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

const encrypt = async (plain: string, key = ENCRYPT_KEY): Promise<string> => {
  const raw = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      new TextEncoder().encode(plain),
    ),
  );
  const all = new Uint8Array(16 + cipher.length);
  all.set(iv);
  all.set(cipher, 16);
  return btoa(String.fromCharCode(...all));
};

const envelope = (
  eventType: string,
  event: unknown,
  head: Record<string, unknown> = {},
) => ({
  schema: "2.0",
  header: {
    event_id: "ev_1",
    event_type: eventType,
    create_time: "1792000000000",
    token: TOKEN,
    app_id: APP_ID,
    tenant_key: "tk_test",
    ...head,
  },
  event,
});

const signedRequest = async (
  payload: unknown,
  opts: {
    readonly timestamp?: string;
    readonly signature?: string;
    readonly key?: string;
  } = {},
) => {
  const body = JSON.stringify({
    encrypt: await encrypt(JSON.stringify(payload), opts.key),
  });
  const timestamp = opts.timestamp ?? String(NOW_S);
  const nonce = "n1";
  const signature =
    opts.signature ??
    (await feishuSignature({
      timestamp,
      nonce,
      encryptKey: ENCRYPT_KEY,
      body,
    }));
  return new Request("https://oma.example.com/feishu/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
    body,
  });
};

const options = {
  authority: "bond_fs",
  appId: APP_ID,
  encryptKey: ENCRYPT_KEY,
  verificationToken: TOKEN,
  botOpenId: BOT,
  nowMs,
};

const decodeError = async (request: Request, opts = options) => {
  const result = await run(
    Effect.either(decodeFeishuHttpRequest(request, opts)),
  );
  if (Either.isRight(result)) throw new Error("expected a failure");
  return result.left;
};

const textMessage = (overrides: Record<string, unknown> = {}) => ({
  sender: {
    sender_id: { open_id: "ou_alice", union_id: "on_alice" },
    sender_type: "user",
    tenant_key: "tk_test",
  },
  message: {
    message_id: "om_1",
    chat_id: "oc_test",
    chat_type: "group",
    message_type: "text",
    create_time: "1792000001000",
    content: JSON.stringify({ text: "@_user_1 review this @_user_2" }),
    mentions: [
      { key: "@_user_1", id: { open_id: BOT }, name: "OMA Bot" },
      { key: "@_user_2", id: { open_id: "ou_bob" }, name: "Bob" },
    ],
    ...overrides,
  },
});

describe("Feishu webhook decryption and signatures", () => {
  it("decrypts AES-256-CBC payloads keyed by sha256 of the encrypt key", async () => {
    const plain = JSON.stringify({ hello: "飞书" });
    expect(await decryptFeishuPayload(await encrypt(plain), ENCRYPT_KEY)).toBe(
      plain,
    );
    await expect(
      decryptFeishuPayload(await encrypt(plain, "other-key"), ENCRYPT_KEY),
    ).rejects.toThrow();
  });

  it("signs timestamp, nonce, encrypt key, and raw body with sha256 hex", async () => {
    const sig = await feishuSignature({
      timestamp: "1",
      nonce: "n",
      encryptKey: "k",
      body: "{}",
    });
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("1nk{}"),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    expect(sig).toBe(expected);
  });

  it("answers an unsigned URL verification that decrypts and carries the token", async () => {
    const body = JSON.stringify({
      encrypt: await encrypt(
        JSON.stringify({
          type: "url_verification",
          challenge: "ch-1",
          token: TOKEN,
        }),
      ),
    });
    const endpoint = makeFeishuHttpEndpoint({
      ...options,
      submit: async () => {
        throw new Error("a challenge is never submitted");
      },
    });
    const response = await endpoint.handle(
      new Request("https://oma.example.com/feishu/events", {
        method: "POST",
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "ch-1" });

    const wrong = JSON.stringify({
      encrypt: await encrypt(
        JSON.stringify({
          type: "url_verification",
          challenge: "ch-1",
          token: "nope",
        }),
      ),
    });
    const refused = await endpoint.handle(
      new Request("https://oma.example.com/feishu/events", {
        method: "POST",
        body: wrong,
      }),
    );
    expect(refused.status).toBe(401);
  });

  it("decodes a signed event for this app", async () => {
    const decoded = await run(
      decodeFeishuHttpRequest(
        await signedRequest(envelope("im.message.receive_v1", textMessage())),
        options,
      ),
    );
    expect(decoded).toMatchObject({
      kind: "feishu.event",
      authority: "bond_fs",
      transport: "webhook",
      botOpenId: BOT,
    });
  });

  it("refuses plaintext, bad signatures, stale timestamps, other apps, and wrong tokens", async () => {
    const event = envelope("im.message.receive_v1", textMessage());
    const plaintext = new Request("https://oma.example.com/feishu/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
    expect((await decodeError(plaintext)).status).toBe(401);
    expect(
      (await decodeError(await signedRequest(event, { signature: "00" })))
        .message,
    ).toContain("signature");
    expect(
      (
        await decodeError(
          await signedRequest(event, { timestamp: String(NOW_S - 301) }),
        )
      ).message,
    ).toContain("stale");
    expect(
      (
        await decodeError(
          await signedRequest(
            envelope("im.message.receive_v1", textMessage(), {
              app_id: "cli_other",
            }),
          ),
        )
      ).message,
    ).toContain("another app");
    expect(
      (
        await decodeError(
          await signedRequest(
            envelope("im.message.receive_v1", textMessage(), { token: "x" }),
          ),
        )
      ).message,
    ).toContain("token");
    expect(
      (await decodeError(await signedRequest(event, { key: "other-key" })))
        .message,
    ).toContain("decrypt");
    expect(
      (
        await decodeError(await signedRequest(event), {
          ...options,
          encryptKey: "",
        })
      ).status,
    ).toBe(401);
  });

  it("acks only after submit resolves, and asks Feishu to retry when it fails", async () => {
    const submitted: FeishuEventInput[] = [];
    const ok = makeFeishuHttpEndpoint({
      ...options,
      submit: async (input) => {
        submitted.push(input);
      },
    });
    const response = await ok.handle(
      await signedRequest(envelope("im.message.receive_v1", textMessage())),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(submitted).toHaveLength(1);

    const failing = makeFeishuHttpEndpoint({
      ...options,
      submit: async () => {
        throw new Error("inbox down");
      },
    });
    const retry = await failing.handle(
      await signedRequest(envelope("im.message.receive_v1", textMessage())),
    );
    expect(retry.status).toBe(503);
  });

  it("answers a card action with the configured static response", async () => {
    const endpoint = makeFeishuHttpEndpoint({
      ...options,
      cardActionResponse: { toast: { type: "info", content: "Queued" } },
      submit: async () => undefined,
    });
    const response = await endpoint.handle(
      await signedRequest(
        envelope("card.action.trigger", {
          operator: { open_id: "ou_alice" },
          action: { tag: "button", value: { choice: "approve" } },
          context: { open_chat_id: "oc_test", open_message_id: "om_card" },
        }),
      ),
    );
    expect(await response.json()).toEqual({
      toast: { type: "info", content: "Queued" },
    });
  });
});

type Extra = { readonly botOpenId?: string | undefined };
const input = (env: unknown, extra: Extra = {}): FeishuEventInput => {
  const botOpenId = "botOpenId" in extra ? extra.botOpenId : BOT;
  return {
    kind: "feishu.event",
    authority: "bond_fs",
    transport: "long_connection",
    ...(botOpenId === undefined ? {} : { botOpenId }),
    envelope: env as FeishuEventInput["envelope"],
  };
};
const clock = () => "2026-10-16T00:00:00.000Z";
const one = async (env: unknown, extra: Extra = {}) => {
  const events = await run(normalizeFeishuEvents(input(env, extra), clock));
  expect(events).toHaveLength(1);
  return events[0]!;
};

describe("Feishu event normalization", () => {
  it("turns a group @mention of the bot into a mention keyed by message_id", async () => {
    const event = await one(envelope("im.message.receive_v1", textMessage()));
    expect(event).toMatchObject({
      id: "feishu:bond_fs:om_1",
      idempotencyKey: "feishu:bond_fs:om_1",
      type: "feishu.message.mentioned",
      source: {
        provider: "feishu",
        authority: "bond_fs",
        conversationId: "oc_test",
        threadId: "om_1",
        messageId: "om_1",
      },
      payload: {
        activation: "mention",
        surface: "group",
        resource: "chat:oc_test",
        text: "@_user_1 review this @_user_2",
        prompt: "review this @Bob",
        sender: { openId: "ou_alice", unionId: "on_alice" },
        eventType: "im.message.receive_v1",
        transport: "long_connection",
      },
    });
    expect(event.occurredAt).toBe(new Date(1_792_000_001_000).toISOString());
    expect(JSON.stringify(event.raw)).not.toContain(TOKEN);
  });

  it("keeps the same id when Feishu redelivers a message under a new event id", async () => {
    const a = await one(envelope("im.message.receive_v1", textMessage()));
    const b = await one(
      envelope("im.message.receive_v1", textMessage(), { event_id: "ev_2" }),
    );
    expect(b.id).toBe(a.id);
  });

  it("classifies p2p as direct, other group messages as observations, and threads by root", async () => {
    const direct = await one(
      envelope(
        "im.message.receive_v1",
        textMessage({
          chat_type: "p2p",
          mentions: [],
          content: JSON.stringify({ text: "hi" }),
        }),
      ),
    );
    expect(direct.type).toBe("feishu.message.mentioned");
    expect(direct.payload).toMatchObject({
      activation: "direct",
      prompt: "hi",
    });

    const observed = await one(
      envelope(
        "im.message.receive_v1",
        textMessage({ mentions: [], root_id: "om_root" }),
      ),
    );
    expect(observed.type).toBe("feishu.message.received");
    expect(observed.payload).toMatchObject({ activation: "observation" });
    expect(observed.source.threadId).toBe("om_root");

    const withoutBotId = await one(
      envelope("im.message.receive_v1", textMessage()),
      { botOpenId: undefined },
    );
    expect(withoutBotId.type).toBe("feishu.message.received");
  });

  it("flattens rich text posts", async () => {
    const event = await one(
      envelope(
        "im.message.receive_v1",
        textMessage({
          message_type: "post",
          mentions: [],
          content: JSON.stringify({
            title: "Release",
            content: [
              [
                { tag: "text", text: "ship " },
                { tag: "a", text: "v1", href: "https://example.com" },
              ],
              [{ tag: "img", image_key: "img_1" }],
            ],
          }),
        }),
      ),
    );
    expect(event.payload).toMatchObject({ text: "Release\nship v1" });
  });

  it("carries the images of an image message and of a post", async () => {
    const image = await one(
      envelope(
        "im.message.receive_v1",
        textMessage({
          message_type: "image",
          chat_type: "p2p",
          mentions: [],
          content: JSON.stringify({ image_key: "img_v3_alone" }),
        }),
      ),
    );
    expect(image.type).toBe("feishu.message.mentioned");
    expect(image.payload).toMatchObject({
      messageType: "image",
      images: [{ id: "img_v3_alone" }],
    });
    // An image alone has no text and no prompt.
    expect(image.payload).not.toHaveProperty("text");
    expect(image.payload).not.toHaveProperty("prompt");

    const post = await one(
      envelope(
        "im.message.receive_v1",
        textMessage({
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "",
              content: [
                [
                  { tag: "at", user_id: "@_user_1", user_name: "OMA Bot" },
                  { tag: "text", text: " what is this?" },
                ],
                [
                  { tag: "img", image_key: "img_a" },
                  { tag: "img", image_key: "img_b" },
                  { tag: "img", image_key: "img_a" },
                ],
              ],
            },
          }),
        }),
      ),
    );
    expect(post.payload).toMatchObject({
      images: [{ id: "img_a" }, { id: "img_b" }],
    });
    expect(post.payload).toMatchObject({
      prompt: expect.stringContaining("what is this?"),
    });

    const plain = await one(envelope("im.message.receive_v1", textMessage()));
    expect(plain.payload).not.toHaveProperty("images");
  });

  it("normalizes recalls, reactions, bot membership, menus, and card actions", async () => {
    expect(
      (
        await one(
          envelope("im.message.recalled_v1", {
            message_id: "om_1",
            chat_id: "oc_test",
            recall_time: "1792000002000",
          }),
        )
      ).id,
    ).toBe("feishu:bond_fs:event:ev_1");
    const reaction = await one(
      envelope("im.message.reaction.created_v1", {
        message_id: "om_1",
        reaction_type: { emoji_type: "THUMBSUP" },
        operator_type: "user",
        user_id: { open_id: "ou_alice" },
      }),
    );
    expect(reaction).toMatchObject({
      type: "feishu.reaction.added",
      payload: { emoji: "THUMBSUP", operator: { openId: "ou_alice" } },
    });
    expect(
      (
        await one(
          envelope("im.chat.member.bot.deleted_v1", {
            chat_id: "oc_test",
            name: "Frontend",
          }),
        )
      ).type,
    ).toBe("feishu.chat.bot_removed");
    const menu = await one(
      envelope("application.bot.menu_v6", {
        event_key: "daily_summary",
        operator: { operator_id: { open_id: "ou_alice" } },
      }),
    );
    expect(menu.payload).toMatchObject({
      activation: "command",
      eventKey: "daily_summary",
    });
    const card = await one(
      envelope("card.action.trigger", {
        token: "card-update-token",
        operator: { open_id: "ou_alice" },
        action: { tag: "button", value: { choice: "approve" } },
        context: { open_chat_id: "oc_test", open_message_id: "om_card" },
      }),
    );
    expect(card).toMatchObject({
      type: "feishu.card.action",
      source: { conversationId: "oc_test", messageId: "om_card" },
      payload: { activation: "action", value: { choice: "approve" } },
    });
    expect(JSON.stringify(card.raw)).not.toContain("card-update-token");
  });

  it("passes other events through and ignores foreign input", async () => {
    const other = await one(
      envelope("drive.file.edit_v1", { file_token: "doc_1" }),
    );
    expect(other).toMatchObject({
      type: "feishu.event.received",
      payload: { eventType: "drive.file.edit_v1" },
    });
    expect(
      await run(normalizeFeishuEvents({ kind: "gitlab.webhook" }, clock)),
    ).toEqual([]);
    for (const type of [
      "feishu.message.mentioned",
      "feishu.card.action",
      "feishu.event.received",
    ]) {
      expect(FEISHU_EVENT_TYPES).toContain(type);
    }
  });
});
