import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import {
  ProjectWorkService,
  type ProjectWorkConfig,
} from "@openma/matter-project-host";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const configFor = (projectId: string): ProjectWorkConfig => ({
  projectId,
  description: "Ship the worker",
  instructions: "Stay on the branch",
  context: "Repository notes",
  resources: [{ id: "note-1", name: "Notes", text: "Use the public API" }],
  coordinatorAgent: "coordinator",
  workerAgent: "worker",
  continuity: "per-scope",
  controls: ["delegate", "steer", "cancel", "complete"],
});

describe("project host", () => {
  it("keeps a submitted command pending across restart and delivers it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatter-project-"));
    directories.push(directory);
    const project = { id: "project-1", name: "Cloud" };
    const opens = { n: 0 };
    const service = () =>
      new ProjectWorkService({
        directory,
        getProject: (id) => (id === project.id ? project : null),
        driver: (id) => {
          opens.n += 1;
          return makeMockAgentDriver({ id, output: `done:${id}` }).driver;
        },
      });

    const first = service();
    await expect(
      first.save({ ...configFor(project.id), workerAgent: "" }),
    ).rejects.toThrow(/both agents/);
    await first.save(configFor(project.id));
    await first.submit({
      projectId: project.id,
      commandId: "message-1",
      type: "message",
      text: "Start the coordinator",
    });
    await first.submit({
      projectId: project.id,
      commandId: "message-1",
      type: "message",
      text: "Start the coordinator",
    });
    expect((await first.view(project.id)).pending).toBe(1);
    await first.close();

    const resumed = service();
    expect((await resumed.view(project.id)).pending).toBe(1);
    await resumed.drain();
    const view = await resumed.view(project.id);
    expect(view.pending).toBe(0);
    expect(view.error).toBeNull();
    expect(view.facts.turns.length).toBeGreaterThan(0);
    expect(view.config?.instructions).toBe("Stay on the branch");
    expect(opens.n).toBeGreaterThan(0);

    const goal = await resumed.setGoal({
      projectId: project.id,
      workThreadId: `project:${project.id}:coordinator`,
      objective: "Finish the branch",
    });
    expect(goal?.status).toBe("active");
    expect(
      await resumed.setGoal({
        projectId: project.id,
        workThreadId: `project:${project.id}:coordinator`,
        clear: true,
      }),
    ).toBeNull();
    await resumed.close();
  });

  for (const mode of ["thread", "none", undefined] as const)
    it(`workspace mode ${mode ?? "default"} controls workspace context and registration`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "openmatter-project-"));
      directories.push(directory);
      const project = { id: "project-ws", name: "Docs" };
      const mocks: ReturnType<typeof makeMockAgentDriver>[] = [];
      const service = new ProjectWorkService({
        directory,
        getProject: (id) => (id === project.id ? project : null),
        driver: (id) => {
          const mock = makeMockAgentDriver({ id, output: `done:${id}` });
          mocks.push(mock);
          return mock.driver;
        },
      });
      await service.save({
        ...configFor(project.id),
        ...(mode ? { workspace: mode } : {}),
      });
      await service.submit({
        projectId: project.id,
        commandId: "message-ws",
        type: "message",
        text: "Write the release notes",
      });
      await service.drain();
      const view = await service.view(project.id);
      expect(view.error).toBeNull();
      expect(view.facts.turns.length).toBeGreaterThan(0);
      const inputs = JSON.stringify(mocks.flatMap((m) => m.turnInputs()));
      expect(inputs).toContain("project-instructions");
      if (mode === "none") {
        expect(inputs).not.toContain("project-workspaces");
        expect(view.workspaces).toBeUndefined();
        expect(() =>
          service.workspaces.reserve(project.id, "thread-1", {}),
        ).toThrow(/disabled/);
      } else {
        expect(inputs).toContain("project-workspaces");
        expect(view.workspaces).toEqual([]);
        expect(
          service.workspaces.reserve(project.id, "thread-1", {}).branch,
        ).toMatch(/^openmatter\/thread-/);
      }
      await service.close();
    });

  it("rejects an unknown workspace mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatter-project-"));
    directories.push(directory);
    const service = new ProjectWorkService({
      directory,
      getProject: (id) => ({ id, name: "x" }),
      driver: (id) => makeMockAgentDriver({ id, output: "ok" }).driver,
    });
    await expect(
      service.save({
        ...configFor("p"),
        workspace: "git" as unknown as "none",
      }),
    ).rejects.toThrow(/workspace mode/);
    await service.close();
  });
});
