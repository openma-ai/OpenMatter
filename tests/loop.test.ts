import type { WorkEvent } from "@openma/matter";
import {
  createOpenMatter,
  defineLoop,
  loopConfigSchemaProblems,
  resolveLoopConfig,
  type LoopConfig,
  type LoopConfigSchema,
} from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { describe, expect, it } from "vitest";

const event = (id: string): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type: "chat.message.received",
  occurredAt: "2026-08-23T08:00:00.000Z",
  receivedAt: "2026-08-23T08:00:01.000Z",
  idempotencyKey: `chat:${id}`,
  source: {
    provider: "chat",
    authority: "workspace-1",
    conversationId: "channel-1",
    messageId: id,
  },
  payload: { text: "hello" },
});

describe("OpenMatter Loops", () => {
  it("installs a user-defined Loop as a persistent event behavior", async () => {
    const handled: string[] = [];
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: {},
      agents: {},
    });
    const observer = defineLoop(
      {
        id: "observe-chat",
        version: "0.1.0",
        spec: {
          sources: ["chat.message.received"],
          reaction: "none",
        },
      },
      (loopApp) =>
        loopApp.on("chat.message.received", (work) => {
          handled.push(work.event.id);
          return work.react.none("observed");
        }),
    );

    expect(app.loop(observer)).toBe(app);

    const receipt = await app.accept(event("message-1"));

    expect(handled).toEqual(["message-1"]);
    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "completed",
        effects: [],
        reason: "observed",
      }),
    );
  });

  it("keeps the portable Loop definition separate from executable setup", () => {
    const loop = defineLoop(
      {
        id: "issue-triage",
        version: "0.1.0",
        description: "Triage issue updates with an agent",
        spec: {
          sources: ["linear.issue.updated"],
          workThread: "linear.issue",
          session: "per-work-thread",
        },
      },
      () => undefined,
    );

    expect(JSON.parse(JSON.stringify(loop.definition))).toEqual({
      id: "issue-triage",
      version: "0.1.0",
      description: "Triage issue updates with an agent",
      spec: {
        sources: ["linear.issue.updated"],
        workThread: "linear.issue",
        session: "per-work-thread",
      },
    });
  });

  it("snapshots and freezes the portable definition", () => {
    const sources = ["chat.message.received"];
    const loop = defineLoop(
      {
        id: "immutable-loop",
        spec: { sources },
      },
      () => undefined,
    );

    sources[0] = "chat.message.deleted";

    expect(loop.definition.spec).toEqual({
      sources: ["chat.message.received"],
    });
    expect(Object.isFrozen(loop.definition)).toBe(true);
    expect(Object.isFrozen(loop.definition.spec)).toBe(true);
  });
});

describe("Loop configuration, required Bonds, and runAs", () => {
  const schema: LoopConfigSchema = {
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        title: "Projects",
        "x-oma-widget": "bond-resources",
        "x-bond-provider": "gitlab",
      },
      granularity: {
        type: "string",
        enum: ["per_chat", "per_chat_user"],
        default: "per_chat_user",
      },
      maxTurns: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      skipDrafts: { type: "boolean", default: true },
    },
    required: ["projects"],
  };

  it("keeps configSchema, requiredBonds, and runAs in the frozen portable definition", () => {
    const loop = defineLoop(
      {
        id: "gitlab-mr-review",
        configSchema: schema,
        requiredBonds: [
          { provider: "gitlab", operations: ["fetch", "comment_mr"] },
        ],
        runAs: "app",
      },
      () => undefined,
    );
    expect(JSON.parse(JSON.stringify(loop.definition))).toEqual({
      id: "gitlab-mr-review",
      configSchema: schema,
      requiredBonds: [
        { provider: "gitlab", operations: ["fetch", "comment_mr"] },
      ],
      runAs: "app",
    });
    expect(Object.isFrozen(loop.definition.configSchema)).toBe(true);
    expect(Object.isFrozen(loop.definition.requiredBonds)).toBe(true);
    expect(Object.isFrozen(loop.definition.requiredBonds![0])).toBe(true);
  });

  it("rejects invalid schemas, required Bonds, and runAs at definition time", () => {
    const define = (extra: Record<string, unknown>) => () =>
      defineLoop({ id: "bad", ...extra } as never, () => undefined);
    expect(define({ runAs: "owner" })).toThrow(
      "runAs must be app or requester",
    );
    expect(
      define({ requiredBonds: [{ provider: "gitlab", operations: [] }] }),
    ).toThrow("requiredBonds");
    expect(
      define({ requiredBonds: [{ provider: "", operations: ["fetch"] }] }),
    ).toThrow("requiredBonds");
    expect(define({ configSchema: { type: "array" } })).toThrow(
      "configSchema must be an object schema",
    );
    expect(
      loopConfigSchemaProblems({
        type: "object",
        properties: {
          a: { type: "object" },
          b: { type: "string", pattern: "x" },
          c: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
          d: { type: "string", enum: [] },
          e: { type: "integer", minimum: 1, default: 0 },
        },
        required: ["z"],
        additionalProperties: true,
      }),
    ).toEqual([
      "configSchema has unsupported keyword additionalProperties",
      "configSchema.a has unsupported type object",
      "configSchema.b has unsupported keyword pattern",
      "configSchema.c.items has unsupported type array",
      "configSchema.d.enum must be a non-empty list of strings",
      "configSchema.e must be at least 1",
      "configSchema.required names unknown field z",
    ]);
    expect(loopConfigSchemaProblems(schema)).toEqual([]);
  });

  it("fills defaults and reports every problem in a submitted configuration", () => {
    expect(resolveLoopConfig(schema, { projects: ["project:42"] })).toEqual({
      ok: true,
      config: {
        projects: ["project:42"],
        granularity: "per_chat_user",
        maxTurns: 10,
        skipDrafts: true,
      },
    });
    expect(
      resolveLoopConfig(schema, {
        projects: [""],
        granularity: "per_user",
        maxTurns: 2.5,
        skipDrafts: "yes",
        extra: 1,
      }),
    ).toEqual({
      ok: false,
      problems: [
        "unknown field extra",
        "projects[0] must have at least 1 characters",
        "granularity must be one of per_chat, per_chat_user",
        "maxTurns must be an integer",
        "skipDrafts must be a boolean",
      ],
    });
    expect(resolveLoopConfig(schema, {})).toEqual({
      ok: false,
      problems: ["projects is required"],
    });
    expect(resolveLoopConfig(schema, { projects: [] })).toEqual({
      ok: false,
      problems: ["projects must have at least 1 items"],
    });
    expect(resolveLoopConfig(schema, [])).toEqual({
      ok: false,
      problems: ["config must be an object"],
    });
    expect(resolveLoopConfig(undefined, undefined)).toEqual({
      ok: true,
      config: {},
    });
    expect(resolveLoopConfig(undefined, { a: 1 })).toEqual({
      ok: false,
      problems: ["this Loop takes no configuration"],
    });
  });

  it("passes the validated configuration to install and installs nothing when it is invalid", () => {
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: {},
      agents: {},
    });
    const seen: LoopConfig[] = [];
    const loop = defineLoop(
      { id: "configured", configSchema: schema },
      (target, { config }) => {
        seen.push(config);
        return target;
      },
    );
    app.loop(loop, { projects: ["project:1"], maxTurns: 3 });
    expect(seen).toEqual([
      {
        projects: ["project:1"],
        granularity: "per_chat_user",
        maxTurns: 3,
        skipDrafts: true,
      },
    ]);
    expect(() => app.loop(loop, { maxTurns: 99 })).toThrow(
      "Invalid configuration for Loop configured: projects is required; maxTurns must be at most 50",
    );
    expect(seen).toHaveLength(1);
    const plain = defineLoop({ id: "plain" }, (_target, { config }) => {
      seen.push(config);
    });
    app.loop(plain);
    expect(seen[1]).toEqual({});
  });
});
