import type {
  TimerAdapter,
  WorkEventSource,
} from "@openmatter/core";
import type { OpenMatterRuntime } from "@openmatter/runtime";

export interface NodeTimerOccurrence {
  readonly id: string;
  readonly scheduledAt: string;
}

export interface EmbeddedNodeOptions {
  readonly runtime: OpenMatterRuntime;
  readonly source: WorkEventSource;
  readonly timer: TimerAdapter<NodeTimerOccurrence>;
  readonly intervalMs: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

/**
 * Example host composition for a long-lived Node process. OpenMatter does not
 * own the process, signal handlers, or timer; it only handles normalized events.
 */
export function startEmbeddedNode(
  options: EmbeddedNodeOptions,
): { readonly stop: () => Promise<void> } {
  const abort = new AbortController();
  const now = options.now ?? (() => new Date());
  const source = options.source.start(
    async (event) => {
      await options.runtime.accept(event);
    },
    abort.signal,
  );
  const timer = setInterval(() => {
    const firedAt = now();
    const occurrence: NodeTimerOccurrence = {
      id: `${options.timer.id}:${firedAt.toISOString()}`,
      scheduledAt: firedAt.toISOString(),
    };
    void options.timer
      .decode(occurrence)
      .then(async (events) => {
        for (const event of events) {
          await options.runtime.accept(event);
        }
      })
      .catch((error: unknown) => options.onError?.(error));
  }, options.intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      abort.abort();
      await source;
    },
  };
}
