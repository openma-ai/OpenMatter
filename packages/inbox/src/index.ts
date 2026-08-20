import type { JsonValue } from "@openmatter/core";
import { Data, type Effect } from "effect";

export class InboxError extends Data.TaggedError("InboxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface InboxItem {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly body: JsonValue;
  readonly receivedAt: string;
}

export interface InboxLease {
  readonly token: string;
  readonly ownerId: string;
  readonly expiresAt: string;
}

export interface InboxClaim {
  readonly item: InboxItem;
  readonly attempt: number;
  readonly lease: InboxLease;
}

export interface InboxClaimRequest {
  readonly ownerId: string;
  readonly durationMs: number;
  readonly limit: number;
}

export interface DurableInbox {
  readonly enqueue: (
    item: InboxItem,
  ) => Effect.Effect<"stored" | "duplicate", InboxError>;
  readonly claim: (
    request: InboxClaimRequest,
  ) => Effect.Effect<readonly InboxClaim[], InboxError>;
  readonly complete: (
    itemId: string,
    leaseToken: string,
  ) => Effect.Effect<void, InboxError>;
  readonly retry: (
    itemId: string,
    leaseToken: string,
    input: { readonly delayMs: number; readonly error?: string },
  ) => Effect.Effect<void, InboxError>;
  readonly renew: (
    itemId: string,
    leaseToken: string,
    input: { readonly durationMs: number },
  ) => Effect.Effect<void, InboxError>;
}
