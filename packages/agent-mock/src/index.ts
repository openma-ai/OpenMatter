import type { JsonValue } from "@openma/matter";
import {
  createOpenMAEvent,
  OPERATION_CALL_METHOD,
  type AgentDriver,
  type AgentSteerInput,
  type AgentTurnInput,
  type OpenMAEvent,
} from "@openma/matter/agent";
import { Effect, Stream } from "effect";

export interface MockAgentDriver {
  readonly driver: AgentDriver;
  readonly permissionResponses: () => readonly {
    readonly requestId: string;
    readonly approved: boolean;
  }[];
  readonly callbackResponses: () => readonly {
    readonly callbackId: string;
    readonly result: JsonValue;
  }[];
  readonly turnInputs: () => readonly AgentTurnInput[];
  readonly cancelledTurns: () => readonly string[];
  /** Steers the driver accepted, in order, deduplicated by steerId. */
  readonly steerInputs: () => readonly AgentSteerInput[];
  readonly createdSessions: () => number;
}

/** An operation the mock Agent calls before it answers. */
export interface MockOperationCall {
  readonly callId: string;
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
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
  /** Emitted as operation-call callbacks, in order, before the output. */
  readonly operationCalls?: readonly MockOperationCall[];
  /** Defaults to true when `operationCalls` is set. */
  readonly operations?: boolean;
  /** Awaited at the start of each Turn, before any event: the world moving
   * while the Agent works. */
  readonly beforeEvents?: (input: AgentTurnInput) => Promise<void>;
  /** Declares `steering` and implements `steer`: a steer is accepted while
   * its Turn has not emitted its output, and shows up in that Turn as an
   * `agent.message` with `steered` before the output. */
  readonly steering?: boolean;
}): MockAgentDriver => {
  const steerInputs: AgentSteerInput[] = [];
  const openTurns = new Map<string, AgentSteerInput[]>();
  let nextSession = 1;
  const permissionResponses: Array<{
    readonly requestId: string;
    readonly approved: boolean;
  }> = [];
  const cancelledTurns: string[] = [];
  const callbackResponses: Array<{
    readonly callbackId: string;
    readonly result: JsonValue;
  }> = [];
  const turnInputs: AgentTurnInput[] = [];
  const sessionsByIdempotencyKey = new Map<string, { readonly id: string }>();

  const driver: AgentDriver = {
    id: options.id,
    capabilities: () =>
      Effect.succeed({
        resume: options.resume ?? true,
        cancel: true,
        permissions: true,
        concurrentTurns: false,
        operations: options.operations ?? options.operationCalls !== undefined,
        ...(options.steering === undefined
          ? {}
          : { steering: options.steering }),
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
      turnInputs.push(input);
      openTurns.set(input.turnId, []);
      if (options.neverComplete) return Stream.never;
      const timestamp = new Date().toISOString();
      let seq = 0;
      const event = (
        suffix: string,
        type: string,
        data: Record<string, unknown>,
      ): OpenMAEvent =>
        createOpenMAEvent({
          event_id: `${input.turnId}:${suffix}`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: ++seq,
          type,
          occurred_at: timestamp,
          source: { kind: "harness", harness: options.id },
          data,
        } as Parameters<typeof createOpenMAEvent>[0]) as OpenMAEvent;
      const build = (): readonly OpenMAEvent[] => {
        const steered = openTurns.get(input.turnId) ?? [];
        openTurns.delete(input.turnId);
        return [
          ...(options.permissionRequestId === undefined
            ? []
            : [
                event("permission", "callback.requested", {
                  callback_id: options.permissionRequestId,
                  fingerprint: `${input.turnId}:${options.permissionRequestId}`,
                  method: "permission.request",
                  category: "permission",
                }),
              ]),
          ...(options.operationCalls ?? []).map((call) =>
            event(`call:${call.callId}`, "callback.requested", {
              callback_id: call.callId,
              fingerprint: `${input.turnId}:${call.callId}:${JSON.stringify([
                call.integrationId,
                call.operation,
                call.input,
              ])}`,
              method: OPERATION_CALL_METHOD,
              category: "extension",
              params: {
                integrationId: call.integrationId,
                operation: call.operation,
                input: call.input,
              },
            }),
          ),
          ...steered.map((steer) =>
            event(`steer:${steer.steerId}`, "agent.message", {
              text: `steered:${steer.steerId}`,
              steered: steer.steerId,
            }),
          ),
          event("output", "agent.message", { text: options.output }),
          ...(options.omitTerminal
            ? []
            : [
                event("terminal", options.terminalType ?? "turn.completed", {}),
              ]),
        ];
      };
      const stream = Stream.suspend(() =>
        Stream.fromIterable(
          build().filter((item) => (item.seq ?? 0) > input.afterSequence),
        ),
      );
      const before = options.beforeEvents;
      return before === undefined
        ? stream
        : Stream.unwrap(
            Effect.promise(() => before(input)).pipe(Effect.as(stream)),
          );
    },
    respondToPermission: ({ requestId, approved }) =>
      Effect.sync(() => {
        permissionResponses.push({ requestId, approved });
      }),
    respondToCallback: ({ callbackId, result }) =>
      Effect.sync(() => {
        callbackResponses.push({ callbackId, result });
      }),
    ...(options.steering
      ? {
          steer: (input: AgentSteerInput) =>
            Effect.sync(() => {
              const open = openTurns.get(input.turnId);
              if (open === undefined) {
                return {
                  status: "rejected" as const,
                  reason: "Turn is not running",
                };
              }
              if (!steerInputs.some((s) => s.steerId === input.steerId)) {
                steerInputs.push(input);
                open.push(input);
              }
              return { status: "accepted" as const };
            }),
        }
      : {}),
    cancel: ({ turnId }) =>
      Effect.sync(() => {
        cancelledTurns.push(turnId);
      }),
    closeSession: () => Effect.void,
  };

  return {
    driver,
    permissionResponses: () => [...permissionResponses],
    callbackResponses: () => [...callbackResponses],
    turnInputs: () => [...turnInputs],
    cancelledTurns: () => [...cancelledTurns],
    steerInputs: () => [...steerInputs],
    createdSessions: () => nextSession - 1,
  };
};
