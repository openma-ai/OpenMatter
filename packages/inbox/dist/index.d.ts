import { Effect } from "effect";
import { JsonValue } from "@openmatter/core";
//#region src/index.d.ts
declare const InboxError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "InboxError";
} & Readonly<A>;
declare class InboxError extends InboxError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
interface InboxItem {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly body: JsonValue;
  readonly receivedAt: string;
}
interface InboxLease {
  readonly token: string;
  readonly ownerId: string;
  readonly expiresAt: string;
}
interface InboxClaim {
  readonly item: InboxItem;
  readonly attempt: number;
  readonly lease: InboxLease;
}
interface InboxClaimRequest {
  readonly ownerId: string;
  readonly durationMs: number;
  readonly limit: number;
}
interface DurableInbox {
  readonly enqueue: (item: InboxItem) => Effect.Effect<"stored" | "duplicate", InboxError>;
  readonly claim: (request: InboxClaimRequest) => Effect.Effect<readonly InboxClaim[], InboxError>;
  readonly complete: (itemId: string, leaseToken: string) => Effect.Effect<void, InboxError>;
  readonly retry: (itemId: string, leaseToken: string, input: {
    readonly delayMs: number;
    readonly error?: string;
  }) => Effect.Effect<void, InboxError>;
  readonly renew: (itemId: string, leaseToken: string, input: {
    readonly durationMs: number;
  }) => Effect.Effect<void, InboxError>;
}
//#endregion
export { DurableInbox, InboxClaim, InboxClaimRequest, InboxError, InboxItem, InboxLease };
//# sourceMappingURL=index.d.ts.map