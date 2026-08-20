import type { TimerAdapter } from "@openmatter/core";
import type {
  CloudflareLikeDependencies,
  CloudflareLikeEnvironment,
  QueuePort,
} from "../src/cloudflare.js";
import type { OpenMatterJob } from "../src/jobs.js";

// Relevant shapes from @cloudflare/workers-types 5.20260820.1. This fixture
// catches accidental incompatibility without making Cloudflare a dependency of
// the deployment-neutral SDK packages.
interface NativeQueueBinding<T> {
  send(message: T): Promise<{
    readonly metadata: {
      readonly metrics: { readonly backlogCount: number };
    };
  }>;
}

interface NativeScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface GeneratedEnvironment extends CloudflareLikeEnvironment {
  readonly OPENMATTER_JOBS: NativeQueueBinding<OpenMatterJob>;
}

declare const queue: NativeQueueBinding<OpenMatterJob>;
const queuePort: QueuePort<OpenMatterJob> = queue;
void queuePort;

declare const timer: TimerAdapter<NativeScheduledController>;
declare const createRuntime: CloudflareLikeDependencies<
  GeneratedEnvironment,
  NativeScheduledController
>["createRuntime"];
declare const webhook: CloudflareLikeDependencies<
  GeneratedEnvironment,
  NativeScheduledController
>["webhook"];

const dependencies: CloudflareLikeDependencies<
  GeneratedEnvironment,
  NativeScheduledController
> = {
  createRuntime,
  webhook,
  timer,
};
void dependencies;
