import { createHmac } from "node:crypto";
import {
  createOpenMatter,
  EventBusyError,
  type OpenMatterApplication,
} from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeCloudflareRuntime } from "../packages/host-cloudflare/src/index.js";
import { makeSlackIntegration } from "../packages/integration-slack/src/index.js";

const signedRequest = (body: string, timestamp = "1787210400") =>
  new Request("https://agent.example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", "signing-secret")
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`,
    },
    body,
  });

interface TestEnvironment {
  readonly signingSecret: string;
  readonly events: {
    readonly send: (body: unknown) => Promise<{ readonly outcome: "ok" }>;
  };
}

describe("Cloudflare OpenMatter runtime", () => {
  it("exposes durable effect recovery as a scheduled host entrypoint", async () => {
    let recoveries = 0;
    const application = {
      recoverEffectsEffect: () =>
        Effect.sync(() => {
          recoveries += 1;
          return [];
        }),
    } as unknown as OpenMatterApplication;
    const runtime = makeCloudflareRuntime<TestEnvironment>({
      application: () => application,
      slack: {
        signingSecret: (environment) => environment.signingSecret,
        queue: (environment) => environment.events,
      },
    });
    const environment: TestEnvironment = {
      signingSecret: "signing-secret",
      events: { send: async () => ({ outcome: "ok" }) },
    };

    await runtime.scheduled(environment);

    expect(recoveries).toBe(1);
  });

  it("answers Slack URL verification without enqueueing work", async () => {
    const jobs: unknown[] = [];
    const runtime = makeCloudflareRuntime<TestEnvironment>({
      application: () => {
        throw new Error("The application must not run during verification");
      },
      slack: {
        signingSecret: (environment) => environment.signingSecret,
        queue: (environment) => environment.events,
        now: () => 1787210400,
      },
    });
    const environment: TestEnvironment = {
      signingSecret: "signing-secret",
      events: {
        send: async (body) => {
          jobs.push(body);
          return { outcome: "ok" };
        },
      },
    };
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });

    const response = await runtime.fetch(signedRequest(body), environment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-token" });
    expect(jobs).toEqual([]);
  });

  it("quickly enqueues a verified Slack event and executes it in the queue consumer", async () => {
    const jobs: unknown[] = [];
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const store = makeMemoryStore();
    const app = createOpenMatter({
      store,
      integrations: { slack: slack.integration },
      agents: {},
    });
    app.on("slack.message.mentioned", (work) =>
      work.react.none("observed by queue consumer"),
    );
    const runtime = makeCloudflareRuntime<TestEnvironment>({
      application: () => app,
      slack: {
        signingSecret: (environment) => environment.signingSecret,
        queue: (environment) => environment.events,
        now: () => 1787210400,
      },
    });
    const environment: TestEnvironment = {
      signingSecret: "signing-secret",
      events: {
        send: async (body) => {
          jobs.push(body);
          return { outcome: "ok" };
        },
      },
    };
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "TWORK",
      event_id: "EvQueue",
      event: {
        type: "app_mention",
        user: "U01",
        text: "<@BCLAUDE> inspect checkout",
        ts: "1724140800.123456",
        channel: "C01",
        event_ts: "1724140800.123456",
      },
    });

    const response = await runtime.fetch(signedRequest(body), environment);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(jobs).toEqual([
      {
        schemaVersion: "0.1",
        integrationId: "slack",
        input: JSON.parse(body),
      },
    ]);

    let acknowledgements = 0;
    let retries = 0;
    await runtime.queue(
      {
        messages: jobs.map((job) => ({
          body: job,
          ack: () => {
            acknowledgements += 1;
          },
          retry: () => {
            retries += 1;
          },
        })),
      },
      environment,
    );
    const snapshot = await Effect.runPromise(store.inspect);

    expect(acknowledgements).toBe(1);
    expect(retries).toBe(0);
    expect(snapshot.reactions).toEqual([
      expect.objectContaining({
        eventId: "slack:EvQueue",
        status: "completed",
        reason: "observed by queue consumer",
      }),
    ]);
  });

  it("acknowledges a non-retryable adapter rejection instead of poisoning the queue", async () => {
    let acknowledgements = 0;
    let retries = 0;
    const slack = makeSlackIntegration({
      botToken: "xoxb-test",
      botUserId: "BCLAUDE",
      fetch: async () => new Response(JSON.stringify({ ok: true })),
    });
    const application = createOpenMatter({
      store: makeMemoryStore(),
      integrations: { slack: slack.integration },
      agents: {},
    });
    const runtime = makeCloudflareRuntime<TestEnvironment>({
      application: () => application,
      onError: () => {
        throw new Error("broken telemetry exporter");
      },
      slack: {
        signingSecret: (environment) => environment.signingSecret,
        queue: (environment) => environment.events,
      },
    });
    const environment: TestEnvironment = {
      signingSecret: "signing-secret",
      events: { send: async () => ({ outcome: "ok" }) },
    };

    await runtime.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: "0.1",
              integrationId: "slack",
              input: {
                type: "slash_command",
                team_id: "TWORK",
                channel_id: "C01",
              },
            },
            ack: () => void (acknowledgements += 1),
            retry: () => void (retries += 1),
          },
        ],
      },
      environment,
    );

    expect(acknowledgements).toBe(1);
    expect(retries).toBe(0);
  });

  it("delays a busy-event retry until its durable lease can be reclaimed", async () => {
    const retryOptions: unknown[] = [];
    const application = {
      acceptFromEffect: () =>
        Effect.fail(
          new EventBusyError({
            eventId: "slack:EvBusy",
            retryAt: "2026-08-20T10:00:45.000Z",
            message: "Event is already leased",
          }),
        ),
    } as unknown as OpenMatterApplication;
    const runtime = makeCloudflareRuntime<TestEnvironment>({
      application: () => application,
      clock: () => Date.parse("2026-08-20T10:00:00.000Z"),
      slack: {
        signingSecret: (environment) => environment.signingSecret,
        queue: (environment) => environment.events,
      },
    });
    const environment: TestEnvironment = {
      signingSecret: "signing-secret",
      events: { send: async () => ({ outcome: "ok" }) },
    };

    await runtime.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: "0.1",
              integrationId: "slack",
              input: { type: "event_callback" },
            },
            ack: () => undefined,
            retry: (options) => retryOptions.push(options),
          },
        ],
      },
      environment,
    );

    expect(retryOptions).toEqual([{ delaySeconds: 45 }]);
  });
});
