import type { WorkEventRef } from "@openmatter/core";

/** Application-owned queue payloads. They are ordinary JSON, not a required
 * OpenMatter transport protocol. */
export type OpenMatterJob =
  | {
      readonly kind: "event.process";
      readonly event: WorkEventRef;
    }
  | {
      readonly kind: "operation.deliver";
      readonly callId: string;
    };
