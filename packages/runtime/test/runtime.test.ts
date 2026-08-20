import { describe, expect, it } from "vitest";
import { createWorkEvent } from "@openmatter/core";
import { createMemoryStore, createMockWorkAdapter } from "@openmatter/testing";
import { createOpenMatterRuntime } from "../src/index.js";

const event = createWorkEvent({
  id: "evt-1",
  source: "urn:test:workspace-1",
  type: "test.observed",
  time: "2026-08-19T08:30:00.000Z",
  binding: {
    profile: {
      id: "urn:openmatter:profile:test",
      version: "1.0.0",
      digest: "sha256:test-v1",
    },
    surfaceId: "test",
    authorityId: "workspace-1",
    definitionId: "observed",
  },
  payload: { value: 42 },
});

describe("OpenMatterRuntime", () => {
  it("ingests an event without running the decision and processes it later by reference", async () => {
    let decisions = 0;
    const runtime = createOpenMatterRuntime({
      store: createMemoryStore(),
      ownerId: "runtime-a",
      now: () => "2026-08-19T08:31:00.000Z",
      decide: async () => {
        decisions += 1;
        return { operationCallIds: [], reason: "processed later" };
      },
    });

    const ingested = await runtime.ingest(event);

    expect(ingested).toEqual({
      event: { source: event.source, id: event.id },
      duplicate: false,
    });
    expect(decisions).toBe(0);

    const processed = await runtime.process(ingested.event);

    expect(processed.status).toBe("completed");
    if (processed.status !== "completed") {
      throw new Error("expected completed event processing");
    }
    expect(processed.duplicate).toBe(false);
    expect(processed.reaction.reason).toBe("processed later");
    expect(decisions).toBe(1);
  });

  it("delivers only the operation named by a queue message and reuses its result on redelivery", async () => {
    const store = createMemoryStore();
    const work = createMockWorkAdapter({
      id: "mock-work",
      operations: {
        "message.reply": {
          status: "succeeded",
          output: { messageId: "message-1" },
        },
        "message.react": {
          status: "succeeded",
          output: { reaction: "eyes" },
        },
      },
    });
    const runtime = createOpenMatterRuntime({
      store,
      operations: work.operations,
      ownerId: "runtime-a",
      now: () => "2026-08-19T08:31:00.000Z",
      decide: async () => ({
        operations: [
          {
            callId: "call-reply",
            operation: {
              profile: event.data.openmatter.profile,
              surfaceId: "test",
              authorityId: "workspace-1",
              operationId: "message.reply",
            },
            input: { text: "done" },
          },
          {
            callId: "call-react",
            operation: {
              profile: event.data.openmatter.profile,
              surfaceId: "test",
              authorityId: "workspace-1",
              operationId: "message.react",
            },
            input: { reaction: "eyes" },
          },
        ],
      }),
    });
    const ingested = await runtime.ingest(event);
    await runtime.process(ingested.event);

    const first = await runtime.deliver("call-react");
    const duplicate = await runtime.deliver("call-react");

    expect(first).toEqual({
      status: "completed",
      result: {
        callId: "call-react",
        status: "succeeded",
        output: { reaction: "eyes" },
      },
      duplicate: false,
    });
    expect(duplicate).toEqual({
      status: "completed",
      result: {
        callId: "call-react",
        status: "succeeded",
        output: { reaction: "eyes" },
      },
      duplicate: true,
    });
    expect(work.operationCalls().map(({ id }) => id)).toEqual(["call-react"]);
    await expect(
      store.claimOperation({
        callId: "call-reply",
        ownerId: "operation-worker-b",
        now: "2026-08-19T08:31:00.000Z",
        leaseMs: 30_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "claimed",
        intent: expect.objectContaining({ callId: "call-reply" }),
      }),
    );
  });

  it("accept composes ingest, process, and operation delivery for an embedded service", async () => {
    const work = createMockWorkAdapter({
      id: "mock-work",
      operations: {
        "message.reply": {
          status: "succeeded",
          output: { messageId: "message-1" },
        },
      },
    });
    const runtime = createOpenMatterRuntime({
      store: createMemoryStore(),
      operations: work.operations,
      ownerId: "runtime-a",
      now: () => "2026-08-19T08:31:00.000Z",
      decide: async () => ({
        operations: [
          {
            callId: "call-reply",
            operation: {
              profile: event.data.openmatter.profile,
              surfaceId: "test",
              authorityId: "workspace-1",
              operationId: "message.reply",
            },
            input: { text: "done" },
          },
        ],
      }),
    });

    const receipt = await runtime.accept(event);

    expect(receipt.deliveries).toEqual([
      {
        status: "completed",
        result: {
          callId: "call-reply",
          status: "succeeded",
          output: { messageId: "message-1" },
        },
        duplicate: false,
      },
    ]);
    expect(work.operationCalls().map(({ id }) => id)).toEqual(["call-reply"]);
  });

  it("commits one null ReactionDecision for concurrent duplicate events", async () => {
    let decisions = 0;
    const runtime = createOpenMatterRuntime({
      store: createMemoryStore(),
      ownerId: "runtime-a",
      now: () => "2026-08-19T08:31:00.000Z",
      decide: async () => {
        decisions += 1;
        await Promise.resolve();
        return { operationCallIds: [], reason: "observed" };
      },
    });

    const [first, duplicate] = await Promise.all([
      runtime.accept(event),
      runtime.accept(event),
    ]);

    expect(decisions).toBe(1);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.reaction).toBe(first.reaction);
    expect(first.reaction).toEqual({
      openmatter: "0.1",
      id: "urn:test:workspace-1#evt-1",
      event: { source: "urn:test:workspace-1", id: "evt-1" },
      status: "completed",
      operationCallIds: [],
      reason: "observed",
      decidedAt: "2026-08-19T08:31:00.000Z",
    });
  });

  it("turns a decision failure into the event's unique failed ReactionDecision", async () => {
    const runtime = createOpenMatterRuntime({
      store: createMemoryStore(),
      ownerId: "runtime-a",
      now: () => "2026-08-19T08:31:00.000Z",
      decide: async () => {
        throw new Error("agent unavailable");
      },
    });

    const receipt = await runtime.accept(event);

    expect(receipt.reaction.status).toBe("failed");
    expect(receipt.reaction.reason).toBe("agent unavailable");
    expect(receipt.reaction.operationCallIds).toEqual([]);
  });
});
