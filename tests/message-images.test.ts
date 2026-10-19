import {
  MESSAGE_IMAGE_MAX_BYTES,
  markdownImages,
  messageImagesField,
  readMessageImageBytes,
} from "@openma/matter";
import { makeGitLabIntegration } from "@openma/matter-gitlab/bond";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { downloadFeishuMessageResource } from "../packages/feishu/src/bond/index.js";
import { makeGitHubIntegration } from "../packages/github/src/bond/index.js";
import { makeLinearIntegration } from "../packages/linear/src/bond/index.js";
import {
  downloadSlackFile,
  makeSlackIntegration,
} from "../packages/slack/src/bond/index.js";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const failure = async <A, E>(e: Effect.Effect<A, E>) => {
  const r = await Effect.runPromise(Effect.either(e));
  if (Either.isRight(r)) throw new Error("expected a failure");
  return r.left as unknown as { message: string; retryable: boolean };
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Call = { url: URL; init: RequestInit };
const fakeFetch = (handler: (url: URL) => Response) => {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url);
  }) as typeof fetch;
  return { impl, calls };
};
const auth = (c: Call) => new Headers(c.init.headers).get("authorization");

describe("message images (core)", () => {
  it("finds markdown and HTML images in order, with alt text as the name", () => {
    expect(
      markdownImages(
        'see <img width="300" alt="Screenshot" src="https://github.com/user-attachments/assets/a1"> and ' +
          '![](/uploads/abc/b.png) then ![diagram](<https://x.test/c.png> "title") and [link](https://x.test)',
      ),
    ).toEqual([
      {
        id: "https://github.com/user-attachments/assets/a1",
        name: "Screenshot",
      },
      { id: "/uploads/abc/b.png" },
      { id: "https://x.test/c.png", name: "diagram" },
    ]);
    expect(markdownImages("no images here")).toEqual([]);
  });

  it("puts images on a payload only when there are any, once per id", () => {
    expect(messageImagesField([])).toEqual({});
    expect(
      messageImagesField([
        { id: "a", mimeType: "image/png" },
        { id: "a" },
        { id: "" },
        { id: "b", name: "b.jpg" },
      ]),
    ).toEqual({
      images: [
        { id: "a", mimeType: "image/png" },
        { id: "b", name: "b.jpg" },
      ],
    });
  });

  it("reads a body up to the cap and refuses one past it", async () => {
    expect(MESSAGE_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(await readMessageImageBytes(new Response(PNG), 7)).toEqual(PNG);
    expect(await readMessageImageBytes(new Response(PNG), 6)).toBeUndefined();
    // A declared length over the cap is refused before reading.
    const declared = new Response(PNG, {
      headers: { "content-length": String(MESSAGE_IMAGE_MAX_BYTES + 1) },
    });
    expect(await readMessageImageBytes(declared)).toBeUndefined();
  });
});

describe("downloadFeishuMessageResource", () => {
  const credentials = { baseUrl: "https://open.feishu.cn", token: "t-bot" };

  it("downloads an image with the tenant token", async () => {
    const { impl, calls } = fakeFetch(
      () =>
        new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const resource = await run(
      downloadFeishuMessageResource({
        credentials,
        messageId: "om_1",
        fileKey: "img_v3_a",
        fetch: impl,
      }),
    );
    expect(resource).toEqual({ bytes: PNG, contentType: "image/png" });
    expect(calls[0]!.url.toString()).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_v3_a?type=image",
    );
    expect(auth(calls[0]!)).toBe("Bearer t-bot");
  });

  it("fails on a JSON error body, a non-2xx answer, and an oversize body", async () => {
    const jsonError = fakeFetch(() =>
      Response.json({ code: 234003, msg: "File not in msg." }),
    );
    const e1 = await failure(
      downloadFeishuMessageResource({
        credentials,
        messageId: "om_1",
        fileKey: "img_x",
        fetch: jsonError.impl,
      }),
    );
    expect(e1.message).toContain("code 234003");
    expect(e1.message).not.toContain("File not in msg");
    expect(e1.retryable).toBe(false);

    const server = fakeFetch(() => new Response("oops", { status: 503 }));
    const e2 = await failure(
      downloadFeishuMessageResource({
        credentials,
        messageId: "om_1",
        fileKey: "img_x",
        fetch: server.impl,
      }),
    );
    expect(e2.message).toContain("HTTP 503");
    expect(e2.retryable).toBe(true);

    const big = fakeFetch(
      () =>
        new Response(new Uint8Array(64), {
          headers: { "content-type": "image/png" },
        }),
    );
    const e3 = await failure(
      downloadFeishuMessageResource({
        credentials,
        messageId: "om_1",
        fileKey: "img_x",
        fetch: big.impl,
        maxBytes: 32,
      }),
    );
    expect(e3.message).toContain("larger than 32 bytes");
    expect(e3.retryable).toBe(false);

    const bad = await failure(
      downloadFeishuMessageResource({
        credentials: { baseUrl: "https://example.com", token: "t" },
        messageId: "om_1",
        fileKey: "img_x",
        fetch: big.impl,
      }),
    );
    expect(bad.retryable).toBe(false);
    expect(big.calls).toHaveLength(1);
  });
});

describe("Slack images", () => {
  const slack = makeSlackIntegration({
    botToken: "xoxb-test",
    botUserId: "BCLAUDE",
    clock: () => "2026-08-20T10:00:00.000Z",
    fetch: async () => new Response(JSON.stringify({ ok: true })),
  });
  const envelope = (event: Record<string, unknown>) => ({
    type: "event_callback",
    team_id: "TWORK",
    event_id: "Ev01",
    event_time: 1724140800,
    event: {
      user: "U01",
      ts: "1724140800.123456",
      channel: "C01",
      event_ts: "1724140800.123456",
      ...event,
    },
  });
  const image = {
    id: "F01",
    name: "screen.png",
    mimetype: "image/png",
    url_private: "https://files.slack.com/files-pri/T-F01/screen.png",
  };
  const pdf = { id: "F02", name: "spec.pdf", mimetype: "application/pdf" };

  it("turns a file_share DM without text into a message with images", async () => {
    const input = envelope({
      type: "message",
      subtype: "file_share",
      channel: "D01",
      channel_type: "im",
      files: [image, pdf],
    });
    const [event] = await run(slack.integration.ingest(input));
    expect(event!.type).toBe("slack.message.received");
    expect(event!.payload).toMatchObject({
      activation: "direct",
      surface: "dm",
      text: "",
      prompt: "",
      images: [{ id: "F01", mimeType: "image/png", name: "screen.png" }],
    });
    // The raw event is not rewritten.
    expect(event!.raw).toEqual(input);
  });

  it("keeps images next to the text of a mention", async () => {
    const [event] = await run(
      slack.integration.ingest(
        envelope({
          type: "app_mention",
          text: "<@BCLAUDE> what is wrong here?",
          files: [image],
        }),
      ),
    );
    expect(event!.type).toBe("slack.message.mentioned");
    expect(event!.payload).toMatchObject({
      prompt: "what is wrong here?",
      images: [{ id: "F01" }],
    });
  });

  it("still treats other subtypes, and file_share without an image and text, as before", async () => {
    const [joined] = await run(
      slack.integration.ingest(
        envelope({ type: "message", subtype: "channel_join", text: "joined" }),
      ),
    );
    expect(joined!.type).toBe("slack.event.received");
    await expect(
      run(
        slack.integration.ingest(
          envelope({
            type: "message",
            subtype: "file_share",
            channel_type: "im",
            files: [pdf],
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("downloads a file through files.info with the bot token, only from files.slack.com", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.hostname === "slack.com"
        ? Response.json({ ok: true, file: image })
        : new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    const credentials = { botToken: "xoxb-test", botUserId: "BCLAUDE" };
    expect(
      await run(downloadSlackFile({ credentials, fileId: "F01", fetch: impl })),
    ).toEqual({ bytes: PNG, contentType: "image/png" });
    expect(calls.map((c) => c.url.origin + c.url.pathname)).toEqual([
      "https://slack.com/api/files.info",
      "https://files.slack.com/files-pri/T-F01/screen.png",
    ]);
    expect(calls.every((c) => auth(c) === "Bearer xoxb-test")).toBe(true);

    const elsewhere = fakeFetch(() => new Response(PNG));
    const e1 = await failure(
      downloadSlackFile({
        credentials,
        fileId: "F01",
        url: "https://attacker.test/x.png",
        fetch: elsewhere.impl,
      }),
    );
    expect(e1.message).toContain("files.slack.com");
    expect(elsewhere.calls).toEqual([]);

    // Slack serves a login page when the token cannot read the file.
    const login = fakeFetch(
      () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const e2 = await failure(
      downloadSlackFile({
        credentials,
        fileId: "F01",
        url: image.url_private,
        fetch: login.impl,
      }),
    );
    expect(e2.message).toContain("text/html");

    const big = fakeFetch(
      () =>
        new Response(new Uint8Array(64), {
          headers: { "content-type": "image/png" },
        }),
    );
    const e3 = await failure(
      downloadSlackFile({
        credentials,
        fileId: "F01",
        url: image.url_private,
        fetch: big.impl,
        maxBytes: 32,
      }),
    );
    expect(e3.message).toContain("larger than 32 bytes");
  });
});

describe("markdown images on comments", () => {
  it("GitHub: images of an issue comment body", async () => {
    const github = makeGitHubIntegration({
      token: "installation-token",
      clock: () => "2026-08-23T10:00:00.000Z",
      fetch: async () => new Response("{}"),
    });
    const [event] = await run(
      github.integration.ingest({
        kind: "github.webhook",
        eventName: "issue_comment",
        deliveryId: "d-img",
        payload: {
          action: "created",
          installation: { id: 9001 },
          repository: { id: 101, full_name: "openma-ai/OpenMatter" },
          issue: { id: 4200, number: 42 },
          comment: {
            id: 77,
            body: '<img alt="shot" src="https://github.com/user-attachments/assets/a1">',
          },
          sender: { id: 7, login: "octocat" },
        },
      }),
    );
    expect(event!.payload).toMatchObject({
      images: [
        { id: "https://github.com/user-attachments/assets/a1", name: "shot" },
      ],
    });
  });

  it("GitLab: note uploads resolve against the project URL", async () => {
    const [event] = await run(
      makeGitLabIntegration({
        credentials: { baseUrl: "https://gitlab.example.com", token: "t" },
        clock: () => "2026-08-23T08:00:05.000Z",
      }).ingest({
        kind: "gitlab.webhook",
        authority: "bond_1",
        eventName: "Note Hook",
        deliveryId: "delivery-img",
        payload: {
          object_kind: "note",
          event_type: "note",
          user: { id: 7, username: "alice", name: "Alice" },
          project_id: 42,
          project: {
            id: 42,
            path_with_namespace: "platform/api",
            web_url: "https://gitlab.example.com/platform/api",
          },
          object_attributes: {
            id: 555,
            note: "![image](/uploads/0a1b/image.png)",
            noteable_type: "MergeRequest",
            system: false,
          },
          merge_request: { id: 9001, iid: 7 },
        },
      }),
    );
    expect(event!.payload).toMatchObject({
      images: [
        {
          id: "https://gitlab.example.com/platform/api/uploads/0a1b/image.png",
          name: "image",
        },
      ],
    });
  });

  it("Linear: images of a comment body", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
    });
    const [event] = await run(
      linear.integration.ingest({
        kind: "linear.webhook" as const,
        deliveryId: "delivery-img",
        eventName: "Comment",
        timestamp: "1787479198000",
        payload: {
          type: "Comment",
          action: "create",
          createdAt: "2026-08-23T09:59:58.000Z",
          organizationId: "org-1",
          webhookId: "webhook-1",
          webhookTimestamp: 1787479198000,
          data: {
            id: "comment-3",
            issueId: "issue-1",
            body: "![x.png](https://uploads.linear.app/a/b/x.png)",
          },
        },
      }),
    );
    expect(event!.payload).toMatchObject({
      images: [{ id: "https://uploads.linear.app/a/b/x.png", name: "x.png" }],
    });
  });
});
