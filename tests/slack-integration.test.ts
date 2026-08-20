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

  it("does not turn Slack bot messages into recursive work", async () => {
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

    expect(events).toEqual([]);
  });

  it("ignores message subtypes such as edits instead of treating them as new work", async () => {
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
          ts: "1724140802.000000",
          message: {
            user: "U01",
            text: "edited text",
            ts: "1724140801.000000",
          },
        },
      }),
    );

    expect(events).toEqual([]);
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
    expect(await response.json()).toEqual({ ok: true });
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
      trigger_id: "Trig02",
      view: {
        id: "V01",
        callback_id: "incident.report",
        hash: "hash-1",
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
        id: "slack:view:V01:hash-1",
        type: "slack.form.submitted",
        occurredAt: "2026-08-20T10:00:00.000Z",
        receivedAt: "2026-08-20T10:00:00.000Z",
        idempotencyKey: "slack:view:V01:hash-1",
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
          triggerId: "Trig02",
          viewId: "V01",
          callbackId: "incident.report",
          privateMetadata: "thread:1724140800.123456",
          state: submission.view.state.values,
        },
        raw: {
          type: "view_submission",
          team: submission.team,
          user: submission.user,
          trigger_id: "Trig02",
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
