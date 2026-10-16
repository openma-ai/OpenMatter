import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  createOpenMAEvent,
  type AgentDriver,
  type AgentTurnInput,
} from "@openma/matter/agent";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { ProjectWorkService } from "../packages/project-host/src/index.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { makeProjectMcpServer } from "../packages/project-mcp/src/index.js";

it("protects the agent-observed goal and persists a conditional operation receipt across restart", async () => {
  const f = await fixture();
  await f.service.setGoal({
    projectId: "p",
    workThreadId: thread,
    objective: "Original objective",
  });
  const control = f.service.goalControl("p", thread);
  const read = (await control.get())!;
  const input = {
    operationId: "finish-original",
    expectedGoalId: read.id,
    expectedRevision: read.revision,
    status: "complete" as const,
  };
  await f.service.setGoal({
    projectId: "p",
    workThreadId: thread,
    objective: "Changed by user",
  });
  expect(await control.update(input)).toMatchObject({
    status: "conflict",
    effect: "not-applied",
  });
  expect((await control.get())?.status).toBe("active");
  const current = (await control.get())!;
  const revised = {
    ...input,
    operationId: "finish-revised",
    expectedRevision: current.revision,
  };
  const result = await control.update(revised);
  expect(result).toMatchObject({
    status: "committed",
    value: { status: "complete", objective: "Changed by user" },
  });
  await f.restart();
  expect(await f.service.goalControl("p", thread).update(revised)).toEqual(
    result,
  );
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const config = {
  projectId: "p",
  description: "",
  instructions: "",
  context: "",
  resources: [],
  coordinatorAgent: "pi",
  workerAgent: "pi",
  continuity: "per-scope" as const,
  controls: ["delegate", "steer", "cancel"] as const,
};
async function fixture(
  onTurn?: (
    input: AgentTurnInput,
    service: ProjectWorkService<{ id: string; name: string }>,
  ) => Promise<void>,
  terminalType: "turn.completed" | "turn.failed" = "turn.completed",
  output = "Progress",
) {
  const directory = mkdtempSync(join(tmpdir(), "project-goal-"));
  const requests: AgentTurnInput[] = [];
  let service: ProjectWorkService<{ id: string; name: string }>;
  const base = makeMockAgentDriver({ id: "pi", output, terminalType });
  const driver: AgentDriver = {
    ...base.driver,
    turn: (input) =>
      Stream.unwrap(
        Effect.tryPromise(async () => {
          requests.push(input);
          await onTurn?.(input, service);
          return base.driver.turn(input);
        }),
      ) as ReturnType<AgentDriver["turn"]>,
  };
  const deps = {
    directory,
    getProject: (id: string) => ({ id, name: id }),
    driver: () => driver,
  };
  service = new ProjectWorkService(deps);
  await service.save({ ...config, controls: [...config.controls] });
  cleanup.push(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    requests,
    restart: async () => {
      await service.close();
      service = new ProjectWorkService(deps);
    },
  };
}
const thread = "project:p:coordinator";

it("returns an actionable conflict through MCP without mutating a user-edited goal", async () => {
  const f = await fixture();
  await f.service.setGoal({
    projectId: "p",
    workThreadId: thread,
    objective: "Original",
  });
  const server = makeProjectMcpServer({
    tools: [],
    goal: f.service.goalControl("p", thread),
  });
  const client = new Client({ name: "conditional-goal", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const read = await client.callTool({ name: "get_goal", arguments: {} });
    const goal = (
      read.structuredContent as { goal: { id: string; revision: number } }
    ).goal;
    await f.service.setGoal({
      projectId: "p",
      workThreadId: thread,
      objective: "Changed",
    });
    const result = await client.callTool({
      name: "update_goal",
      arguments: {
        operationId: "mcp-finish",
        expectedGoalId: goal.id,
        expectedRevision: goal.revision,
        status: "complete",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "conflict",
      effect: "not-applied",
      conflicts: [{ resourceId: thread }],
    });
    expect(await f.service.goalControl("p", thread).get()).toMatchObject({
      objective: "Changed",
      status: "active",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
