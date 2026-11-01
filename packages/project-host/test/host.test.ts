import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { WorkIntegration } from "@openma/matter/integration";
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
  it("runs granted tools of a host integration with freshness over observed project events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmatter-project-"));
    directories.push(directory);
    const project = { id: "chat", name: "Chat" };
    const delivered: unknown[] = [];
    const reply: WorkIntegration = {
      manifest: {
        id: "chat",
        displayName: "Chat",
        events: [],
        operations: ["reply"],
        tools: {
          reply: {
            description: "Reply",
            inputSchema: { type: "object" },
            freshness: "best-effort",
          },
        },
      },
      ingest: () => Effect.succeed([]),
      deliver: (effect) =>
        Effect.sync(() => {
          delivered.push(effect.input);
          return { providerReceipt: { n: delivered.length } };
        }),
    };
    let service!: ProjectWorkService<typeof project>;
    let injected = false;
    const agent = makeMockAgentDriver({
      id: "agent",
      output: "done",
      operationCalls: [
        {
          callId: "r1",
          integrationId: "chat",
          operation: "reply",
          input: { text: "hi" },
        },
      ],
      beforeEvents: async () => {
        if (injected) return;
        injected = true;
        // Someone writes while the Turn is thinking: recorded before its reply.
        await service.submit({
          projectId: project.id,
          commandId: "m2",
          type: "message",
          text: "correction",
          origin: { human: true },
        });
        for (let i = 0; i < 100; i++) {
          void service.drain();
          await new Promise((resolve) => setTimeout(resolve, 10));
          const entries = await Effect.runPromise(
            service.store.listConversationEntries(
              JSON.stringify(["project", "project-host", project.id]),
              0,
            ),
          );
          if (entries.length === 2) return;
        }
        throw new Error("correction was not recorded");
      },
    });
    service = new ProjectWorkService({
      directory,
      eventLeaseMs: 50,
      getProject: (id) => (id === project.id ? project : null),
      driver: () => agent.driver,
      integrations: () => ({ chat: reply }),
      grants: () => ["chat.reply"],
      observe: (event) => ({
        conversationId: event.source.conversationId!,
        kind: "message",
        threadId: "main",
        sender: { id: "user", kind: "human" },
      }),
    });
    await service.save({ ...configFor(project.id), workspace: "none" });
    await service.submit({
      projectId: project.id,
      commandId: "m1",
      type: "message",
      text: "hello",
    });
    await service.drain();
    expect(agent.turnInputs()[0]?.allow).toEqual(["chat.reply"]);
    expect(agent.turnInputs()[0]?.tools?.[0]?.name).toBe("chat.reply");
    expect(agent.callbackResponses()[0]?.result).toMatchObject({
      status: "conflict",
      effect: "not-applied",
    });
    expect(delivered).toEqual([]);
    await service.close();
  });
});
