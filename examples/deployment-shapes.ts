import type { AgentDriver } from "@openmatter/agent";
import type { WorkEvent } from "@openmatter/core";
import type { WorkIntegration } from "@openmatter/integration";
import { createOpenMatter } from "@openmatter/runtime";
import type { OpenMatterStore } from "@openmatter/store";
import { Effect } from "effect";

export interface ApplicationPorts {
  readonly store: OpenMatterStore;
  readonly chat: WorkIntegration;
  readonly worker: AgentDriver;
}

export const buildApplication = (ports: ApplicationPorts) => {
  const app = createOpenMatter({
    store: ports.store,
    integrations: { chat: ports.chat },
    agents: { worker: ports.worker },
  });

  app.on("chat.message.received", (work) =>
    Effect.gen(function* () {
      const scopeId = `authority:${work.event.source.authority}`;
      const workThreadId =
        work.event.source.threadId ??
        work.event.source.conversationId ??
        work.event.id;
      const context = yield* work.context.project({
        scopeId,
        workThreadId,
        items: [work.context.event()],
        grants: ["chat.message.reply"],
      });
      const turn = yield* work
        .agent("worker")
        .session({ scopeId, workThreadId, privacyPartition: "workspace" })
        .turn({ context, allow: context.grants });

      const effect = yield* work.effect(context, {
        integrationId: "chat",
        operation: "message.reply",
        input: { content: turn.output ?? null },
      });
      return work.react.effects([effect]);
    }),
  );

  return app;
};

// A serverless host constructs the app from environment-specific ports for
// each isolate or request and calls this pure request-shaped boundary.
export const makeServerlessHandler = (ports: ApplicationPorts) => {
  const app = buildApplication(ports);
  return (nativeEvent: unknown) => app.acceptFrom("chat", nativeEvent);
};

// A Node, Bun, Deno, container, or worker process supplies its own event
// source. Reconnect and transport policy stay in that source adapter.
export const runLongLived = (
  ports: ApplicationPorts,
  events: AsyncIterable<WorkEvent>,
) => buildApplication(ports).consume(events, { concurrency: 8 });
