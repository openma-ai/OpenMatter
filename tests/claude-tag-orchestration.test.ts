import { makeMockAgentDriver } from "@openmatter/agent-mock";
import { createOpenMatter } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeSlackIntegration } from "../packages/integration-slack/src/index.js";
import { installClaudeTag } from "../packages/orchestration/src/index.js";

describe("built-in Claude Tag orchestration", () => {
  it("turns a channel mention into one thread-scoped agent turn and reply", async () => {
    const posted: unknown[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, channel: "C01", ts: "reply-ts" }),
        );
      }) as typeof fetch,
    });
    const store = makeMemoryStore({
      clock: () => "2026-08-20T10:00:00.000Z",
    });
    const claude = makeMockAgentDriver({
      id: "claude",
      output: "The failing build comes from the checkout timeout.",
    });
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: { claude: claude.driver },
      clock: () => "2026-08-20T10:00:00.000Z",
    });
    installClaudeTag(app, { agentId: "claude" });

    const receipts = await app.acceptFrom("slack", {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "Ev01",
      event_time: 1724140800,
      event: {
        type: "app_mention",
        user: "U01",
        text: "<@BCLAUDE> investigate the failed build",
        ts: "1724140800.123456",
        channel: "C01",
        event_ts: "1724140800.123456",
      },
    });
    const snapshot = await Effect.runPromise(store.inspect);

    expect(receipts[0]?.reaction.status).toBe("completed");
    expect(posted).toEqual([
      {
        channel: "C01",
        thread_ts: "1724140800.123456",
        text: "The failing build comes from the checkout timeout.",
      },
    ]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        agentId: "claude",
        authority: "TWORK",
        scopeId: "slack:TWORK:channel:C01",
        workThreadId: "slack:TWORK:C01:thread:1724140800.123456",
        privacyPartition: "slack:TWORK:channel:C01",
      }),
    ]);
  });

  it("carries the Slack authority into built-in Effects for dynamic credentials", async () => {
    const authorizations: Array<string | null> = [];
    const slack = makeSlackIntegration({
      credentials: async (teamId) => ({
        botToken: `token-${teamId}`,
        botUserId: `BOT-${teamId}`,
      }),
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });
    const store = makeMemoryStore();
    const claude = makeMockAgentDriver({ id: "claude", output: "done" });
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: { claude: claude.driver },
    });
    installClaudeTag(app, { agentId: "claude" });

    await app.acceptFrom("slack", {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvDynamicAuthority",
      event: {
        type: "app_mention",
        user: "U01",
        text: "<@BOT-TWORK> investigate",
        ts: "1724140800.123456",
        channel: "C01",
        event_ts: "1724140800.123456",
      },
    });

    expect(authorizations).toEqual(["Bearer token-TWORK"]);
  });

  it("lets application code add authorized channel context without replacing the preset", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, channel: "C01", ts: "reply" })),
    });
    const store = makeMemoryStore();
    const claude = makeMockAgentDriver({ id: "claude", output: "done" });
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: { claude: claude.driver },
    });
    installClaudeTag(app, {
      agentId: "claude",
      context: (work) =>
        Effect.succeed([
          work.context.value({
            id: "channel-memory",
            kind: "channel-memory",
            value: { repository: "openma-ai/OpenMatter" },
            provenance: [
              {
                sourceType: "application-config",
                sourceId: "slack:TWORK:C01",
              },
            ],
          }),
        ]),
    });

    await app.acceptFrom("slack", {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvContext",
      event_time: 1724140800,
      event: {
        type: "app_mention",
        user: "U01",
        text: "<@BCLAUDE> inspect the repository",
        ts: "1724140800.123456",
        channel: "C01",
        event_ts: "1724140800.123456",
      },
    });
    const snapshot = await Effect.runPromise(store.inspect);

    expect(snapshot.contexts[0]?.items).toEqual([
      expect.objectContaining({ kind: "event" }),
      {
        id: "channel-memory",
        kind: "channel-memory",
        value: { repository: "openma-ai/OpenMatter" },
        provenance: [
          {
            sourceType: "application-config",
            sourceId: "slack:TWORK:C01",
          },
        ],
      },
    ]);
  });

  it("treats a direct message as a private Claude Tag activation", async () => {
    const posted: unknown[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ ok: true, channel: "D01", ts: "reply" }),
        );
      }) as typeof fetch,
    });
    const store = makeMemoryStore();
    const claude = makeMockAgentDriver({
      id: "claude",
      output: "private reply",
    });
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: { claude: claude.driver },
    });
    installClaudeTag(app, { agentId: "claude" });

    await app.acceptFrom("slack", {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvDM",
      event: {
        type: "message",
        channel_type: "im",
        user: "U02",
        text: "summarize this incident",
        ts: "1724140801.000000",
        channel: "D01",
        event_ts: "1724140801.000000",
      },
    });
    const snapshot = await Effect.runPromise(store.inspect);

    expect(posted).toEqual([
      {
        channel: "D01",
        thread_ts: "1724140801.000000",
        text: "private reply",
      },
    ]);
    expect(snapshot.sessions[0]).toEqual(
      expect.objectContaining({
        scopeId: "slack:TWORK:dm:D01",
        privacyPartition: "slack:TWORK:dm:D01",
      }),
    );
  });

  it("turns a slash command into an isolated invocation and response", async () => {
    const responses: unknown[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        responses.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });
    const store = makeMemoryStore();
    const claude = makeMockAgentDriver({
      id: "claude",
      output: "command reply",
    });
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: { claude: claude.driver },
    });
    installClaudeTag(app, { agentId: "claude" });

    await app.acceptFrom("slack", {
      type: "slash_command",
      team_id: "TWORK",
      channel_id: "C01",
      user_id: "U01",
      command: "/claude",
      text: "inspect checkout",
      trigger_id: "TrigClaude",
      response_url: "https://hooks.slack.com/commands/T/C/secret",
    });
    const snapshot = await Effect.runPromise(store.inspect);

    expect(responses).toEqual([
      { channel: "C01", user: "U01", text: "command reply" },
    ]);
    expect(snapshot.sessions[0]).toEqual(
      expect.objectContaining({
        scopeId: "slack:TWORK:channel:C01",
        workThreadId: "slack:TWORK:C01:command:TrigClaude",
      }),
    );
  });
});
