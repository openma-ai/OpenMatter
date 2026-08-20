import { makeMockAgentDriver } from "@openmatter/agent-mock";
import { makeMockIntegration } from "@openmatter/integration-mock";
import { createOpenMatter } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";

const chat = makeMockIntegration({ id: "chat" });
const worker = makeMockAgentDriver({
  id: "worker",
  output: "Hello from OpenMatter",
});
const app = createOpenMatter({
  store: makeMemoryStore(),
  integrations: { chat: chat.integration },
  agents: { worker: worker.driver },
});

app.on("chat.message.received", (work) =>
  Effect.gen(function* () {
    const context = yield* work.context.project({
      scopeId: "workspace:example",
      workThreadId: "thread:welcome",
      items: [work.context.event()],
      grants: ["chat.message.reply"],
    });
    const result = yield* work
      .agent("worker")
      .session({
        scopeId: context.scopeId,
        workThreadId: context.workThreadId,
        privacyPartition: "team",
      })
      .turn({ context, allow: context.grants });
    const reply = yield* work.effect(context, {
      integrationId: "chat",
      operation: "message.reply",
      input: { text: result.output ?? null },
    });
    return work.react.effects([reply]);
  }),
);

export const receipt = await app.acceptFrom("chat", {
  id: "message-1",
  type: "message.received",
  authority: "workspace-1",
  conversationId: "general",
  messageId: "message-1",
  occurredAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  payload: { text: "Say hello" },
});

console.log(JSON.stringify(receipt, null, 2));
