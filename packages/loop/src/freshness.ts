// Conversation freshness for Loops: the config field a console renders as one
// control, and the policy a Loop passes to `turn({ freshness })`. See
// docs/TURN_TOOLS.md, "Freshness policy".

import type { LoopConfigScalar } from "./config.js";
import type { JsonValue } from "./json.js";
import type { FreshnessPolicy } from "./types.js";

/**
 * The presets a template offers. A Loop written as code may pass any
 * `FreshnessPolicy`, including a list of sender ids.
 */
export const FRESHNESS_PRESETS = {
  /** Newer human messages, mentions, or recalls in the message's thread. */
  thread: {
    scope: "thread",
    senders: "humans",
    kinds: ["message", "mention", "recall"],
  },
  /** Only the person who asked, in the message's thread. */
  thread_requester: {
    scope: "thread",
    senders: "requester",
    kinds: ["message", "mention", "recall"],
  },
  /** Newer human messages anywhere in the conversation. */
  conversation: {
    scope: "conversation",
    senders: "humans",
    kinds: ["message", "mention", "recall"],
  },
  /** No check: the reply is always delivered. */
  off: { scope: "thread", senders: "humans", kinds: [] },
} as const satisfies Readonly<Record<string, FreshnessPolicy>>;

export type FreshnessPreset = keyof typeof FRESHNESS_PRESETS;

/**
 * A `configSchema` field for the freshness preset, rendered by a console as
 * one control (`x-oma-widget: "freshness"`). Defaults to `thread`.
 */
export const freshnessField = (
  options: { readonly default?: FreshnessPreset; readonly title?: string } = {},
): LoopConfigScalar => ({
  type: "string",
  enum: Object.keys(FRESHNESS_PRESETS),
  default: options.default ?? "thread",
  title: options.title ?? "Reply only to the latest messages",
  description:
    "Before the Agent replies, check for newer messages. thread: newer messages from people in the thread; thread_requester: only from the person who asked; conversation: anywhere in the conversation; off: never check.",
  "x-oma-widget": "freshness",
});

/** The policy for a preset value from the config; `thread` for anything else. */
export const freshnessPolicy = (
  value: JsonValue | undefined,
): FreshnessPolicy =>
  typeof value === "string" && Object.hasOwn(FRESHNESS_PRESETS, value)
    ? FRESHNESS_PRESETS[value as FreshnessPreset]
    : FRESHNESS_PRESETS.thread;
