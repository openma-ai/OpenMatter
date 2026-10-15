// A Loop module as a host would bundle it into an isolate: its only import
// is `@openma/matter-loop`, and it is the module's default export.
import { defineLoop } from "@openma/matter-loop";

export default defineLoop(
  {
    id: "guest-reply",
    version: "0.1.0",
    description:
      "Ask an Agent to answer a chat message and reply with its output",
    spec: { sources: ["chat.message.received"], reaction: "effects" },
    configSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1 },
        prefix: { type: "string", default: "" },
      },
      required: ["agentId"],
    },
    runAs: "app",
  },
  (app, { config }) =>
    app.on("chat.message.received", async (work) => {
      const context = await work.context.project({
        scopeId: "scope-1",
        workThreadId: work.event.source.conversationId ?? work.event.id,
        items: [work.context.event()],
        grants: ["chat.message.reply"],
      });
      const turn = await work
        .agent(String(config.agentId))
        .session({
          scopeId: "scope-1",
          workThreadId: context.workThreadId,
          privacyPartition: "team",
        })
        .turn({ context, allow: ["chat.message.reply"] });
      const reply = await work.effect(context, {
        integrationId: "chat",
        operation: "message.reply",
        input: { text: `${String(config.prefix)}${String(turn.output ?? "")}` },
      });
      return work.react.effects([reply], `turn ${turn.outcome}`);
    }),
);
