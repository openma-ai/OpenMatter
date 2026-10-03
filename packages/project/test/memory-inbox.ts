import type { JsonValue } from "@openmatter/core";
import {
  type DurableInbox,
  type InboxClaim,
  type InboxItem,
} from "@openmatter/inbox";
import { Effect } from "effect";

export const makeMemoryInbox = (): DurableInbox & {
  readonly items: InboxItem[];
} => {
  const items: InboxItem[] = [];
  const inbox: DurableInbox = {
    enqueue: (item) =>
      Effect.sync(() => {
        if (
          items.some(
            (existing) => existing.idempotencyKey === item.idempotencyKey,
          )
        ) {
          return "duplicate" as const;
        }
        items.push(structuredClone(item) as InboxItem);
        return "stored" as const;
      }),
    claim: () => Effect.succeed([] as readonly InboxClaim[]),
    complete: () => Effect.void,
    retry: () => Effect.void,
    renew: () => Effect.void,
  };
  return { ...inbox, items };
};

export type { JsonValue };
