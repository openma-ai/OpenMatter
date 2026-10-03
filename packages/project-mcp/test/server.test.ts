import {
  makeMemoryProjectCommandSink,
  makeProjectControl,
} from "@openmatter/project";
import {
  THREAD_GOAL_INSTRUCTIONS,
  makeProjectMcpServer,
} from "@openmatter/project-mcp";
import type { ThreadGoal } from "@openmatter/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const goal: ThreadGoal = {
  id: "goal-1",
  scopeId: "project-1",
  workThreadId: "thread-1",
  objective: "Ship",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
  revision: 1,
};

describe("project MCP", () => {
  it("binds goal and delegate tools to the host, not caller-selected scope", async () => {
    const sink = makeMemoryProjectCommandSink();
    const control = makeProjectControl({
      scopeId: "project-1",
      authority: "project-host",
      sink,
      clock: () => "2026-08-20T08:00:00.000Z",
      makeId: () => "cmd-1",
    });
    let current: ThreadGoal | null = null;
    const server = makeProjectMcpServer({
      control,
      tools: ["delegate"],
      goal: {
        get: async () => current,
        create: async (input) => {
          current = { ...goal, objective: input.objective };
          return current;
        },
        update: async (input) => {
          if (!current) throw new Error("No goal is set");
          current = {
            ...current,
            status: input.status,
            revision: current.revision + 1,
          };
          return current;
        },
      },
      readStatus: async () => ({
        project: { id: "project-1", name: "Cloud" },
        pending: 0,
        error: null,
        threads: [],
        totalThreads: 0,
        truncated: false,
      }),
    });

    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: Record<string, unknown>) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    expect(Object.keys(registered).sort()).toEqual([
      "create_goal",
      "get_goal",
      "project.delegate",
      "project.status",
      "update_goal",
    ]);
    const created = (await registered.create_goal!.handler({
      objective: "Ship",
    })) as { structuredContent: { goal: ThreadGoal } };
    expect(created.structuredContent.goal.scopeId).toBe("project-1");
    await registered["project.delegate"]!.handler({
      workerId: "worker-a",
      task: "Open the branch",
    });
    const commands = await Effect.runPromise(sink.drain);
    expect(commands[0]).toEqual(
      expect.objectContaining({
        scopeId: "project-1",
        type: "worker.requested",
      }),
    );
    expect(THREAD_GOAL_INSTRUCTIONS).toContain("get_goal");
  });
});
