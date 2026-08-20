import {
  createWorkEvent,
  type OperationCall,
} from "@openmatter/core";
import { describe, expect, it } from "vitest";
import {
  createMockTimerAdapter,
  createMockWorkAdapter,
  createMockWorkEventSource,
} from "../src/index.js";

const call: OperationCall = {
  id: "call-1",
  operation: {
    profile: {
      id: "urn:openmatter:profile:test",
      version: "1.0.0",
      digest: "sha256:test-v1",
    },
    surfaceId: "test",
    authorityId: "workspace-1",
    operationId: "issue.read",
  },
  input: { issueId: "WEB-42" },
  requestedAt: "2026-08-19T08:30:00.000Z",
};

describe("MockWorkAdapter", () => {
  it("returns configured operation results and records the real OperationCall", async () => {
    const adapter = createMockWorkAdapter({
      id: "mock-work",
      operations: {
        "issue.read": {
          status: "succeeded",
          output: { id: "WEB-42", title: "Fix runtime" },
        },
      },
    });

    const result = await adapter.operations.invoke(call);

    expect(result).toEqual({
      callId: "call-1",
      status: "succeeded",
      output: { id: "WEB-42", title: "Fix runtime" },
    });
    expect(adapter.operationCalls()).toEqual([call]);
  });

  it("delivers emitted provider events through the WorkEventSource port", async () => {
    const source = createMockWorkEventSource();
    const abort = new AbortController();
    const received: string[] = [];
    const running = source.start(async (event) => {
      received.push(event.id);
      abort.abort();
    }, abort.signal);
    const event = createWorkEvent({
      id: "evt-1",
      source: "urn:test:workspace-1",
      type: "test.observed",
      time: "2026-08-19T08:30:00.000Z",
      binding: {
        profile: call.operation.profile,
        surfaceId: "test",
        authorityId: "workspace-1",
        definitionId: "observed",
      },
      payload: {},
    });

    await source.emit(event);
    await running;

    expect(received).toEqual(["evt-1"]);
  });

  it("adapts a host timer occurrence into ordinary work events", async () => {
    const timer = createMockTimerAdapter({
      id: "stale-issue-patrol",
      decode: async (occurrence: {
        readonly id: string;
        readonly scheduledAt: string;
      }) => [
        createWorkEvent({
          id: occurrence.id,
          source: "urn:test:scheduler",
          type: "schedule.triggered",
          time: occurrence.scheduledAt,
          binding: {
            profile: call.operation.profile,
            surfaceId: "test",
            authorityId: "workspace-1",
            definitionId: "schedule.triggered",
          },
          payload: { scheduleId: "stale-issue-patrol" },
        }),
      ],
    });

    const events = await timer.decode({
      id: "tick-2026-08-20T10:00:00Z",
      scheduledAt: "2026-08-20T10:00:00.000Z",
    });

    expect(timer.id).toBe("stale-issue-patrol");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("schedule.triggered");
    expect(events[0]?.data.payload).toEqual({
      scheduleId: "stale-issue-patrol",
    });
  });
});
