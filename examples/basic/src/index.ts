import { createWorkEvent } from "@openmatter/core";
import { createOpenMatterRuntime } from "@openmatter/runtime";
import { createMemoryStore, createMockWorkAdapter } from "@openmatter/testing";

const profile = {
  id: "urn:openmatter:profile:example",
  version: "0.1.0",
  digest: "sha256:example-v1",
} as const;

const event = createWorkEvent({
  id: "evt-1",
  source: "urn:example:workspace-1",
  type: "example.issue.updated",
  time: new Date().toISOString(),
  binding: {
    profile,
    surfaceId: "example",
    authorityId: "workspace-1",
    definitionId: "issue.updated",
  },
  payload: { issueId: "WEB-42" },
});

const store = createMemoryStore();
const work = createMockWorkAdapter({
  id: "example-work",
  operations: {
    "message.reply": {
      status: "succeeded",
      output: { messageId: "message-1" },
    },
  },
});
const runtime = createOpenMatterRuntime({
  store,
  operations: work.operations,
  ownerId: "example-runtime",
  decide: async () => ({
    reason: "reply requested",
    operations: [
      {
        callId: "call-1",
        operation: {
          profile,
          surfaceId: "example",
          authorityId: "workspace-1",
          operationId: "message.reply",
        },
        input: { text: "Issue WEB-42 was observed." },
      },
    ],
  }),
});

const receipt = await runtime.accept(event);
console.log(JSON.stringify(receipt, null, 2));
