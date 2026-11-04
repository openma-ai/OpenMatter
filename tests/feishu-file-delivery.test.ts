import type { WorkEffect } from "@openma/matter";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as feishu from "../packages/feishu/src/bond/index.js";

const call: WorkEffect = {
  schemaVersion: "0.1",
  id: "abc",
  idempotencyKey: "abc",
  eventId: "event",
  integrationId: "feishu",
  operation: "message.reply",
  input: { authority: "app", messageId: "om_root", inThread: true },
};
const resource = {
  authority: "app",
  filename: "example.html",
  mimeType: "text/html",
  bytes: new TextEncoder().encode("<h1>File</h1>"),
};
const credentials = { baseUrl: "https://open.feishu.cn", token: "token" };
const response = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }));
const setup = (...answers: (Response | Error)[]) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(new Request(url, init));
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("Unexpected request");
    return answer;
  };
  let state: feishu.FeishuFileCheckpoint | undefined;
  const checkpoints = {
    load: async () => state,
    save: async (_key: string, next: feishu.FeishuFileCheckpoint) => {
      state = structuredClone(next);
    },
  };
  return { fetch, requests, checkpoints, state: () => state };
};
const result = <A, E>(operation: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(operation));

// Break caught: the host's durable upload checkpoint must survive a fresh adapter, not live in a process ledger.
describe("trusted Feishu file delivery checkpoints", () => {
  it("resumes from the uploaded fileKey across callbacks and reconstructed delivery", async () => {
    const t = setup(
      response({ file_key: "file_key_1" }),
      new Error("lost reply"),
      response({ message_id: "om_reply" }),
    );
    let now = 1000;
    const make = () =>
      feishu.makeFeishuFileDelivery({
        credentials,
        fetch: t.fetch,
        resolve: () => resource,
        checkpoints: t.checkpoints,
        now: () => now,
      });
    expect(
      (
        await result(
          make()({
            effect: call,
            resourceId: "artifact",
            checkpointKey: "delivery-1",
          }),
        )
      )._tag,
    ).toBe("Left");
    expect(t.state()).toMatchObject({
      file: { authority: "app", fileKey: "file_key_1" },
      replyStartedAt: 1000,
    });
    now = 2000;
    expect(
      await Effect.runPromise(
        make()({
          effect: {
            ...call,
            id: "second-callback",
            idempotencyKey: "second-callback",
          },
          resourceId: "artifact",
          checkpointKey: "delivery-1",
        }),
      ),
    ).toEqual({
      providerReceipt: { messageId: "om_reply", fileKey: "file_key_1" },
    });
    const bodies = await Promise.all(t.requests.slice(1).map((r) => r.json()));
    expect(bodies.map((b) => b.uuid)).toEqual([
      "ba7816bf8f01cfea414140de5dae2223",
      "ba7816bf8f01cfea414140de5dae2223",
    ]);
    expect(
      await Effect.runPromise(
        make()({
          effect: call,
          resourceId: "artifact",
          checkpointKey: "delivery-1",
        }),
      ),
    ).toEqual({
      providerReceipt: { messageId: "om_reply", fileKey: "file_key_1" },
    });
    expect(t.requests).toHaveLength(3);
  });

  it("does not upload again after an ambiguous upload, even with a new callback", async () => {
    const t = setup(new Error("lost upload"));
    const make = () =>
      feishu.makeFeishuFileDelivery({
        credentials,
        fetch: t.fetch,
        resolve: () => resource,
        checkpoints: t.checkpoints,
      });
    await result(
      make()({
        effect: call,
        resourceId: "artifact",
        checkpointKey: "delivery-1",
      }),
    );
    const replay = await result(
      make()({
        effect: { ...call, id: "second" },
        resourceId: "artifact",
        checkpointKey: "delivery-1",
      }),
    );
    expect(replay).toMatchObject({
      _tag: "Left",
      left: { effectState: "unknown", retryable: false },
    });
    expect(t.requests).toHaveLength(1);
  });

  it("refuses changed targets or content bound to the same checkpoint", async () => {
    const t = setup(
      response({ file_key: "file_key_1" }),
      response({ message_id: "om_reply" }),
    );
    const deliver = feishu.makeFeishuFileDelivery({
      credentials,
      fetch: t.fetch,
      resolve: () => resource,
      checkpoints: t.checkpoints,
    });
    await Effect.runPromise(
      deliver({
        effect: call,
        resourceId: "artifact",
        checkpointKey: "delivery-1",
      }),
    );
    expect(
      await result(
        deliver({
          effect: {
            ...call,
            input: { authority: "app", messageId: "om_foreign" },
          },
          resourceId: "artifact",
          checkpointKey: "delivery-1",
        }),
      ),
    ).toMatchObject({ _tag: "Left", left: { effectState: "not-applied" } });
    expect(
      await result(
        deliver({
          effect: call,
          resourceId: "different-artifact",
          checkpointKey: "delivery-1",
        }),
      ),
    ).toMatchObject({ _tag: "Left", left: { effectState: "not-applied" } });
    expect(t.requests).toHaveLength(2);
  });

  it("does not retry an uncertain reply beyond the provider's UUID window", async () => {
    const t = setup(
      response({ file_key: "file_key_1" }),
      new Error("lost reply"),
    );
    let now = 0;
    const deliver = feishu.makeFeishuFileDelivery({
      credentials,
      fetch: t.fetch,
      resolve: () => resource,
      checkpoints: t.checkpoints,
      now: () => now,
    });
    await result(
      deliver({
        effect: call,
        resourceId: "artifact",
        checkpointKey: "delivery-1",
      }),
    );
    now = 60 * 60 * 1000;
    expect(
      await result(
        deliver({
          effect: call,
          resourceId: "artifact",
          checkpointKey: "delivery-1",
        }),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: { effectState: "unknown", retryable: false },
    });
    expect(t.requests).toHaveLength(2);
  });

  it("does not reset the UUID window when migrating an existing fileKey", async () => {
    const t = setup();
    const deliver = feishu.makeFeishuFileDelivery({
      credentials,
      fetch: t.fetch,
      resolve: () => resource,
      checkpoints: t.checkpoints,
      now: () => 60 * 60 * 1000,
    });
    expect(
      await result(
        deliver({
          effect: call,
          resourceId: "artifact",
          checkpointKey: "delivery-1",
          file: { authority: "app", fileKey: "file_existing" },
          replyStartedAt: 0,
        }),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: { effectState: "unknown", retryable: false },
    });
    expect(t.requests).toHaveLength(0);
  });

  it.each([null, {}, { binding: "x", idempotencyKey: "" }])(
    "fails closed on malformed persisted checkpoints (%j)",
    async (state) => {
      const t = setup();
      const deliver = feishu.makeFeishuFileDelivery({
        credentials,
        fetch: t.fetch,
        resolve: () => resource,
        checkpoints: {
          load: async () => state as never,
          save: t.checkpoints.save,
        },
      });
      expect(
        await result(
          deliver({
            effect: call,
            resourceId: "artifact",
            checkpointKey: "delivery-1",
          }),
        ),
      ).toMatchObject({ _tag: "Left", left: { effectState: "not-applied" } });
      expect(t.requests).toHaveLength(0);
    },
  );

  // Break caught: two absent file keys must never compare equal into a cached success.
  describe.each([
    ["missing", undefined],
    ["null", null],
    ["empty", {}],
    ["wrong authority", { authority: "other", fileKey: "file_key_1" }],
    ["empty key", { authority: "app", fileKey: "" }],
    ["valid", { authority: "app", fileKey: "file_key_1" }],
  ] as const)("persisted file %s", (fileKind, file) => {
    it.each([
      ["missing", undefined],
      ["null", null],
      ["empty", {}],
      ["message only", { messageId: "om_fake" }],
      ["key only", { fileKey: "file_key_1" }],
      ["invalid message", { messageId: "om_", fileKey: "file_key_1" }],
      ["different key", { messageId: "om_cached", fileKey: "file_other" }],
      ["valid", { messageId: "om_cached", fileKey: "file_key_1" }],
    ] as const)(
      "handles receipt %s without false confirmation",
      async (receiptKind, receipt) => {
        const t = setup(response({ message_id: "om_new" }));
        const deliver = feishu.makeFeishuFileDelivery({
          credentials,
          fetch: t.fetch,
          resolve: () => {
            throw new Error("No upload during recovery");
          },
          checkpoints: {
            load: async () =>
              ({
                binding:
                  '["feishu","message.reply","app",null,"om_root",true,"artifact"]',
                idempotencyKey: "abc",
                ...(file === undefined ? {} : { file }),
                ...(receipt === undefined ? {} : { receipt }),
              }) as feishu.FeishuFileCheckpoint,
            save: t.checkpoints.save,
          },
        });
        const outcome = await result(
          deliver({
            effect: call,
            resourceId: "artifact",
            checkpointKey: "delivery-1",
          }),
        );
        if (fileKind === "valid" && receiptKind === "valid") {
          expect(outcome).toMatchObject({
            _tag: "Right",
            right: {
              providerReceipt: {
                messageId: "om_cached",
                fileKey: "file_key_1",
              },
            },
          });
          expect(t.requests).toHaveLength(0);
        } else if (fileKind === "valid" && receiptKind === "missing") {
          expect(outcome).toMatchObject({
            _tag: "Right",
            right: {
              providerReceipt: { messageId: "om_new", fileKey: "file_key_1" },
            },
          });
          expect(t.requests).toHaveLength(1);
        } else {
          expect(outcome).toMatchObject({ _tag: "Left" });
          expect(t.requests).toHaveLength(0);
        }
      },
    );
  });

  it.each([1, 2, 3, 4])(
    "never advances provider delivery after checkpoint save %s fails",
    async (failAt) => {
      const t = setup(
        response({ file_key: "file_key_1" }),
        response({ message_id: "om_reply" }),
      );
      let saves = 0;
      const deliver = feishu.makeFeishuFileDelivery({
        credentials,
        fetch: t.fetch,
        resolve: () => resource,
        checkpoints: {
          load: t.checkpoints.load,
          save: async (key, state) => {
            if (++saves === failAt) throw new Error("store down");
            await t.checkpoints.save(key, state);
          },
        },
      });
      expect(
        await result(
          deliver({
            effect: call,
            resourceId: "artifact",
            checkpointKey: "delivery-1",
          }),
        ),
      ).toMatchObject({ _tag: "Left", left: { effectState: "unknown" } });
      expect(t.requests).toHaveLength(failAt === 1 ? 0 : failAt === 4 ? 2 : 1);
    },
  );

  it("resumes a host-attested uploaded key without reading or uploading bytes", async () => {
    const t = setup(response({ message_id: "om_reply" }));
    const deliver = feishu.makeFeishuFileDelivery({
      credentials,
      fetch: t.fetch,
      resolve: () => {
        throw new Error("Must not resolve");
      },
      checkpoints: t.checkpoints,
    });
    expect(
      await Effect.runPromise(
        deliver({
          effect: call,
          resourceId: "artifact",
          checkpointKey: "delivery-1",
          file: { authority: "app", fileKey: "file_existing" },
        }),
      ),
    ).toEqual({
      providerReceipt: { messageId: "om_reply", fileKey: "file_existing" },
    });
    expect(t.requests).toHaveLength(1);
  });
});
