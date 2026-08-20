import type { JsonValue } from "./json.js";
import type { OperationRef } from "./profile.js";

export type AgentPlacement = "local" | "remote" | "managed";

export interface AgentCapabilities {
  readonly sessionPersistence: "ephemeral" | "resumable" | "persistent";
  readonly streaming: boolean;
  readonly cancellation: boolean;
  readonly permissions: boolean;
  readonly elicitation: boolean;
  readonly steering?: boolean;
  readonly customTools?: boolean;
  readonly mcp?: boolean;
}

export interface AgentSessionInput {
  readonly agentId: string;
  readonly cwd?: string;
  readonly additionalDirectories?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AgentSessionHandle {
  readonly driverId: string;
  readonly externalSessionId: string;
  readonly placement: AgentPlacement;
  readonly resumeToken?: string;
}

export interface AgentContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type AgentContent = string | readonly AgentContentBlock[];

export interface AgentTurnInput {
  readonly turnId: string;
  readonly executionId: string;
  readonly contextDigest: string;
  readonly content: AgentContent;
  readonly grants: readonly OperationRef[];
}

export interface AgentTurnResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly reason?: string;
}

export interface AgentTurnHandle<TEvent = unknown> {
  readonly events: AsyncIterable<TEvent>;
  readonly result: Promise<AgentTurnResult>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentDriver<TEvent = unknown> {
  readonly id: string;
  capabilities(): Promise<AgentCapabilities>;
  openSession(input: AgentSessionInput): Promise<AgentSessionHandle>;
  runTurn(
    session: AgentSessionHandle,
    input: AgentTurnInput,
  ): AgentTurnHandle<TEvent>;
  closeSession(session: AgentSessionHandle): Promise<void>;
}
