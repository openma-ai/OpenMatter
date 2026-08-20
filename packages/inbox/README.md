# `@openmatter/inbox`

Provider-neutral durable ingress contract for hosts that must acknowledge a
native transport before an OpenMatter application finishes processing it.

An inbox stores immutable portable envelopes, claims them with expiring fenced
leases, and records completion or a scheduled retry. It is deliberately
separate from `OpenMatterStore`: the inbox owns transport receipt and replay;
the Store owns normalized work facts, Context, Sessions, Reactions, and the
effect outbox.

```ts
interface DurableInbox {
  enqueue(item: InboxItem): Effect<"stored" | "duplicate", InboxError>;
  claim(request: InboxClaimRequest): Effect<readonly InboxClaim[], InboxError>;
  complete(itemId: string, leaseToken: string): Effect<void, InboxError>;
  retry(
    itemId: string,
    leaseToken: string,
    options: { delayMs: number; error?: string },
  ): Effect<void, InboxError>;
  renew(
    itemId: string,
    leaseToken: string,
    options: { durationMs: number },
  ): Effect<void, InboxError>;
}
```

Adapters own authoritative time and must reject stale lease tokens. Duplicate
idempotency keys may reuse the first receipt timestamp, but a different
integration, event type, ID, or body is a collision rather than a duplicate.
