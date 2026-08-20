import { describe, expect, it } from "vitest";
import {
  createOpenMAAgentDriver,
  type OpenMAConnectorLike,
  type OpenMAEventLike,
} from "../src/index.js";

const event = (type: string, data: unknown): OpenMAEventLike => {
  const completeEvent = {
    schema_version: "oma.event.v1",
    event_id: "agent-event-1",
    session_id: "external-1",
    turn_id: "turn-1",
    source: { kind: "harness", harness: "test" },
    occurred_at: "2026-08-19T08:31:00.000Z",
    type,
    data,
  };
  return completeEvent;
};

describe("createOpenMAAgentDriver", () => {
  it("maps an explicit OpenMA turn terminal event to AgentTurnHandle.result", async () => {
    const connector: OpenMAConnectorLike = {
      id: "test-openma",
      capabilities: async () => ({
        sessionPersistence: "resumable",
        streaming: true,
        cancellation: true,
        permissions: true,
        elicitation: true,
      }),
      open: async () => ({
        connectorId: "test-openma",
        externalSessionId: "external-1",
        placement: "local",
      }),
      execute: async function* () {
        yield event("turn.completed", {});
      },
      send: async () => undefined,
      close: async () => undefined,
    };
    const driver = createOpenMAAgentDriver(connector);
    const session = await driver.openSession({ agentId: "worker" });
    const turn = driver.runTurn(session, {
      turnId: "turn-1",
      executionId: "execution-1",
      contextDigest: "sha256:context",
      content: "Inspect the event",
      grants: [],
    });

    const types: string[] = [];
    for await (const item of turn.events) types.push(item.type);

    expect(types).toEqual(["turn.completed"]);
    await expect(turn.result).resolves.toEqual({ status: "completed" });
  });

  it("does not treat an unmarked stream EOF as successful completion", async () => {
    const connector: OpenMAConnectorLike = {
      id: "test-openma",
      capabilities: async () => ({
        sessionPersistence: "ephemeral",
        streaming: true,
        cancellation: true,
        permissions: false,
        elicitation: false,
      }),
      open: async () => ({
        connectorId: "test-openma",
        externalSessionId: "external-1",
        placement: "local",
      }),
      execute: async function* () {
        yield event("agent.message", { text: "partial" });
      },
      send: async () => undefined,
      close: async () => undefined,
    };
    const driver = createOpenMAAgentDriver(connector);
    const session = await driver.openSession({ agentId: "worker" });
    const turn = driver.runTurn(session, {
      turnId: "turn-1",
      executionId: "execution-1",
      contextDigest: "sha256:context",
      content: "Inspect the event",
      grants: [],
    });

    for await (const _ of turn.events) {
      // Drain the real adapter stream.
    }

    await expect(turn.result).resolves.toEqual({
      status: "failed",
      reason: "missing_terminal",
    });
  });
});
