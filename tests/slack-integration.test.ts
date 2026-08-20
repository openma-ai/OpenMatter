import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeSlackHttpRequest,
  makeSlackIntegration,
  makeSlackHttpEndpoint,
  verifySlackRequest,
} from "../packages/integration-slack/src/index.js";

const signedSlackRequest = (
  body: string,
  contentType: string,
  timestamp = "1787210400",
) =>
  new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", "signing-secret")
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`,
    },
    body,
  });

describe("Slack WorkIntegration", () => {
  it("normalizes one app mention into an immutable thread-addressed WorkEvent", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const envelope = {
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
    };

    const events = await Effect.runPromise(slack.integration.ingest(envelope));

    expect(events).toEqual([
      {
        schemaVersion: "0.1",
        id: "slack:Ev01",
        type: "slack.message.mentioned",
        occurredAt: "2024-08-20T08:00:00.123Z",
        receivedAt: "2026-08-20T10:00:00.000Z",
        idempotencyKey: "slack:Ev01",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140800.123456",
          messageId: "1724140800.123456",
        },
        payload: {
          activation: "mention",
          surface: "channel",
          teamId: "TWORK",
          channelId: "C01",
          threadTs: "1724140800.123456",
          messageTs: "1724140800.123456",
          userId: "U01",
          text: "<@BCLAUDE> investigate the failed build",
          prompt: "investigate the failed build",
        },
        raw: envelope,
      },
    ]);
  });

  it("uses the message ts when Slack event_ts uses its official integer form", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvOfficialTimestamp",
        event: {
          type: "app_mention",
          user: "U01",
          text: "<@BCLAUDE> hello",
          ts: "1515449522.000016",
          channel: "C01",
          event_ts: "1515449522000016",
        },
      }),
    );

    expect(events[0]?.occurredAt).toBe("2018-01-08T22:12:02.000Z");
  });

  it("normalizes a direct message as a private activation", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const envelope = {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvDM",
      event_time: 1724140801,
      event: {
        type: "message",
        channel_type: "im",
        user: "U02",
        text: "summarize this incident",
        ts: "1724140801.000000",
        channel: "D01",
        event_ts: "1724140801.000000",
      },
    };

    const events = await Effect.runPromise(slack.integration.ingest(envelope));

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvDM",
        type: "slack.message.received",
        idempotencyKey: "slack:EvDM",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "D01",
          threadId: "1724140801.000000",
          messageId: "1724140801.000000",
        },
        payload: {
          activation: "direct",
          surface: "dm",
          teamId: "TWORK",
          channelId: "D01",
          threadTs: "1724140801.000000",
          messageTs: "1724140801.000000",
          userId: "U02",
          text: "summarize this incident",
          prompt: "summarize this incident",
        },
      }),
    ]);
  });

  it("preserves Slack bot messages as non-activating observations", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvBot",
        event_time: 1724140802,
        event: {
          type: "message",
          channel_type: "im",
          bot_id: "BCLAUDE",
          user: "BCLAUDE",
          text: "agent output",
          ts: "1724140802.000000",
          channel: "D01",
          event_ts: "1724140802.000000",
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvBot",
        type: "slack.event.received",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "D01",
        },
        payload: expect.objectContaining({
          activation: "observation",
          teamId: "TWORK",
          eventType: "message.bot",
        }),
      }),
    ]);
  });

  it("resolves the bot identity from the event's Slack authority", async () => {
    const resolved: string[] = [];
    const slack = makeSlackIntegration({
      credentials: (teamId: string) => {
        resolved.push(teamId);
        return { botToken: `token-${teamId}`, botUserId: `BOT-${teamId}` };
      },
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvBotDynamic",
        event: {
          type: "message",
          channel_type: "im",
          user: "BOT-TWORK",
          text: "agent output",
          ts: "1724140802.000000",
          channel: "D01",
          event_ts: "1724140802.000000",
        },
      }),
    );

    expect(resolved).toEqual(["TWORK"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "slack.event.received",
        payload: expect.objectContaining({ activation: "observation" }),
      }),
    ]);
  });

  it("uses the authorized installation as authority for Slack Connect events", async () => {
    const resolved: string[] = [];
    const slack = makeSlackIntegration({
      credentials: (teamId: string) => {
        resolved.push(teamId);
        return { botToken: `token-${teamId}`, botUserId: `BOT-${teamId}` };
      },
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TSOURCE",
        authorizations: [
          {
            team_id: "TINSTALL",
            user_id: "BOT-TINSTALL",
            is_bot: true,
            is_enterprise_install: false,
          },
        ],
        event_id: "EvSlackConnect",
        event: {
          type: "message",
          channel_type: "im",
          user: "U01",
          text: "inspect the shared incident",
          ts: "1724140802.000000",
          channel: "D01",
          event_ts: "1724140802.000000",
        },
      }),
    );

    expect(resolved).toEqual(["TINSTALL"]);
    expect(events[0]).toMatchObject({
      source: { provider: "slack", authority: "TINSTALL" },
      payload: { teamId: "TINSTALL" },
    });
  });

  it("falls back to the installed view team for org-wide interactions", async () => {
    const resolved: string[] = [];
    const slack = makeSlackIntegration({
      credentials: (teamId: string) => {
        resolved.push(teamId);
        return { botToken: `token-${teamId}`, botUserId: `BOT-${teamId}` };
      },
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "block_actions",
        team: null,
        user: { id: "U01", team_id: "TUSER" },
        trigger_id: "TrigOrg",
        container: { type: "view", view_id: "V01" },
        view: {
          id: "V01",
          app_installed_team_id: "TINSTALL",
          team_id: "TVIEW",
        },
        actions: [
          {
            action_id: "confirm",
            block_id: "incident",
            type: "button",
            action_ts: "1724140803.000000",
          },
        ],
      }),
    );

    expect(resolved).toEqual(["TINSTALL"]);
    expect(events[0]).toMatchObject({
      source: { provider: "slack", authority: "TINSTALL" },
      payload: { teamId: "TINSTALL" },
    });
  });

  it("normalizes a message edit as an observation without activating a new prompt", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvEdited",
        event: {
          type: "message",
          subtype: "message_changed",
          channel_type: "im",
          channel: "D01",
          event_ts: "1724140802.000000",
          message: {
            user: "U01",
            text: "edited text",
            ts: "1724140801.000000",
            thread_ts: "1724140800.000000",
          },
          previous_message: {
            user: "U01",
            text: "original text",
            ts: "1724140801.000000",
          },
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvEdited",
        type: "slack.message.updated",
        occurredAt: "2024-08-20T08:00:02.000Z",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "D01",
          threadId: "1724140800.000000",
          messageId: "1724140801.000000",
        },
        payload: {
          activation: "observation",
          surface: "dm",
          teamId: "TWORK",
          channelId: "D01",
          threadTs: "1724140800.000000",
          messageTs: "1724140801.000000",
          userId: "U01",
          text: "edited text",
          previousText: "original text",
        },
      }),
    ]);
  });

  it("normalizes a channel message as a non-activating message observation", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvChannelMessage",
        event: {
          type: "message",
          channel_type: "channel",
          channel: "C01",
          user: "U01",
          text: "checkout is degraded",
          ts: "1724140802.500000",
          event_ts: "1724140802.500000",
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvChannelMessage",
        type: "slack.message.received",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140802.500000",
          messageId: "1724140802.500000",
        },
        payload: expect.objectContaining({
          activation: "observation",
          surface: "channel",
          prompt: "checkout is degraded",
        }),
      }),
    ]);
  });

  it("normalizes a deleted message with its durable Slack address", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvDeleted",
        event: {
          type: "message",
          subtype: "message_deleted",
          channel: "C01",
          deleted_ts: "1724140801.000000",
          event_ts: "1724140803.000000",
          previous_message: {
            user: "U01",
            text: "obsolete message",
            ts: "1724140801.000000",
            thread_ts: "1724140800.000000",
          },
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvDeleted",
        type: "slack.message.deleted",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140800.000000",
          messageId: "1724140801.000000",
        },
        payload: {
          activation: "observation",
          surface: "channel",
          teamId: "TWORK",
          channelId: "C01",
          threadTs: "1724140800.000000",
          messageTs: "1724140801.000000",
          previousMessage: {
            user: "U01",
            text: "obsolete message",
            ts: "1724140801.000000",
            thread_ts: "1724140800.000000",
          },
        },
      }),
    ]);
  });

  it("normalizes a self reaction as a message-addressed observation", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvReaction",
        event: {
          type: "reaction_added",
          user: "BCLAUDE",
          reaction: "eyes",
          item_user: "U02",
          item: { type: "message", channel: "C01", ts: "1724140800.123456" },
          event_ts: "1724140804.000000",
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvReaction",
        type: "slack.reaction.added",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140800.123456",
          messageId: "1724140800.123456",
        },
        payload: {
          activation: "observation",
          teamId: "TWORK",
          channelId: "C01",
          messageTs: "1724140800.123456",
          userId: "BCLAUDE",
          itemUserId: "U02",
          emoji: "eyes",
        },
      }),
    ]);
  });

  it("normalizes a block action with its structured action values", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "block_actions",
        team: { id: "TWORK", domain: "example" },
        user: { id: "U01", username: "ada" },
        trigger_id: "TrigAction",
        container: {
          type: "message",
          channel_id: "C01",
          message_ts: "1724140800.123456",
          thread_ts: "1724140800.123456",
        },
        actions: [
          {
            action_id: "incident.severity",
            block_id: "incident",
            type: "static_select",
            selected_option: {
              text: { type: "plain_text", text: "SEV-1" },
              value: "sev1",
            },
            action_ts: "1724140803.000000",
          },
        ],
        bot_access_token: "xwfp-secret",
        interactivity: {
          interactor: { id: "U01", secret: "interactor-secret" },
        },
        response_url: "https://hooks.slack.com/actions/T/C/secret",
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:action:TrigAction:1724140803.000000",
        type: "slack.action.invoked",
        occurredAt: "2024-08-20T08:00:03.000Z",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140800.123456",
          messageId: "1724140800.123456",
        },
        payload: {
          activation: "action",
          surface: "channel",
          teamId: "TWORK",
          channelId: "C01",
          threadTs: "1724140800.123456",
          messageTs: "1724140800.123456",
          userId: "U01",
          triggerId: "TrigAction",
          actions: [
            {
              action_id: "incident.severity",
              block_id: "incident",
              type: "static_select",
              selected_option: {
                text: { type: "plain_text", text: "SEV-1" },
                value: "sev1",
              },
              action_ts: "1724140803.000000",
            },
          ],
        },
      }),
    ]);
    expect(events[0]?.raw).not.toHaveProperty("bot_access_token");
    expect(events[0]?.raw).toMatchObject({
      interactivity: { interactor: { id: "U01" } },
    });
    expect(events[0]?.raw).not.toHaveProperty(
      "interactivity.interactor.secret",
    );
    expect(events[0]?.raw).not.toHaveProperty("response_url");
  });

  it("normalizes a message shortcut with message provenance", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "message_action",
        callback_id: "incident.create",
        trigger_id: "TrigShortcut",
        action_ts: "1724140805.000000",
        team: { id: "TWORK", domain: "example" },
        user: { id: "U01", username: "ada" },
        channel: { id: "C01", name: "incidents" },
        message: {
          type: "message",
          user: "U02",
          text: "checkout is degraded",
          ts: "1724140804.000000",
          thread_ts: "1724140800.123456",
        },
        response_url: "https://hooks.slack.com/actions/T/C/secret",
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:shortcut:TrigShortcut",
        type: "slack.shortcut.invoked",
        occurredAt: "2024-08-20T08:00:05.000Z",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "1724140800.123456",
          messageId: "1724140804.000000",
        },
        payload: {
          activation: "shortcut",
          surface: "channel",
          teamId: "TWORK",
          channelId: "C01",
          threadTs: "1724140800.123456",
          messageTs: "1724140804.000000",
          userId: "U01",
          callbackId: "incident.create",
          triggerId: "TrigShortcut",
          message: {
            type: "message",
            user: "U02",
            text: "checkout is degraded",
            ts: "1724140804.000000",
            thread_ts: "1724140800.123456",
          },
        },
      }),
    ]);
  });

  it("normalizes a closed modal without promoting its private metadata to identity", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "view_closed",
        team: { id: "TWORK", domain: "example" },
        user: { id: "U01", username: "ada" },
        is_cleared: true,
        view: {
          id: "V01",
          callback_id: "incident.report",
          private_metadata: "thread:1724140800.123456",
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:view:V01:closed",
        type: "slack.form.closed",
        source: {
          provider: "slack",
          authority: "TWORK",
          threadId: "view:V01",
        },
        payload: {
          activation: "observation",
          surface: "modal",
          teamId: "TWORK",
          userId: "U01",
          viewId: "V01",
          callbackId: "incident.report",
          isCleared: true,
          privateMetadata: "thread:1724140800.123456",
        },
      }),
    ]);
  });

  it("preserves an otherwise unknown Events API event as a generic observation", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });

    const events = await Effect.runPromise(
      slack.integration.ingest({
        type: "event_callback",
        team_id: "TWORK",
        event_id: "EvCanvas",
        event: {
          type: "canvas_updated",
          canvas_id: "F0123",
          user_id: "U01",
          event_ts: "1515449522000016",
        },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "slack:EvCanvas",
        type: "slack.event.received",
        occurredAt: "2018-01-08T22:12:02.000Z",
        source: { provider: "slack", authority: "TWORK" },
        payload: {
          activation: "observation",
          teamId: "TWORK",
          eventType: "canvas_updated",
          event: {
            type: "canvas_updated",
            canvas_id: "F0123",
            user_id: "U01",
            event_ts: "1515449522000016",
          },
        },
      }),
    ]);
  });

  it("materializes a Slack thread as an explicitly requested ContextItem", async () => {
    const requests: string[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                type: "message",
                user: "U01",
                text: "root",
                ts: "1724140800.123456",
              },
              {
                type: "message",
                user: "U02",
                text: "reply",
                ts: "1724140801.000000",
              },
            ],
            has_more: false,
            response_metadata: { next_cursor: "" },
          }),
        );
      }) as typeof fetch,
    });

    const item = await Effect.runPromise(
      slack.context.thread({
        teamId: "TWORK",
        channelId: "C01",
        threadTs: "1724140800.123456",
        limit: 50,
      }),
    );

    expect(requests).toEqual([
      "https://slack.com/api/conversations.replies?channel=C01&ts=1724140800.123456&limit=50",
    ]);
    expect(item).toEqual({
      id: "slack:TWORK:thread:C01:1724140800.123456",
      kind: "slack.thread",
      value: {
        teamId: "TWORK",
        channelId: "C01",
        threadTs: "1724140800.123456",
        messages: [
          {
            type: "message",
            user: "U01",
            text: "root",
            ts: "1724140800.123456",
          },
          {
            type: "message",
            user: "U02",
            text: "reply",
            ts: "1724140801.000000",
          },
        ],
        hasMore: false,
        nextCursor: "",
      },
      provenance: [
        {
          sourceType: "slack-api",
          sourceId: "TWORK:C01:1724140800.123456",
          integrationId: "slack",
          uri: "https://slack.com/archives/C01/p1724140800123456",
        },
      ],
    });
  });

  it("materializes bounded channel history without implicitly paginating", async () => {
    const requests: string[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { type: "message", text: "latest", ts: "1724140802.000000" },
            ],
            has_more: false,
            response_metadata: { next_cursor: "next-page" },
          }),
        );
      }) as typeof fetch,
    });

    const item = await Effect.runPromise(
      slack.context.history({
        teamId: "TWORK",
        channelId: "C01",
        limit: 20,
        oldest: "1724140000.000000",
      }),
    );

    expect(requests).toEqual([
      "https://slack.com/api/conversations.history?channel=C01&limit=20&oldest=1724140000.000000",
    ]);
    expect(item).toMatchObject({
      id: "slack:TWORK:history:C01",
      kind: "slack.channel-history",
      value: {
        teamId: "TWORK",
        channelId: "C01",
        messages: [
          { type: "message", text: "latest", ts: "1724140802.000000" },
        ],
        hasMore: true,
        nextCursor: "next-page",
      },
    });
  });

  it("materializes Slack user and file resources with provider provenance", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("users.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              user: { id: "U01", real_name: "Ada Lovelace" },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            file: { id: "F01", name: "incident.txt", mimetype: "text/plain" },
          }),
        );
      }) as typeof fetch,
    });

    const user = await Effect.runPromise(
      slack.context.user({ teamId: "TWORK", userId: "U01" }),
    );
    const file = await Effect.runPromise(
      slack.context.file({ teamId: "TWORK", fileId: "F01" }),
    );

    expect(user).toEqual({
      id: "slack:TWORK:user:U01",
      kind: "slack.user",
      value: {
        teamId: "TWORK",
        user: { id: "U01", real_name: "Ada Lovelace" },
      },
      provenance: [
        {
          sourceType: "slack-api",
          sourceId: "TWORK:U01",
          integrationId: "slack",
        },
      ],
    });
    expect(file).toEqual({
      id: "slack:TWORK:file:F01",
      kind: "slack.file",
      value: {
        teamId: "TWORK",
        file: { id: "F01", name: "incident.txt", mimetype: "text/plain" },
      },
      provenance: [
        {
          sourceType: "slack-api",
          sourceId: "TWORK:F01",
          integrationId: "slack",
        },
      ],
    });
  });

  it("materializes Slack conversation metadata as channel context", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channel: {
              id: "C01",
              name: "incidents",
              topic: { value: "Production incidents" },
            },
          }),
        ),
    });

    const item = await Effect.runPromise(
      slack.context.conversation({ teamId: "TWORK", channelId: "C01" }),
    );

    expect(item).toEqual({
      id: "slack:TWORK:conversation:C01",
      kind: "slack.conversation",
      value: {
        teamId: "TWORK",
        channel: {
          id: "C01",
          name: "incidents",
          topic: { value: "Production incidents" },
        },
      },
      provenance: [
        {
          sourceType: "slack-api",
          sourceId: "TWORK:C01",
          integrationId: "slack",
        },
      ],
    });
  });

  it("uses the same authority credential resolver for Context reads and Effects", async () => {
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | null;
    }> = [];
    const slack = makeSlackIntegration({
      credentials: async (teamId: string) => ({
        botToken: `token-${teamId}`,
        botUserId: `BOT-${teamId}`,
      }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (String(input).includes("users.info")) {
          return new Response(
            JSON.stringify({ ok: true, user: { id: "U01" } }),
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.context.user({ teamId: "TREAD", userId: "U01" }),
    );
    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-multi-workspace",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.post",
        idempotencyKey: "slack:Ev01:post",
        input: { teamId: "TWRITE", channelId: "C01", text: "hello" },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/users.info?user=U01",
        authorization: "Bearer token-TREAD",
      },
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer token-TWRITE",
      },
    ]);
  });

  it("delivers a thread reply through chat.postMessage with bot authentication", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL;
      readonly init?: RequestInit;
    }> = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({
            ok: true,
            channel: "C01",
            ts: "1724140803.000000",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const result = await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-1",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.reply",
        idempotencyKey: "slack:Ev01:reply",
        input: {
          channelId: "C01",
          threadTs: "1724140800.123456",
          text: "Investigation complete",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "*Investigation complete*" },
            },
          ],
        },
      }),
    );

    expect(requests).toEqual([
      {
        input: "https://slack.com/api/chat.postMessage",
        init: {
          method: "POST",
          headers: {
            authorization: "Bearer xoxb-test",
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: "C01",
            thread_ts: "1724140800.123456",
            text: "Investigation complete",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: "*Investigation complete*" },
              },
            ],
          }),
        },
      },
    ]);
    expect(result).toEqual({
      providerReceipt: {
        ok: true,
        channel: "C01",
        ts: "1724140803.000000",
      },
    });
  });

  it("delivers an emoji reaction through reactions.add", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL;
      readonly init?: RequestInit;
    }> = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-reaction",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.react",
        idempotencyKey: "slack:Ev01:reaction",
        input: {
          channelId: "C01",
          messageTs: "1724140800.123456",
          emoji: "eyes",
        },
      }),
    );

    expect(requests).toEqual([
      {
        input: "https://slack.com/api/reactions.add",
        init: {
          method: "POST",
          headers: {
            authorization: "Bearer xoxb-test",
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: "C01",
            timestamp: "1724140800.123456",
            name: "eyes",
          }),
        },
      },
    ]);
  });

  it("treats an already-present emoji reaction as an idempotent success", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, error: "already_reacted" })),
    });

    const result = await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-reaction-replay",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.react",
        idempotencyKey: "slack:Ev01:reaction",
        input: {
          channelId: "C01",
          messageTs: "1724140800.123456",
          emoji: "eyes",
        },
      }),
    );

    expect(result).toEqual({
      providerReceipt: { ok: false, error: "already_reacted" },
    });
  });

  it("delivers a channel message through chat.postMessage", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL;
      readonly init?: RequestInit;
    }> = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-command",
        eventId: "slack:command:Trig01",
        integrationId: "slack",
        operation: "message.post",
        idempotencyKey: "slack:command:Trig01:reply",
        input: {
          channelId: "C01",
          text: "Investigation complete",
        },
      }),
    );

    expect(requests).toEqual([
      {
        input: "https://slack.com/api/chat.postMessage",
        init: {
          method: "POST",
          headers: {
            authorization: "Bearer xoxb-test",
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: "C01",
            text: "Investigation complete",
          }),
        },
      },
    ]);
    expect(result).toEqual({ providerReceipt: { ok: true } });
  });

  it("updates a Slack message through a separately granted operation", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({ ok: true, ts: "1724140800.123456" }),
        );
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-update",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.update",
        idempotencyKey: "slack:Ev01:update",
        input: {
          channelId: "C01",
          messageTs: "1724140800.123456",
          text: "Updated investigation",
          blocks: [
            { type: "section", text: { type: "plain_text", text: "Updated" } },
          ],
        },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.update",
        body: {
          channel: "C01",
          ts: "1724140800.123456",
          text: "Updated investigation",
          blocks: [
            { type: "section", text: { type: "plain_text", text: "Updated" } },
          ],
        },
      },
    ]);
  });

  it("deletes a Slack message through a destructive operation", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-delete",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.delete",
        idempotencyKey: "slack:Ev01:delete",
        input: { channelId: "C01", messageTs: "1724140800.123456" },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.delete",
        body: { channel: "C01", ts: "1724140800.123456" },
      },
    ]);
  });

  it("schedules and cancels a Slack message with distinct grants", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-schedule",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.schedule",
        idempotencyKey: "slack:Ev01:schedule",
        input: {
          channelId: "C01",
          postAt: 1787214000,
          text: "Scheduled update",
        },
      }),
    );
    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-schedule-cancel",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.schedule.cancel",
        idempotencyKey: "slack:Ev01:schedule:cancel",
        input: { channelId: "C01", scheduledMessageId: "Q01" },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/chat.scheduleMessage",
        body: { channel: "C01", post_at: 1787214000, text: "Scheduled update" },
      },
      {
        url: "https://slack.com/api/chat.deleteScheduledMessage",
        body: { channel: "C01", scheduled_message_id: "Q01" },
      },
    ]);
  });

  it("delivers a private command result through chat.postEphemeral", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL;
      readonly init?: RequestInit;
    }> = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, ...(init === undefined ? {} : { init }) });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-ephemeral",
        eventId: "slack:command:Trig01",
        integrationId: "slack",
        operation: "message.ephemeral",
        idempotencyKey: "slack:command:Trig01:ephemeral",
        input: {
          channelId: "C01",
          userId: "U01",
          text: "Private investigation result",
        },
      }),
    );

    expect(requests).toEqual([
      {
        input: "https://slack.com/api/chat.postEphemeral",
        init: {
          method: "POST",
          headers: {
            authorization: "Bearer xoxb-test",
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: "C01",
            user: "U01",
            text: "Private investigation result",
          }),
        },
      },
    ]);
  });

  it("removes an emoji reaction through reactions.remove", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-unreact",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "message.unreact",
        idempotencyKey: "slack:Ev01:unreact",
        input: {
          channelId: "C01",
          messageTs: "1724140800.123456",
          emoji: "eyes",
        },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/reactions.remove",
        body: { channel: "C01", timestamp: "1724140800.123456", name: "eyes" },
      },
    ]);
  });

  it("maps modal and App Home lifecycle operations to Slack views methods", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    });
    const modal = {
      type: "modal",
      title: { type: "plain_text", text: "Incident" },
      blocks: [],
    };
    const home = { type: "home", blocks: [] };

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-view-update",
        eventId: "slack:view:V01",
        integrationId: "slack",
        operation: "view.update",
        idempotencyKey: "slack:view:V01:update",
        input: { viewId: "V01", hash: "hash-1", view: modal },
      }),
    );
    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-view-push",
        eventId: "slack:action:A01",
        integrationId: "slack",
        operation: "view.push",
        idempotencyKey: "slack:action:A01:push",
        input: { triggerId: "Trig01", view: modal },
      }),
    );
    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-home-publish",
        eventId: "slack:event:Home",
        integrationId: "slack",
        operation: "home.publish",
        idempotencyKey: "slack:event:Home:publish",
        input: { userId: "U01", view: home },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/views.update",
        body: { view_id: "V01", hash: "hash-1", view: modal },
      },
      {
        url: "https://slack.com/api/views.push",
        body: { trigger_id: "Trig01", view: modal },
      },
      {
        url: "https://slack.com/api/views.publish",
        body: { user_id: "U01", view: home },
      },
    ]);
  });

  it("uploads portable text content through Slack's external upload lifecycle", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body =
          init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body));
        requests.push({ url, body });
        if (url.endsWith("files.getUploadURLExternal")) {
          return new Response(
            JSON.stringify({
              ok: true,
              upload_url: "https://files.slack.com/upload/v1/ticket",
              file_id: "F01",
            }),
          );
        }
        if (url.includes("/upload/v1/")) return new Response("ok");
        return new Response(
          JSON.stringify({ ok: true, files: [{ id: "F01" }] }),
        );
      }) as typeof fetch,
    });

    const result = await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-file-upload",
        eventId: "slack:Ev01",
        integrationId: "slack",
        operation: "file.upload",
        idempotencyKey: "slack:Ev01:file",
        input: {
          filename: "incident.txt",
          content: "hello",
          title: "Incident details",
          channelId: "C01",
          threadTs: "1724140800.123456",
          initialComment: "Attached evidence",
        },
      }),
    );

    expect(requests).toEqual([
      {
        url: "https://slack.com/api/files.getUploadURLExternal",
        body: { filename: "incident.txt", length: 5 },
      },
      { url: "https://files.slack.com/upload/v1/ticket", body: "hello" },
      {
        url: "https://slack.com/api/files.completeUploadExternal",
        body: {
          files: [{ id: "F01", title: "Incident details" }],
          channel_id: "C01",
          thread_ts: "1724140800.123456",
          initial_comment: "Attached evidence",
        },
      },
    ]);
    expect(result).toEqual({
      providerReceipt: { ok: true, files: [{ id: "F01" }] },
    });
  });

  it("preserves Slack Retry-After as an absolute retry time", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    });

    const result = await Effect.runPromise(
      slack.integration
        .deliver({
          schemaVersion: "0.1",
          id: "effect-rate-limited",
          eventId: "slack:Ev01",
          integrationId: "slack",
          operation: "message.post",
          idempotencyKey: "slack:Ev01:rate-limited",
          input: { channelId: "C01", text: "hello" },
        })
        .pipe(Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "IntegrationError",
        retryable: true,
        retryAt: "2026-08-20T10:00:30.000Z",
      },
    });
  });

  it("preserves Retry-After from Slack's external file upload URL", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async (input) =>
        String(input).includes("files.getUploadURLExternal")
          ? new Response(
              JSON.stringify({
                ok: true,
                upload_url: "https://files.slack.com/upload/v1/ticket",
                file_id: "F01",
              }),
            )
          : new Response(null, {
              status: 429,
              headers: { "retry-after": "12" },
            }),
    });

    const result = await Effect.runPromise(
      slack.integration
        .deliver({
          schemaVersion: "0.1",
          id: "effect-file-rate-limited",
          eventId: "slack:Ev01",
          integrationId: "slack",
          operation: "file.upload",
          idempotencyKey: "slack:Ev01:file-rate-limited",
          input: { filename: "incident.txt", content: "hello" },
        })
        .pipe(Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "IntegrationError",
        retryable: true,
        retryAt: "2026-08-20T10:00:12.000Z",
      },
    });
  });

  it("classifies Slack's transient Web API codes as retryable", async () => {
    for (const code of ["service_unavailable", "rate_limited"]) {
      const slack = makeSlackIntegration({
        botToken: "xoxb-test",
        botUserId: "BCLAUDE",
        fetch: async () =>
          new Response(JSON.stringify({ ok: false, error: code })),
      });

      const result = await Effect.runPromise(
        slack.integration
          .deliver({
            schemaVersion: "0.1",
            id: `effect-${code}`,
            eventId: "slack:Ev01",
            integrationId: "slack",
            operation: "message.post",
            idempotencyKey: `slack:Ev01:${code}`,
            input: { channelId: "C01", text: "hello" },
          })
          .pipe(Effect.either),
      );

      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "IntegrationError",
          retryable: true,
        },
      });
    }
  });

  it("verifies the raw Slack HTTP body using the official v0 signature scheme", async () => {
    const rawBody =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";

    const verified = await Effect.runPromise(
      verifySlackRequest({
        signingSecret: "8f742231b10e8888abcd99yyyzzz85a5",
        rawBody,
        timestamp: "1531420618",
        signature:
          "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
        now: () => 1531420618,
      }),
    );

    expect(verified).toBe(true);
  });

  it("decodes a signed Slack URL verification request", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });

    const decoded = await Effect.runPromise(
      decodeSlackHttpRequest(signedSlackRequest(body, "application/json"), {
        signingSecret: "signing-secret",
        now: () => 1787210400,
      }),
    );

    expect(decoded).toEqual({
      kind: "challenge",
      challenge: "challenge-token",
    });
  });

  it("publishes Slack URL verification as a portable HTTP endpoint", async () => {
    const endpoint = makeSlackHttpEndpoint({
      signingSecret: "signing-secret",
      now: () => 1787210400,
      submit: async () => {
        throw new Error("URL verification must not submit work");
      },
    });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "endpoint-challenge",
    });

    const response = await endpoint.handle(
      signedSlackRequest(body, "application/json"),
    );

    expect(endpoint).toMatchObject({ method: "POST", path: "/slack/events" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "endpoint-challenge" });
  });

  it("submits a verified Slack payload through the portable HTTP endpoint", async () => {
    let submitted: unknown;
    const endpoint = makeSlackHttpEndpoint({
      signingSecret: "signing-secret",
      now: () => 1787210400,
      submit: async (input) => {
        submitted = input;
      },
    });
    const envelope = {
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvEndpoint",
      event: {
        type: "app_mention",
        user: "U01",
        text: "<@BCLAUDE> inspect",
        ts: "1787210400.000001",
        channel: "C01",
      },
    };
    const body = JSON.stringify(envelope);

    const response = await endpoint.handle(
      signedSlackRequest(body, "application/json"),
    );

    expect(submitted).toEqual(envelope);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("decodes a signed URL-encoded slash command into adapter input", async () => {
    const body = new URLSearchParams({
      team_id: "TWORK",
      channel_id: "C01",
      user_id: "U01",
      command: "/claude",
      text: "inspect checkout",
      trigger_id: "trigger-1",
      token: "legacy-verification-token",
      response_url: "https://hooks.slack.com/commands/T/C/secret",
    }).toString();

    const decoded = await Effect.runPromise(
      decodeSlackHttpRequest(
        signedSlackRequest(
          body,
          "application/x-www-form-urlencoded; charset=utf-8",
        ),
        { signingSecret: "signing-secret", now: () => 1787210400 },
      ),
    );

    expect(decoded).toEqual({
      kind: "input",
      input: {
        type: "slash_command",
        team_id: "TWORK",
        channel_id: "C01",
        user_id: "U01",
        command: "/claude",
        text: "inspect checkout",
        trigger_id: "trigger-1",
      },
    });
  });

  it("rejects an unsigned Slack HTTP request", async () => {
    const result = await Effect.runPromiseExit(
      decodeSlackHttpRequest(
        new Request("https://example.com/slack/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "event_callback" }),
        }),
        { signingSecret: "signing-secret", now: () => 1787210400 },
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("normalizes a slash command into an explicit command WorkEvent", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const command = {
      type: "slash_command",
      team_id: "TWORK",
      channel_id: "C01",
      channel_name: "incidents",
      user_id: "U01",
      command: "/claude",
      text: "investigate checkout latency",
      trigger_id: "Trig01",
      token: "legacy-verification-token",
      response_url: "https://hooks.slack.com/commands/TWORK/response",
    };

    const events = await Effect.runPromise(slack.integration.ingest(command));

    expect(events).toEqual([
      {
        schemaVersion: "0.1",
        id: "slack:command:Trig01",
        type: "slack.command.invoked",
        occurredAt: "2026-08-20T10:00:00.000Z",
        receivedAt: "2026-08-20T10:00:00.000Z",
        idempotencyKey: "slack:command:Trig01",
        source: {
          provider: "slack",
          authority: "TWORK",
          conversationId: "C01",
          threadId: "command:Trig01",
        },
        payload: {
          activation: "command",
          surface: "channel",
          teamId: "TWORK",
          channelId: "C01",
          userId: "U01",
          command: "/claude",
          prompt: "investigate checkout latency",
          triggerId: "Trig01",
        },
        raw: {
          type: "slash_command",
          team_id: "TWORK",
          channel_id: "C01",
          channel_name: "incidents",
          user_id: "U01",
          command: "/claude",
          text: "investigate checkout latency",
          trigger_id: "Trig01",
        },
      },
    ]);
  });

  it("normalizes a modal submission without flattening its structured form state", async () => {
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      clock: () => "2026-08-20T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const submission = {
      type: "view_submission",
      response_urls: [
        {
          channel_id: "C01",
          response_url: "https://hooks.slack.com/actions/T/C/secret",
        },
      ],
      team: { id: "TWORK", domain: "example" },
      user: { id: "U01", username: "ada" },
      view: {
        id: "V01",
        callback_id: "incident.report",
        private_metadata: "thread:1724140800.123456",
        state: {
          values: {
            summary: {
              value: {
                type: "plain_text_input",
                value: "Checkout is degraded",
              },
            },
          },
        },
      },
    };

    const events = await Effect.runPromise(
      slack.integration.ingest(submission),
    );

    expect(events).toEqual([
      {
        schemaVersion: "0.1",
        id: "slack:view:V01:submitted",
        type: "slack.form.submitted",
        occurredAt: "2026-08-20T10:00:00.000Z",
        receivedAt: "2026-08-20T10:00:00.000Z",
        idempotencyKey: "slack:view:V01:submitted",
        source: {
          provider: "slack",
          authority: "TWORK",
          threadId: "view:V01",
        },
        payload: {
          activation: "form",
          surface: "modal",
          teamId: "TWORK",
          userId: "U01",
          viewId: "V01",
          callbackId: "incident.report",
          privateMetadata: "thread:1724140800.123456",
          state: submission.view.state.values,
        },
        raw: {
          type: "view_submission",
          team: submission.team,
          user: submission.user,
          view: submission.view,
        },
      },
    ]);
  });

  it("opens a structured Slack modal through views.open", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL;
      readonly body: string;
    }> = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, body: String(init?.body) });
        return new Response(JSON.stringify({ ok: true, view: { id: "V01" } }));
      }) as typeof fetch,
    });
    const view = {
      type: "modal",
      callback_id: "incident.report",
      title: { type: "plain_text", text: "Report incident" },
      submit: { type: "plain_text", text: "Submit" },
      blocks: [],
    };

    await Effect.runPromise(
      slack.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-view",
        eventId: "slack:command:Trig02",
        integrationId: "slack",
        operation: "view.open",
        idempotencyKey: "slack:command:Trig02:view",
        input: { triggerId: "Trig02", view },
      }),
    );

    expect(requests).toEqual([
      {
        input: "https://slack.com/api/views.open",
        body: JSON.stringify({ trigger_id: "Trig02", view }),
      },
    ]);
  });
});
