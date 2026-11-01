import type { WorkEvent } from "@openma/matter";
import type { AgentTurnInput } from "@openma/matter/agent";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { coordinatorLoop } from "@openma/matter-orchestration";
import { describe, expect, it } from "vitest";

const event = (
  id: string,
  type: string,
  workerId: string,
  text: string,
): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type,
  occurredAt: "2026-10-31T08:00:00.000Z",
  receivedAt: "2026-10-31T08:00:01.000Z",
  idempotencyKey: `test:${id}`,
  source: { provider: "test", authority: "a", conversationId: "c" },
  payload: { workerId, text },
});

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const setup = (steering: boolean) => {
  const store = makeMemoryStore();
  const started = gate();
  const release = gate();
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "worker done",
    steering,
    beforeEvents: async (input: AgentTurnInput) => {
      if (input.turnId === firstTurn.id || firstTurn.id === undefined) {
        firstTurn.id ??= input.turnId;
        started.open();
        await release.opened;
      }
    },
  });
  const firstTurn: { id?: string } = {};
  const coordinator = makeMockAgentDriver({
    id: "coordinator",
    output: "noted",
  });
  const app = createOpenMatter({
    store,
    integrations: {},
    eventLeaseMs: 50,
    agents: { coordinator: coordinator.driver, worker: worker.driver },
  }).loop(
    coordinatorLoop({
      id: "steer-test",
      continuity: "per-scope",
      agentId: "coordinator",
      workerAgent: "worker",
      sources: ["work.delegated", "work.steered"],
      steerSources: ["work.steered"],
      associate: (work) => ({
        scopeId: "scope",
        thread: {
          kind: "worker",
          id: (work.event.payload as { workerId: string }).workerId,
        },
      }),
    }),
  );
  return { app, store, worker, coordinator, started, release, firstTurn };
};

const steerItem = (inputs: readonly AgentTurnInput[]) =>
  inputs
    .flatMap((input) => input.context.items)
    .find((item) => item.kind === "coordinator-worker-steer")?.value;

describe("live steer", () => {
  it("injects a steer into the running worker Turn when the driver supports steering", async () => {
    const f = setup(true);
    const delegated = f.app.accept(
      event("d1", "work.delegated", "w1", "long task"),
    );
    await f.started.opened;

    const steered = await f.app.accept(
      event("s1", "work.steered", "w1", "change course"),
    );
    expect(steered.reaction.status).toBe("completed");
    // No new worker Turn: the steer reached the running one.
    expect(f.worker.turnInputs()).toHaveLength(1);
    expect(f.worker.steerInputs()).toHaveLength(1);
    expect(f.worker.steerInputs()[0]).toMatchObject({
      turnId: f.firstTurn.id,
      steerId: "test:s1",
    });
    expect(steerItem(f.coordinator.turnInputs())).toEqual({
      workerId: "w1",
      status: "live",
      turnId: f.firstTurn.id,
    });

    // A redelivered steer Event is not applied twice.
    await f.app.accept(event("s1", "work.steered", "w1", "change course"));
    expect(f.worker.steerInputs()).toHaveLength(1);

    f.release.open();
    await delegated;
    const events = await import("effect").then(({ Effect }) =>
      Effect.runPromise(f.store.getAgentEvents(f.firstTurn.id!)),
    );
    const types = events.map((e) => [
      e.type,
      (e.data as { text?: string }).text,
    ]);
    // The instruction landed inside the same Turn, before its terminal event.
    expect(types).toEqual([
      ["agent.message", "steered:test:s1"],
      ["agent.message", "worker done"],
      ["turn.completed", undefined],
    ]);
    expect(f.worker.turnInputs()).toHaveLength(1);
  });

  it("falls back to a new Turn and says so when the driver cannot steer", async () => {
    const f = setup(false);
    const delegated = f.app.accept(
      event("d1", "work.delegated", "w1", "long task"),
    );
    await f.started.opened;

    // Busy Session, no steering: today's behaviour, the Event waits.
    await expect(
      f.app.accept(event("s1", "work.steered", "w1", "change course")),
    ).rejects.toThrow(/Agent session is busy/);
    expect(f.worker.steerInputs()).toHaveLength(0);

    f.release.open();
    await delegated;
    // The failed attempt keeps the Event leased until it expires, as the
    // inbox retry would.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const steered = await f.app.accept(
      event("s1", "work.steered", "w1", "change course"),
    );
    expect(steered.reaction.status).toBe("completed");
    expect(f.worker.turnInputs()).toHaveLength(2);
    expect(steerItem(f.coordinator.turnInputs().slice(-1))).toEqual({
      workerId: "w1",
      status: "queued",
      reason: "idle",
    });
  });

  it("runs a steer as a new Turn when no worker Turn is running", async () => {
    const f = setup(true);
    f.release.open();
    const s = await f.app.accept(event("s0", "work.steered", "w2", "x"));
    // No Turn was running: it ran as a new Turn and reported idle.
    expect(s.reaction.status).toBe("completed");
    expect(f.worker.steerInputs()).toHaveLength(0);
    expect(steerItem(f.coordinator.turnInputs())).toMatchObject({
      status: "queued",
      reason: "idle",
    });
  });
});

describe("connector steering", () => {
  it("maps connector `steering` to a driver that sends turn.steer", async () => {
    const { makeConnectorAgentDriver } = await import("@openma/matter/agent");
    const { Effect } = await import("effect");
    const sent: unknown[] = [];
    const driver = makeConnectorAgentDriver({
      agentId: "a",
      content: () => "go left",
      connector: {
        id: "c",
        capabilities: async () => ({
          sessionPersistence: "resumable",
          streaming: true,
          cancellation: true,
          permissions: false,
          elicitation: false,
          steering: true,
        }),
        open: async () => {
          throw new Error("unused");
        },
        execute: () => {
          throw new Error("unused");
        },
        send: async (_session, command) => {
          sent.push(command);
        },
        close: async () => {},
      },
    });
    expect(await Effect.runPromise(driver.capabilities())).toMatchObject({
      steering: true,
    });
    const handle = {
      id: "s",
      raw: {
        schemaVersion: "openmatter.connector-handle.v1",
        sessionId: "s",
        idempotencyKey: "s",
        generation: 1,
        connector: {
          connectorId: "c",
          externalSessionId: "x",
          placement: "local",
        },
      },
    };
    const ack = await Effect.runPromise(
      driver.steer!({
        session: handle,
        sessionId: "s",
        turnId: "t",
        steerId: "k",
        context: {} as never,
      }),
    );
    expect(ack).toEqual({ status: "accepted" });
    expect(sent).toEqual([{ type: "turn.steer", content: "go left" }]);
  });
});
