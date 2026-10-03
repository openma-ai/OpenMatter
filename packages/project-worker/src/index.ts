import { pathToFileURL } from "node:url";
import { workerConfigFromEnv } from "./config.js";
import { ProjectWorkerServer } from "./http.js";

export { workerConfigFromEnv, type WorkerConfig } from "./config.js";
export { ProjectWorker } from "./coordinator.js";
export { ProjectWorkerServer } from "./http.js";
export { makeMysqlStore } from "@openmatter/store-mysql";

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = new ProjectWorkerServer(workerConfigFromEnv());
  const address = await server.listen();
  console.log(`project-worker listening on ${address.url}`);
}
