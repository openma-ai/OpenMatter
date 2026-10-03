import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockAgentDriver } from "@openmatter/agent-mock";
import {
  ProjectWorkService,
  type ProjectWorkConfig,
} from "@openmatter/project-host";
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
});
