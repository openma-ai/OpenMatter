import type {
  TimerAdapter,
  WorkEvent,
  WorkEventDecoder,
} from "@openmatter/core";
import type { OpenMatterRuntime } from "@openmatter/runtime";
import type { OpenMatterJob } from "./jobs.js";

export interface QueuePort<T> {
  send(message: T): Promise<unknown>;
}

export interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}

export interface QueueBatch<T> {
  readonly messages: readonly QueueMessage<T>[];
}

export interface CloudflareLikeEnvironment {
  readonly OPENMATTER_JOBS: QueuePort<OpenMatterJob>;
}

export interface CloudflareLikeDependencies<
  TEnvironment extends CloudflareLikeEnvironment,
  TOccurrence,
> {
  /** Construct a Runtime with the application's durable Store and bindings. */
  readonly createRuntime: (environment: TEnvironment) => OpenMatterRuntime;
  readonly webhook: WorkEventDecoder<Request>;
  readonly timer: TimerAdapter<TOccurrence>;
}

async function ingestAndEnqueue(
  runtime: OpenMatterRuntime,
  queue: QueuePort<OpenMatterJob>,
  events: readonly WorkEvent[],
): Promise<void> {
  for (const event of events) {
    const receipt = await runtime.ingest(event);
    await queue.send({ kind: "event.process", event: receipt.event });
  }
}

/**
 * Cloudflare-shaped example using only Web Platform types and tiny structural
 * queue types. The same composition works with another serverless host.
 */
export function createCloudflareLikeEntrypoint<
  TEnvironment extends CloudflareLikeEnvironment,
  TOccurrence,
>(dependencies: CloudflareLikeDependencies<TEnvironment, TOccurrence>) {
  return {
    fetch: async (
      request: Request,
      environment: TEnvironment,
    ): Promise<Response> => {
      const runtime = dependencies.createRuntime(environment);
      const events = await dependencies.webhook.decode(request);
      await ingestAndEnqueue(
        runtime,
        environment.OPENMATTER_JOBS,
        events,
      );
      return new Response(null, { status: 202 });
    },

    scheduled: async (
      occurrence: TOccurrence,
      environment: TEnvironment,
    ): Promise<void> => {
      const runtime = dependencies.createRuntime(environment);
      const events = await dependencies.timer.decode(occurrence);
      await ingestAndEnqueue(
        runtime,
        environment.OPENMATTER_JOBS,
        events,
      );
    },

    queue: async (
      batch: QueueBatch<OpenMatterJob>,
      environment: TEnvironment,
    ): Promise<void> => {
      const runtime = dependencies.createRuntime(environment);
      for (const message of batch.messages) {
        try {
          if (message.body.kind === "event.process") {
            const processed = await runtime.process(message.body.event);
            if (processed.status !== "completed") {
              message.retry();
              continue;
            }
            for (const callId of processed.reaction.operationCallIds) {
              await environment.OPENMATTER_JOBS.send({
                kind: "operation.deliver",
                callId,
              });
            }
          } else {
            const delivered = await runtime.deliver(message.body.callId);
            if (delivered.status !== "completed") {
              message.retry();
              continue;
            }
          }
          message.ack();
        } catch {
          message.retry();
        }
      }
    },
  };
}
