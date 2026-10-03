import type { WorkEvent } from "@openmatter/core";
import { makeMemoryInbox } from "./memory-inbox.js";
import {
  associateProjectEvent,
  makeMemoryProjectCommandSink,
  makeProjectControl,
  makeProjectIntegration,
  projectCommandSinkFromInbox,
} from "@openmatter/project";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("project commands", () => {
  it("accepts a command once and turns it into a scoped work event", async () => {
    const sink = makeMemoryProjectCommandSink();
    const control = makeProjectControl({
      scopeId: "project-1",
      authority: "project-host",
      sink,
      clock: () => "2026-08-20T08:00:00.000Z",
      makeId: () => "cmd-1",
    });
    const first = await Effect.runPromise(
      control.delegate({ workerId: "worker-a", task: "Open the branch" }),
    );
    const second = await Effect.runPromise(
      control.delegate({ workerId: "worker-a", task: "Open the branch" }),
    );
    expect(first.status).toBe("accepted");
    expect(second).toEqual({ ...first, status: "duplicate" });

    const drained = await Effect.runPromise(sink.drain);
    expect(drained).toHaveLength(1);
    const [event] = await Effect.runPromise(
      makeProjectIntegration().ingest(drained[0]!),
    );
    expect(event?.type).toBe("project.worker.requested");
    expect(event?.idempotencyKey).toBe(first.idempotencyKey);
    expect(associateProjectEvent({ event: event! })).toEqual({
      scopeId: "project-1",
      authority: "project-host",
      thread: { kind: "worker", id: "worker-a" },
    });
  });

  it("persists the command through the inbox port", async () => {
    const inbox = makeMemoryInbox();
    const control = makeProjectControl({
      scopeId: "project-1",
      authority: "project-host",
      sink: projectCommandSinkFromInbox(inbox),
      clock: () => "2026-08-20T08:00:00.000Z",
      makeId: () => "cmd-2",
    });
    await Effect.runPromise(control.complete({ summary: "Reviewed" }));
    await Effect.runPromise(control.complete({ summary: "Reviewed again" }));
    expect(inbox.items).toHaveLength(1);
    const body = inbox.items[0]?.body as WorkEvent;
    expect(body).toEqual(
      expect.objectContaining({
        type: "project.completed",
        scopeId: "project-1",
      }),
    );
  });
});
