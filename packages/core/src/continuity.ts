import type { AgentSessionHandle } from "./agent.js";
import type { JsonValue } from "./json.js";

export interface AgentSessionSnapshot {
  readonly key: string;
  readonly agentId: string;
  readonly scopeId: string;
  readonly threadId: string;
  readonly privacyPartition?: string;
  readonly state: "open" | "closed";
  readonly handle: AgentSessionHandle;
  readonly updatedAt: string;
}

export interface AgentSessionRecord extends AgentSessionSnapshot {
  readonly revision: number;
}

export interface SaveAgentSessionInput {
  readonly expectedRevision: number | null;
  readonly session: AgentSessionSnapshot;
}

export interface AgentSessionStore {
  get(key: string): Promise<AgentSessionRecord | undefined>;
  save(input: SaveAgentSessionInput): Promise<AgentSessionRecord>;
}

export interface CheckpointSnapshot {
  readonly namespace: string;
  readonly key: string;
  readonly value: JsonValue;
  readonly updatedAt: string;
}

export interface CheckpointRecord extends CheckpointSnapshot {
  readonly revision: number;
}

export interface SaveCheckpointInput {
  readonly expectedRevision: number | null;
  readonly checkpoint: CheckpointSnapshot;
}

export interface CheckpointStore {
  get(namespace: string, key: string): Promise<CheckpointRecord | undefined>;
  save(input: SaveCheckpointInput): Promise<CheckpointRecord>;
}
