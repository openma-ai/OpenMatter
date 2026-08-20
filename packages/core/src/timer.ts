import type { WorkEventDecoder } from "./work-adapter.js";

/**
 * Converts one host-native timer occurrence into ordinary WorkEvents.
 * Schedule registration, wake-up, retries, and overlap policy remain host-owned.
 */
export interface TimerAdapter<TOccurrence = unknown>
  extends WorkEventDecoder<TOccurrence> {
  readonly id: string;
}
