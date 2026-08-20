import {
  createAgentSessionHandle,
  createOpenMAEvent,
  type AgentSessionInput,
  type AgentTurnInput as ConnectorTurnInput,
  type OpenMAAgentConnector,
} from "@openma/common/agent-contract";
import type { ContextProjection } from "@openmatter/core";
import { makeClaudeAgentDriver } from "@openmatter/agent-claude";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

const context: ContextProjection = {
  schemaVersion: "0.1",
  id: "context-1",
  scopeId: "scope-1",
  workThreadId: "thread-1",
  triggerEventId: "event-1",
  items: [],
  grants: ["slack.message.post"],
  digest: "sha256:context",
  createdAt: "2026-08-20T10:00:00.000Z",
};

describe("makeClaudeAgentDriver", () => {
  it("bridges durable OpenMatter identities to one OpenMA Agent Connector", async () => {
    const opens: AgentSessionInput[] = [];
    const turns: ConnectorTurnInput[] = [];
    const commands: unknown[] = [];
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: true,
          elicitation: true,
        };
      },
      async open(input) {
        opens.push(input);
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "claude-session-1",
          placement: "managed",
        });
      },
      async *execute(_session, input) {
        turns.push(input);
        yield createOpenMAEvent({
          event_id: "agent-event-1",
          type: "agent.message",
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 1,
          occurred_at: "2026-08-20T10:00:01.000Z",
          source: { kind: "harness", harness: "claude-managed" },
          data: { text: "done" },
        });
        yield createOpenMAEvent({
          event_id: "agent-event-2",
          type: "turn.completed",
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 2,
          occurred_at: "2026-08-20T10:00:02.000Z",
          source: { kind: "harness", harness: "claude-managed" },
          data: {},
        });
      },
      async send(_session, command) {
        commands.push(command);
      },
      async close() {},
    };
    const driver = makeClaudeAgentDriver({
      connector,
      agentId: "claude-code",
      content: (projection) => JSON.stringify(projection.items),
    });

    const handle = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "scope-1/thread-1",
        generation: 3,
        idempotencyKey: "session-1",
      }),
    );
    const resumed = await Effect.runPromise(driver.resumeSession(handle));
    const events = await Effect.runPromise(
      driver
        .turn({
          session: resumed,
          sessionId: "session-1",
          turnId: "turn-1",
          afterSequence: 0,
          context,
          allow: ["slack.message.post"],
        })
        .pipe(Stream.runCollect),
    );
    await Effect.runPromise(
      driver.respondToPermission({
        session: handle,
        requestId: "permission-1",
        approved: true,
      }),
    );
    await Effect.runPromise(
      driver.cancel({ session: handle, turnId: "turn-1" }),
    );

    expect(opens).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        idempotencyKey: "session-1",
        generation: 3,
        agentId: "claude-code",
      }),
      expect.objectContaining({
        sessionId: "session-1",
        idempotencyKey: "session-1",
        generation: 3,
        agentId: "claude-code",
        resume: expect.objectContaining({
          externalSessionId: "claude-session-1",
        }),
      }),
    ]);
    expect(turns).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        afterSequence: 0,
        contextDigest: "sha256:context",
        grants: ["slack.message.post"],
      }),
    ]);
    expect(Array.from(events)).toMatchObject([
      {
        schema_version: "oma.event.v1",
        event_id: "agent-event-1",
        type: "agent.message",
        session_id: "session-1",
        turn_id: "turn-1",
        seq: 1,
        data: { text: "done" },
      },
      { type: "turn.completed", seq: 2 },
    ]);
    expect(commands).toEqual([
      {
        type: "callback.respond",
        callbackId: "permission-1",
        result: { approved: true },
      },
      { type: "turn.cancel", turnId: "turn-1" },
    ]);
  });

  it("contains a synchronous connector execute failure in the Effect error channel", async () => {
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: true,
          elicitation: false,
        };
      },
      async open() {
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "external-1",
          placement: "managed",
        });
      },
      execute() {
        throw new Error("synchronous transport failure");
      },
      async send() {},
      async close() {},
    };
    const driver = makeClaudeAgentDriver({ connector, agentId: "claude" });
    const session = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "binding-1",
        generation: 1,
        idempotencyKey: "session-1",
      }),
    );

    const result = await Effect.runPromise(
      driver
        .turn({
          session,
          sessionId: "session-1",
          turnId: "turn-1",
          afterSequence: 0,
          context,
          allow: [],
        })
        .pipe(Stream.runCollect, Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });

  it("contains a malformed connector event stream in the Effect error channel", async () => {
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: false,
          elicitation: false,
        };
      },
      async open() {
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "external-1",
          placement: "managed",
        });
      },
      execute() {
        return null as never;
      },
      async send() {},
      async close() {},
    };
    const driver = makeClaudeAgentDriver({ connector, agentId: "claude" });
    const session = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "binding-1",
        generation: 1,
        idempotencyKey: "session-1",
      }),
    );

    const result = await Effect.runPromise(
      driver
        .turn({
          session,
          sessionId: "session-1",
          turnId: "turn-1",
          afterSequence: 0,
          context,
          allow: [],
        })
        .pipe(Stream.runCollect, Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });

  it("contains a broken unavailable classifier as an AgentDriverError", async () => {
    let opens = 0;
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: false,
          elicitation: false,
        };
      },
      async open() {
        opens += 1;
        if (opens > 1) throw new Error("remote resume failed");
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "external-1",
          placement: "managed",
        });
      },
      async *execute() {},
      async send() {},
      async close() {},
    };
    const driver = makeClaudeAgentDriver({
      connector,
      agentId: "claude",
      isSessionUnavailable: () => {
        throw new Error("classifier failed");
      },
    });
    const session = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "binding-1",
        generation: 1,
        idempotencyKey: "session-1",
      }),
    );

    const result = await Effect.runPromise(
      driver.resumeSession(session).pipe(Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });

  it("contains malformed connector events before reading replay fields", async () => {
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: false,
          elicitation: false,
        };
      },
      async open() {
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "external-1",
          placement: "managed",
        });
      },
      async *execute() {
        yield null as never;
      },
      async send() {},
      async close() {},
    };
    const driver = makeClaudeAgentDriver({ connector, agentId: "claude" });
    const session = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "binding-1",
        generation: 1,
        idempotencyKey: "session-1",
      }),
    );

    const result = await Effect.runPromise(
      driver
        .turn({
          session,
          sessionId: "session-1",
          turnId: "turn-1",
          afterSequence: 0,
          context,
          allow: [],
        })
        .pipe(Stream.runCollect, Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });

  it("rejects event types outside the shared OpenMA vocabulary", async () => {
    const connector: OpenMAAgentConnector = {
      id: "claude-managed",
      async capabilities() {
        return {
          sessionPersistence: "persistent",
          streaming: true,
          cancellation: true,
          permissions: false,
          elicitation: false,
        };
      },
      async open() {
        return createAgentSessionHandle({
          connectorId: "claude-managed",
          externalSessionId: "external-1",
          placement: "managed",
        });
      },
      async *execute(inputSession, input) {
        yield {
          schema_version: "oma.event.v1",
          event_id: "future-event-1",
          type: "future.unknown",
          session_id: input.sessionId,
          turn_id: input.turnId,
          source: {
            kind: "harness",
            harness: inputSession.connectorId,
          },
          occurred_at: "2026-08-20T10:00:00.000Z",
          seq: 1,
          data: {},
        } as never;
      },
      async send() {},
      async close() {},
    };
    const driver = makeClaudeAgentDriver({ connector, agentId: "claude" });
    const session = await Effect.runPromise(
      driver.createSession({
        sessionId: "session-1",
        bindingKey: "binding-1",
        generation: 1,
        idempotencyKey: "session-1",
      }),
    );

    const result = await Effect.runPromise(
      driver
        .turn({
          session,
          sessionId: "session-1",
          turnId: "turn-1",
          afterSequence: 0,
          context,
          allow: [],
        })
        .pipe(Stream.runCollect, Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });

  it("contains malformed connector capabilities in the Effect error channel", async () => {
    const connector = {
      id: "claude-managed",
      async capabilities() {
        return null;
      },
    } as unknown as OpenMAAgentConnector;
    const driver = makeClaudeAgentDriver({ connector, agentId: "claude" });

    const result = await Effect.runPromise(
      driver.capabilities().pipe(Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentDriverError" },
    });
  });
});
