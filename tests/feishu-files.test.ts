import type { WorkEffect } from "@openma/matter";
import { staticCredentialResolver } from "@openma/matter/credentials";
import { IntegrationError } from "@openma/matter/integration";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeFeishuIntegration } from "../packages/feishu/src/bond/index.js";

const credentials = {
  baseUrl: "https://open.feishu.cn",
  token: "tenant-secret",
};
const bytes = new TextEncoder().encode("<!doctype html><h1>文件</h1>");
const resource = {
  authority: "app",
  filename: "example.html",
  mimeType: "text/html",
  bytes,
};
const effect = (
  operation: string,
  input: WorkEffect["input"],
  key = "abc",
): WorkEffect => ({
  schemaVersion: "0.1",
  id: key,
  eventId: "event",
  integrationId: "feishu",
  operation,
  input,
  idempotencyKey: key,
});
const response = (data: unknown, status = 200, code = 0) =>
  new Response(JSON.stringify({ code, msg: "private provider body", data }), {
    status,
  });
const uploaded = () => response({ file_key: "file_key_1" });
const replied = () =>
  response({ message_id: "om_reply", thread_id: "omt_topic" });
const remote = (...answers: (Response | Error)[]) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(new Request(url, init));
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("Unexpected request");
    return answer;
  };
  return { fetch, requests };
};
const run = <A>(operation: Effect.Effect<A, IntegrationError>) =>
  Effect.runPromise(operation);
const failure = async (operation: Effect.Effect<unknown, IntegrationError>) => {
  const result = await Effect.runPromise(Effect.either(operation));
  if (result._tag === "Right") throw new Error("Expected IntegrationError");
  return result.left;
};

// Break caught: ignoring the trusted resolver, multipart metadata, or typed-array view corrupts the actual uploaded file.
describe("Feishu file operations", () => {
  it.each([
    ["message.reply", { messageId: "om_" }, "abc"],
    ["message.send", { chatId: "oc_" }, "abc"],
    ["message.reply", { messageId: "om_root" }, " "],
  ] as const)(
    "rejects invalid file delivery target/key (%s, %j)",
    async (operation, target, key) => {
      const server = remote(replied());
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
      });
      expect(
        await failure(
          integration.deliver(
            effect(
              operation,
              {
                authority: "app",
                ...target,
                file: { authority: "app", fileKey: "file_key_1" },
              },
              key,
            ),
          ),
        ),
      ).toMatchObject({ effectState: "not-applied" });
      expect(server.requests).toHaveLength(0);
    },
  );

  it("fails closed when no trusted resolver is configured", async () => {
    const server = remote();
    const integration = makeFeishuIntegration({
      credentials,
      fetch: server.fetch,
    });
    expect(
      await failure(
        integration.deliver(
          effect("file.upload", { authority: "app", resourceId: "artifact" }),
        ),
      ),
    ).toMatchObject({ effectState: "not-applied", retryable: false });
    expect(server.requests).toHaveLength(0);
  });

  it.each(["", "not json", '{"code":0,"data":{"file_key":" "}}'])(
    "never confirms malformed upload response %j",
    async (body) => {
      const server = remote(new Response(body));
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => resource },
      });
      expect(
        await failure(
          integration.deliver(
            effect("file.upload", { authority: "app", resourceId: "artifact" }),
          ),
        ),
      ).toMatchObject({ effectState: "unknown", retryable: false });
      expect(server.requests).toHaveLength(1);
    },
  );

  it.each(["", "om_", "om_reply\n", "oc_chat"])(
    "never confirms an invalid message receipt %j",
    async (messageId) => {
      const server = remote(response({ message_id: messageId }));
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
      });
      expect(
        await failure(
          integration.deliver(
            effect("message.reply", {
              authority: "app",
              messageId: "om_root",
              file: { authority: "app", fileKey: "file_key_1" },
            }),
          ),
        ),
      ).toMatchObject({ effectState: "unknown", retryable: false });
      expect(server.requests).toHaveLength(1);
    },
  );
  it.each([
    ["example.html", "text/html"],
    ["archive.zip", "application/zip"],
  ])(
    "uploads trusted %s bytes through file.upload",
    async (filename, mimeType) => {
      const server = remote(uploaded());
      const seen: unknown[] = [];
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: {
          resolve: (request) => {
            seen.push(request);
            return { ...resource, filename, mimeType };
          },
        },
      });
      const call = effect("file.upload", {
        authority: "app",
        resourceId: "artifact-1",
      });
      expect(await run(integration.deliver(call))).toEqual({
        providerReceipt: { authority: "app", fileKey: "file_key_1" },
      });
      expect(seen).toEqual([
        { authority: "app", resourceId: "artifact-1", effect: call },
      ]);
      const request = server.requests[0]!;
      expect(request.url).toBe("https://open.feishu.cn/open-apis/im/v1/files");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("Bearer tenant-secret");
      expect(request.headers.get("content-type")).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      const form = await request.formData();
      expect(form.get("file_type")).toBe("stream");
      expect(form.get("file_name")).toBe(filename);
      const file = form.get("file") as File;
      expect(file.name).toBe(filename);
      expect(file.type).toBe(mimeType);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      expect(server.requests).toHaveLength(1);
    },
  );

  // Break caught: a file reply bypassing normal delivery loses target/thread binding or provider UUID deduplication.
  it.each(["message.send", "message.reply"])(
    "delivers an existing fileKey via %s without uploading",
    async (operation) => {
      const server = remote(replied(), replied());
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
      });
      const call = effect(operation, {
        authority: "app",
        ...(operation === "message.send"
          ? { chatId: "oc_chat" }
          : { messageId: "om_root", inThread: true }),
        file: { authority: "app", fileKey: "file_key_1" },
      });
      expect(await run(integration.deliver(call))).toEqual({
        providerReceipt: {
          messageId: "om_reply",
          threadId: "omt_topic",
          fileKey: "file_key_1",
        },
      });
      await run(integration.deliver(call));
      for (const request of server.requests) {
        expect(request.url).toContain(
          operation === "message.send"
            ? "/im/v1/messages?receive_id_type=chat_id"
            : "/im/v1/messages/om_root/reply",
        );
        expect(await request.json()).toMatchObject({
          msg_type: "file",
          content: '{"file_key":"file_key_1"}',
          uuid: "ba7816bf8f01cfea414140de5dae2223",
          ...(operation === "message.reply" ? { reply_in_thread: true } : {}),
        });
      }
    },
  );

  it("rejects a file from a different authority before resolving credentials", async () => {
    const server = remote();
    const integration = makeFeishuIntegration({
      credentials,
      fetch: server.fetch,
    });
    const error = await failure(
      integration.deliver(
        effect("message.reply", {
          authority: "app",
          messageId: "om_root",
          file: { authority: "other", fileKey: "file_key_1" },
        }),
      ),
    );
    expect(error.effectState).toBe("not-applied");
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    { bytes: "https://untrusted.test/file" },
    { url: "https://untrusted.test/file" },
    { token: "override" },
    { credentials },
  ])("rejects caller-supplied upload data %j", async (extra) => {
    const server = remote();
    let resolved = false;
    const integration = makeFeishuIntegration({
      credentials,
      fetch: server.fetch,
      files: {
        resolve: () => {
          resolved = true;
          return resource;
        },
      },
    });
    expect(
      (
        await failure(
          integration.deliver(
            effect("file.upload", {
              authority: "app",
              resourceId: "artifact-1",
              ...extra,
            }),
          ),
        )
      ).effectState,
    ).toBe("not-applied");
    expect(resolved).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    { filename: "../file.html" },
    { filename: ".html" },
    { filename: "file.HTML" },
    { filename: "file%20.html" },
    { filename: "file.html\n" },
    { mimeType: "application/json" },
    { filename: "file.zip", mimeType: "text/html" },
    { bytes: new Uint8Array() },
    { bytes: new Uint8Array(5 * 1024 * 1024 + 1) },
    { authority: "other" },
  ])(
    "validates trusted resource metadata before upload (%#)",
    async (extra) => {
      const server = remote();
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => ({ ...resource, ...extra }) },
      });
      const error = await failure(
        integration.deliver(
          effect("file.upload", { authority: "app", resourceId: "artifact-1" }),
        ),
      );
      expect(error.effectState).toBe("not-applied");
      expect(error.retryable).toBe(false);
      expect(server.requests).toHaveLength(0);
    },
  );

  it.each([null, undefined, "not a resource"])(
    "rejects an invalid resolver result (%j) without a defect",
    async (value) => {
      const server = remote();
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => value as never },
      });
      expect(
        (
          await failure(
            integration.deliver(
              effect("file.upload", {
                authority: "app",
                resourceId: "artifact",
              }),
            ),
          )
        ).effectState,
      ).toBe("not-applied");
      expect(server.requests).toHaveLength(0);
    },
  );

  it("uses the existing credential binding for upload", async () => {
    const server = remote();
    const integration = makeFeishuIntegration({
      credentials: staticCredentialResolver(credentials, {
        integrationId: "feishu",
        authority: "other",
      }),
      fetch: server.fetch,
      files: { resolve: () => resource },
    });
    expect(
      (
        await failure(
          integration.deliver(
            effect("file.upload", {
              authority: "app",
              resourceId: "artifact-1",
            }),
          ),
        )
      ).retryable,
    ).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it("uploads exactly the typed-array view at the size limit", async () => {
    const server = remote(uploaded());
    const buffer = new Uint8Array(5 * 1024 * 1024 + 2).fill(7);
    buffer[0] = 1;
    buffer[buffer.length - 1] = 2;
    const integration = makeFeishuIntegration({
      credentials,
      fetch: server.fetch,
      files: {
        resolve: () => ({ ...resource, bytes: buffer.subarray(1, -1) }),
      },
    });
    await run(
      integration.deliver(
        effect("file.upload", { authority: "app", resourceId: "artifact" }),
      ),
    );
    const file = (await server.requests[0]!.formData()).get("file") as File;
    expect(file.size).toBe(5 * 1024 * 1024);
    expect(
      new Uint8Array(await file.arrayBuffer()).every((value) => value === 7),
    ).toBe(true);
  });

  describe.each(["file.upload", "message.reply"])(
    "%s provider failures",
    (operation) => {
      it.each([
        [400, 234001, false],
        [401, 99991663, false],
        [403, 99991672, false],
        [302, undefined, false],
        [429, undefined, true],
        [503, undefined, true],
        [200, 99991400, true],
        [200, 20050, true],
        [200, 20072, true],
        [200, 99991672, false],
      ] as const)(
        "classifies HTTP %s / code %s without retry",
        async (status, code, retryable) => {
          const server = remote(
            new Response(
              JSON.stringify({
                code,
                msg: "private tenant-secret",
                data: null,
              }),
              { status },
            ),
          );
          const integration = makeFeishuIntegration({
            credentials,
            fetch: server.fetch,
            files: { resolve: () => resource },
          });
          const input =
            operation === "file.upload"
              ? { authority: "app", resourceId: "artifact" }
              : {
                  authority: "app",
                  messageId: "om_root",
                  file: { authority: "app", fileKey: "file_key_1" },
                };
          const error = await failure(
            integration.deliver(effect(operation, input)),
          );
          expect(error.retryable).toBe(retryable);
          expect(JSON.stringify(error)).not.toContain("tenant-secret");
          expect(server.requests).toHaveLength(1);
        },
      );
    },
  );

  it.each([undefined, "1", "65537"])(
    "bounds the upload response, including dishonest content-length %s",
    async (declared) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const server = remote(
        new Response(body, {
          headers: declared === undefined ? {} : { "content-length": declared },
        }),
      );
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => resource },
      });
      await failure(
        integration.deliver(
          effect("file.upload", { authority: "app", resourceId: "artifact" }),
        ),
      );
      expect(cancelled).toBe(true);
      expect(server.requests).toHaveLength(1);
    },
  );

  // Break caught: treating missing provider receipts as delivered falsely confirms an unobservable side effect.
  it.each(["file.upload", "message.reply"])(
    "does not confirm %s when its receipt is missing",
    async (operation) => {
      const server = remote(response({}));
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => resource },
      });
      const input =
        operation === "file.upload"
          ? { authority: "app", resourceId: "artifact-1" }
          : {
              authority: "app",
              messageId: "om_root",
              file: { authority: "app", fileKey: "file_key_1" },
            };
      const error = await failure(
        integration.deliver(effect(operation, input)),
      );
      expect(error.effectState).toBe("unknown");
      expect(server.requests).toHaveLength(1);
    },
  );

  it.each(["file.upload", "message.reply"])(
    "does not internally retry %s after losing its response",
    async (operation) => {
      const server = remote(new Error("private tenant-secret"));
      const integration = makeFeishuIntegration({
        credentials,
        fetch: server.fetch,
        files: { resolve: () => resource },
      });
      const input =
        operation === "file.upload"
          ? { authority: "app", resourceId: "artifact-1" }
          : {
              authority: "app",
              messageId: "om_root",
              file: { authority: "app", fileKey: "file_key_1" },
            };
      const error = await failure(
        integration.deliver(effect(operation, input)),
      );
      expect(error.effectState).not.toBe("not-applied");
      expect(JSON.stringify(error)).not.toContain("tenant-secret");
      expect(server.requests).toHaveLength(1);
    },
  );
});
