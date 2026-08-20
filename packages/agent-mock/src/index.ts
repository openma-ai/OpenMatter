import type { AgentDriver, OpenMAEvent } from "@openmatter/agent";
import { Effect, Stream } from "effect";

export interface MockAgentDriver {
  readonly driver: AgentDriver;
  readonly permissionResponses: () => readonly {
    readonly requestId: string;
    readonly approved: boolean;
  }[];
  readonly cancelledTurns: () => readonly string[];
  readonly createdSessions: () => number;
}

export const makeMockAgentDriver = (options: {
  readonly id: string;
  readonly output: string;
  readonly omitTerminal?: boolean;
  readonly neverComplete?: boolean;
  readonly terminalType?:
    "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted";
  readonly permissionRequestId?: string;
  readonly resume?: boolean;
}): MockAgentDriver => {
  let nextSession = 1;
  const permissionResponses: Array<{
    readonly requestId: string;
    readonly approved: boolean;
  }> = [];
  const cancelledTurns: string[] = [];
  const sessionsByIdempotencyKey = new Map<string, { readonly id: string }>();

  const driver: AgentDriver = {
    id: options.id,
    capabilities: () =>
      Effect.succeed({
        resume: options.resume ?? true,
        cancel: true,
        permissions: true,
        concurrentTurns: false,
      }),
    createSession: ({ idempotencyKey }) =>
      Effect.sync(() => {
        const existing = sessionsByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return existing;
        const created = { id: `${options.id}-session-${nextSession++}` };
        sessionsByIdempotencyKey.set(idempotencyKey, created);
        return created;
      }),
    resumeSession: (handle) => Effect.succeed(handle),
    turn: (input) => {
      if (options.neverComplete) return Stream.never;
      const timestamp = new Date().toISOString();
      const events: readonly OpenMAEvent[] = [
        ...(options.permissionRequestId === undefined
          ? []
          : [
              {
                schemaVersion: "0.1",
                id: `${input.turnId}:permission`,
                sessionId: input.sessionId,
                turnId: input.turnId,
                sequence: 1,
                type: "permission.requested",
                timestamp,
                payload: { requestId: options.permissionRequestId },
              } satisfies OpenMAEvent,
            ]),
        {
          schemaVersion: "0.1",
          id: `${input.turnId}:output`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          sequence: options.permissionRequestId === undefined ? 1 : 2,
          type: "assistant.output",
          timestamp,
          payload: { text: options.output },
        },
        ...(options.omitTerminal
          ? []
          : [
              {
                schemaVersion: "0.1",
                id: `${input.turnId}:terminal`,
                sessionId: input.sessionId,
                turnId: input.turnId,
                sequence: options.permissionRequestId === undefined ? 2 : 3,
                type: options.terminalType ?? "turn.completed",
                timestamp,
                payload: {},
              } satisfies OpenMAEvent,
            ]),
      ];
      return Stream.fromIterable(
        events.filter((event) => event.sequence > input.afterSequence),
      );
    },
    respondToPermission: ({ requestId, approved }) =>
      Effect.sync(() => {
        permissionResponses.push({ requestId, approved });
      }),
    cancel: ({ turnId }) =>
      Effect.sync(() => {
        cancelledTurns.push(turnId);
      }),
    closeSession: () => Effect.void,
  };

  return {
    driver,
    permissionResponses: () => [...permissionResponses],
    cancelledTurns: () => [...cancelledTurns],
    createdSessions: () => nextSession - 1,
  };
};
