// Records a Loop sees and returns. They are structurally identical to the
// `@openma/matter` schemas of the same name, written out here so Loop code
// needs no dependency (`@openma/matter/runtime` checks both directions at compile
// time). Everything is portable JSON, so it can cross an isolate boundary.

import type { JsonValue } from "./json.js";

export interface SourceAnchor {
  readonly provider: string;
  readonly authority: string;
  readonly conversationId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly uri?: string | undefined;
}

export interface WorkEvent {
  readonly schemaVersion: string;
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly idempotencyKey: string;
  readonly source: SourceAnchor;
  readonly payload?: JsonValue | undefined;
  readonly raw?: JsonValue | undefined;
  readonly extensions?: { readonly [key: string]: JsonValue } | undefined;
}

export interface ContextProvenance {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly integrationId?: string | undefined;
  readonly uri?: string | undefined;
}

export interface ContextItem {
  readonly id: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly provenance: readonly ContextProvenance[];
}

export interface ContextProjection {
  readonly schemaVersion: string;
  readonly id: string;
  readonly scopeId: string;
  readonly workThreadId: string;
  readonly triggerEventId: string;
  readonly items: readonly ContextItem[];
  readonly grants: readonly string[];
  readonly digest: string;
  readonly createdAt: string;
}

export interface WorkEffect {
  readonly schemaVersion: string;
  readonly id: string;
  readonly eventId: string;
  readonly integrationId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
}

export interface EffectInput {
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
}

export interface ReactionDraft {
  readonly status: "completed" | "failed" | "cancelled";
  readonly effects: readonly WorkEffect[];
  readonly reason?: string;
}

export interface ProjectContextInput {
  readonly scopeId: string;
  readonly workThreadId: string;
  readonly items: readonly ContextItem[];
  readonly grants?: readonly string[];
}

export interface AgentSessionBinding {
  readonly scopeId: string;
  readonly workThreadId: string;
  readonly authority?: string;
  readonly privacyPartition: string;
}

export interface AgentTurnInput {
  readonly context: ContextProjection;
  readonly allow?: readonly string[];
}

/**
 * The outcome of one Agent Turn as a Loop sees it. The host keeps the full
 * Session, Turn, and event records; a Loop gets their identities, the
 * outcome, the output, and the Agent events as JSON.
 */
export interface AgentTurnSummary {
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly output?: JsonValue;
  readonly events: readonly JsonValue[];
}

export interface AgentCancellation {
  readonly status: "requested" | "idle";
  readonly turnId?: string;
}
