import {
  StoreError,
  type LeaseRequest,
  type LeaseRenewal,
} from "@openmatter/store";
import { Duration, Effect } from "effect";

export interface LeaseRuntime {
  readonly request: (durationMs: number) => LeaseRequest;
  readonly withHeartbeat: <A, E>(
    operation: Effect.Effect<A, E>,
    durationMs: number,
    renew: (renewal: LeaseRenewal) => Effect.Effect<void, StoreError>,
  ) => Effect.Effect<A, E | StoreError>;
}

export const makeLeaseRuntime = (input: {
  readonly runtimeId: string;
}): LeaseRuntime => {
  const renewal = (durationMs: number): LeaseRenewal => ({ durationMs });

  return {
    request: (durationMs) => ({
      ownerId: input.runtimeId,
      durationMs,
    }),
    withHeartbeat: (operation, durationMs, renew) => {
      const intervalMs = Math.max(1, Math.floor(durationMs / 3));
      const heartbeat: Effect.Effect<never, StoreError> = Effect.forever(
        Effect.sleep(Duration.millis(intervalMs)).pipe(
          Effect.zipRight(Effect.suspend(() => renew(renewal(durationMs)))),
        ),
      );
      return Effect.raceFirst(operation, heartbeat);
    },
  };
};
