import {
  JsonValueSchema,
  WorkEventSchema,
  WorkEffectSchema,
} from "@openmatter/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("OpenMatter JSON contracts", () => {
  it("rejects a work event without an idempotency key", () => {
    expect(
      Schema.is(WorkEventSchema)({
        schemaVersion: "0.1",
        id: "event-1",
        type: "chat.message.received",
        occurredAt: "2026-08-20T08:00:00.000Z",
        receivedAt: "2026-08-20T08:00:01.000Z",
        source: {
          provider: "chat",
          authority: "workspace-1",
        },
      }),
    ).toBe(false);
  });

  it("rejects an effect without its target integration", () => {
    expect(
      Schema.is(WorkEffectSchema)({
        schemaVersion: "0.1",
        id: "effect-1",
        eventId: "event-1",
        operation: "message.reply",
        idempotencyKey: "event-1:effect:1",
        input: { text: "hello" },
      }),
    ).toBe(false);
  });

  it("rejects non-portable values at the durable JSON boundary", () => {
    expect(Schema.is(JsonValueSchema)(new Map([["key", "value"]]))).toBe(false);
    expect(Schema.is(JsonValueSchema)({ nested: [1, true, null] })).toBe(true);
  });
});
