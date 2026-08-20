import { createWorkEvent, type ReactionDecision } from "@openmatter/core";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/index.js";

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

const reaction: ReactionDecision = {
  openmatter: "0.1",
  id: "reaction-1",
  event: { source: event.source, id: event.id },
  status: "completed",
  operationCallIds: ["call-1"],
  decidedAt: "2026-08-19T08:31:00.000Z",
};

describe("MemoryStore", () => {
  it("uses revisions to prevent two serverless invocations from replacing the same agent session", async () => {
    const store = createMemoryStore();
    const first = await store.sessions.save({
      expectedRevision: null,
      session: {
        key: "agent-1/scope-1/thread-1",
        agentId: "agent-1",
        scopeId: "scope-1",
        threadId: "thread-1",
        state: "open",
        handle: {
          driverId: "managed-agent",
          externalSessionId: "session-external-1",
          placement: "managed",
          resumeToken: "resume-1",
        },
        updatedAt: "2026-08-19T08:31:00.000Z",
      },
    });

    expect(first.revision).toBe(1);
    await expect(
      store.sessions.save({
        expectedRevision: null,
        session: {
          ...first,
          handle: {
            ...first.handle,
            externalSessionId: "session-competing",
          },
        },
      }),
    ).rejects.toThrowError("Agent session revision conflict");

    const resumed = await store.sessions.save({
      expectedRevision: 1,
      session: {
        ...first,
        handle: {
          ...first.handle,
          resumeToken: "resume-2",
        },
        updatedAt: "2026-08-19T08:32:00.000Z",
      },
    });

    expect(resumed.revision).toBe(2);
    await expect(store.sessions.get(first.key)).resolves.toEqual(resumed);
  });

  it("persists a versioned checkpoint for polling cursors or proactive scans", async () => {
    const store = createMemoryStore();
    const created = await store.checkpoints.save({
      expectedRevision: null,
      checkpoint: {
        namespace: "linear-poll",
        key: "workspace-1",
        value: { cursor: "page-2", completed: false },
        updatedAt: "2026-08-19T08:31:00.000Z",
      },
    });

    expect(created).toEqual({
      namespace: "linear-poll",
      key: "workspace-1",
      value: { cursor: "page-2", completed: false },
      revision: 1,
      updatedAt: "2026-08-19T08:31:00.000Z",
    });
    await expect(
      store.checkpoints.save({
        expectedRevision: 0,
        checkpoint: {
          ...created,
          value: { cursor: "page-3", completed: true },
        },
      }),
    ).rejects.toThrowError("Checkpoint revision conflict");
  });

  it("atomically claims an event and commits its reaction with operation intents", async () => {
    const store = createMemoryStore();
    const first = await store.claimEvent({
      event,
      ownerId: "worker-a",
      now: "2026-08-19T08:30:01.000Z",
      leaseMs: 30_000,
    });
    const competing = await store.claimEvent({
      event,
      ownerId: "worker-b",
      now: "2026-08-19T08:30:02.000Z",
      leaseMs: 30_000,
    });

    expect(first.status).toBe("claimed");
    expect(competing).toEqual({ status: "processing" });
    if (first.status !== "claimed") throw new Error("expected event claim");

    await store.commitReactionPlan({
      event: { source: event.source, id: event.id },
      claimToken: first.claimToken,
      reaction,
      operations: [
        {
          callId: "call-1",
          operation: {
            profile: event.data.openmatter.profile,
            surfaceId: "test",
            authorityId: "workspace-1",
            operationId: "message.reply",
          },
          input: { text: "done" },
        },
      ],
    });

    const completed = await store.claimEvent({
      event,
      ownerId: "worker-b",
      now: "2026-08-19T08:30:03.000Z",
      leaseMs: 30_000,
    });
    expect(completed).toEqual({ status: "completed", reaction });
    await expect(
      store.claimOperation({
        callId: "call-1",
        ownerId: "operation-worker-a",
        now: "2026-08-19T08:30:04.000Z",
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({
      status: "claimed",
      intent: {
        callId: "call-1",
        operation: {
          profile: event.data.openmatter.profile,
          surfaceId: "test",
          authorityId: "workspace-1",
          operationId: "message.reply",
        },
        input: { text: "done" },
      },
      claimToken: "operation-claim-1",
      expiresAt: "2026-08-19T08:30:34.000Z",
    });
  });

  it("rejects a reaction commit made with a stale claim token", async () => {
    const store = createMemoryStore();
    await store.claimEvent({
      event,
      ownerId: "worker-a",
      now: "2026-08-19T08:30:01.000Z",
      leaseMs: 1_000,
    });
    const replacement = await store.claimEvent({
      event,
      ownerId: "worker-b",
      now: "2026-08-19T08:30:03.000Z",
      leaseMs: 30_000,
    });
    if (replacement.status !== "claimed") throw new Error("expected replacement claim");

    await expect(
      store.commitReactionPlan({
        event: { source: event.source, id: event.id },
        claimToken: "stale-token",
        reaction,
        operations: [],
      }),
    ).rejects.toThrowError("Event claim is no longer current");
  });

  it("fences operation delivery after an expired worker claim", async () => {
    const store = createMemoryStore();
    const eventClaim = await store.claimEvent({
      event,
      ownerId: "runtime-a",
      now: "2026-08-19T08:30:01.000Z",
      leaseMs: 30_000,
    });
    if (eventClaim.status !== "claimed") throw new Error("expected event claim");
    await store.commitReactionPlan({
      event: { source: event.source, id: event.id },
      claimToken: eventClaim.claimToken,
      reaction,
      operations: [
        {
          callId: "call-1",
          operation: {
            profile: event.data.openmatter.profile,
            surfaceId: "test",
            authorityId: "workspace-1",
            operationId: "message.reply",
          },
          input: { text: "done" },
        },
      ],
    });

    const first = await store.claimOperation({
      callId: "call-1",
      ownerId: "worker-a",
      now: "2026-08-19T08:31:00.000Z",
      leaseMs: 1_000,
    });
    const replacement = await store.claimOperation({
      callId: "call-1",
      ownerId: "worker-b",
      now: "2026-08-19T08:31:02.000Z",
      leaseMs: 30_000,
    });
    if (first.status !== "claimed" || replacement.status !== "claimed") {
      throw new Error("expected operation claims");
    }
    expect(replacement.claimToken).not.toBe(first.claimToken);

    await expect(
      store.completeOperation({
        callId: "call-1",
        claimToken: first.claimToken,
        result: { callId: "call-1", status: "succeeded", output: { ok: true } },
      }),
    ).rejects.toThrowError("Operation claim is no longer current");

    await store.completeOperation({
      callId: "call-1",
      claimToken: replacement.claimToken,
      result: { callId: "call-1", status: "succeeded", output: { ok: true } },
    });
    await expect(store.getOperationResult("call-1")).resolves.toEqual({
      callId: "call-1",
      status: "succeeded",
      output: { ok: true },
    });
  });
});
