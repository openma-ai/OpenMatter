import { createHmac } from "node:crypto";
import type { WorkIntegration } from "@openmatter/integration";
import type { ContextItem } from "@openmatter/core";
import { makeCredentialResolver } from "@openmatter/credentials";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const signedGitHubRequest = (
  body: string,
  options?: {
    readonly eventName?: string;
    readonly deliveryId?: string;
    readonly secret?: string;
  },
) =>
  new Request("https://example.com/github/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": options?.eventName ?? "issues",
      "x-github-delivery": options?.deliveryId ?? "delivery-01",
      "x-hub-signature-256": `sha256=${createHmac(
        "sha256",
        options?.secret ?? "webhook-secret",
      )
        .update(body)
        .digest("hex")}`,
    },
    body,
  });

describe("GitHub WorkIntegration", () => {
  it("verifies the exact webhook bytes and submits provider metadata", async () => {
    const github = await import("../packages/integration-github/src/index.js");
    const submitted: unknown[] = [];
    const rawBody = '{ "action": "opened", "note": "修复 🚀" }';
    const endpoint = github.makeGitHubHttpEndpoint({
      webhookSecret: "webhook-secret",
      submit: async (input: unknown) => {
        submitted.push(input);
      },
    });

    const response = await endpoint.handle(
      signedGitHubRequest(rawBody, {
        eventName: "issues",
        deliveryId: "delivery-raw-bytes",
      }),
    );

    expect(response.status).toBe(202);
    expect(submitted).toEqual([
      {
        kind: "github.webhook",
        eventName: "issues",
        deliveryId: "delivery-raw-bytes",
        payload: { action: "opened", note: "修复 🚀" },
      },
    ]);
  });

  it("rejects an invalid signature without submitting work", async () => {
    const github = await import("../packages/integration-github/src/index.js");
    let submissions = 0;
    const endpoint = github.makeGitHubHttpEndpoint({
      webhookSecret: "different-secret",
      submit: async () => {
        submissions += 1;
      },
    });

    const response = await endpoint.handle(
      signedGitHubRequest('{"action":"opened"}'),
    );

    expect(response.status).toBe(401);
    expect(submissions).toBe(0);
  });

  it("rejects a signed non-object webhook instead of acknowledging dropped work", async () => {
    const github = await import("../packages/integration-github/src/index.js");
    let submissions = 0;
    const endpoint = github.makeGitHubHttpEndpoint({
      webhookSecret: "webhook-secret",
      submit: async () => {
        submissions += 1;
      },
    });

    const response = await endpoint.handle(
      signedGitHubRequest('[{"action":"opened"}]'),
    );

    expect(response.status).toBe(400);
    expect(submissions).toBe(0);
  });

  it("normalizes an issue event under its GitHub App installation authority and redacts secrets", async () => {
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly token: string;
          readonly clock: () => string;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const integration = github.makeGitHubIntegration({
      token: "installation-token",
      clock: () => "2026-08-23T10:00:00.000Z",
      fetch: async () => new Response("{}"),
    });
    const input = {
      kind: "github.webhook",
      eventName: "issues",
      deliveryId: "delivery-issue-opened",
      payload: {
        action: "opened",
        installation: { id: 9001, access_token: "never-expose" },
        repository: {
          id: 101,
          full_name: "openma-ai/OpenMatter",
          html_url: "https://github.com/openma-ai/OpenMatter",
        },
        issue: {
          id: 4200,
          number: 42,
          title: "Build a GitHub integration",
          html_url: "https://github.com/openma-ai/OpenMatter/issues/42",
          created_at: "2026-08-23T09:55:00Z",
          updated_at: "2026-08-23T09:56:00Z",
          token: "also-secret",
        },
        sender: { id: 7, login: "octocat" },
      },
    } as const;

    const events = await Effect.runPromise(
      integration.integration.ingest(input),
    );

    expect(events).toEqual([
      expect.objectContaining({
        schemaVersion: "0.1",
        id: "github:delivery-issue-opened",
        type: "github.issue.opened",
        occurredAt: "2026-08-23T09:56:00Z",
        receivedAt: "2026-08-23T10:00:00.000Z",
        idempotencyKey: "github:delivery-issue-opened",
        source: {
          provider: "github",
          authority: "9001",
          conversationId: "openma-ai/OpenMatter",
          threadId: "issue:42",
          uri: "https://github.com/openma-ai/OpenMatter/issues/42",
        },
        payload: {
          activation: "observation",
          eventName: "issues",
          action: "opened",
          installationId: "9001",
          repositoryId: 101,
          repository: "openma-ai/OpenMatter",
          resourceType: "issue",
          resourceId: 4200,
          resourceNumber: 42,
          resourceKey: "openma-ai/OpenMatter#42",
          actor: { id: "7", name: "octocat" },
        },
      }),
    ]);
    expect(JSON.stringify(events[0]?.raw)).not.toContain("never-expose");
    expect(JSON.stringify(events[0]?.raw)).not.toContain("also-secret");
    expect(input.payload.installation.access_token).toBe("never-expose");
  });

  it.each([
    {
      eventName: "issue_comment",
      action: "created",
      resource: {
        issue: {
          id: 5,
          number: 5,
          updated_at: "2026-08-23T09:00:00Z",
          html_url: "https://github.com/openma-ai/OpenMatter/pull/5",
          pull_request: { url: "https://api.github.com/pulls/5" },
        },
        comment: { id: 77, created_at: "2026-08-23T09:01:00Z" },
      },
      wantType: "github.pull_request.comment.created",
      wantThread: "pull_request:5",
      wantMessage: "issue_comment:77",
    },
    {
      eventName: "pull_request",
      action: "ready_for_review",
      resource: {
        pull_request: {
          id: 6,
          number: 6,
          updated_at: "2026-08-23T09:02:00Z",
          html_url: "https://github.com/openma-ai/OpenMatter/pull/6",
        },
      },
      wantType: "github.pull_request.ready_for_review",
      wantThread: "pull_request:6",
      wantMessage: undefined,
    },
    {
      eventName: "pull_request_review",
      action: "submitted",
      resource: {
        pull_request: {
          id: 6,
          number: 6,
          updated_at: "2026-08-23T09:02:00Z",
          html_url: "https://github.com/openma-ai/OpenMatter/pull/6",
        },
        review: { id: 88, submitted_at: "2026-08-23T09:03:00Z" },
      },
      wantType: "github.pull_request.review.submitted",
      wantThread: "pull_request:6",
      wantMessage: "review:88",
    },
    {
      eventName: "pull_request_review_comment",
      action: "created",
      resource: {
        pull_request: {
          id: 6,
          number: 6,
          updated_at: "2026-08-23T09:02:00Z",
          html_url: "https://github.com/openma-ai/OpenMatter/pull/6",
        },
        comment: { id: 99, created_at: "2026-08-23T09:04:00Z" },
      },
      wantType: "github.pull_request.review_comment.created",
      wantThread: "pull_request:6",
      wantMessage: "review_comment:99",
    },
    {
      eventName: "workflow_run",
      action: "completed",
      resource: {
        workflow_run: {
          id: 1234,
          updated_at: "2026-08-23T09:05:00Z",
          html_url: "https://github.com/openma-ai/OpenMatter/actions/runs/1234",
        },
      },
      wantType: "github.workflow_run.completed",
      wantThread: "workflow_run:1234",
      wantMessage: undefined,
    },
  ])(
    "maps $eventName/$action to $wantType without collapsing native identity",
    async ({
      eventName,
      action,
      resource,
      wantType,
      wantThread,
      wantMessage,
    }) => {
      const github =
        (await import("../packages/integration-github/src/index.js")) as unknown as {
          readonly makeGitHubIntegration: (options: {
            readonly token: string;
            readonly fetch: typeof globalThis.fetch;
          }) => { readonly integration: WorkIntegration };
        };
      const adapter = github.makeGitHubIntegration({
        token: "installation-token",
        fetch: async () => new Response("{}"),
      });

      const events = await Effect.runPromise(
        adapter.integration.ingest({
          kind: "github.webhook",
          eventName,
          deliveryId: `delivery-${eventName}`,
          payload: {
            action,
            installation: { id: 9001 },
            repository: {
              id: 101,
              full_name: "openma-ai/OpenMatter",
            },
            sender: { login: "octocat" },
            ...resource,
          },
        }),
      );

      expect(events[0]).toMatchObject({
        type: wantType,
        source: {
          provider: "github",
          authority: "9001",
          conversationId: "openma-ai/OpenMatter",
          threadId: wantThread,
          ...(wantMessage === undefined ? {} : { messageId: wantMessage }),
        },
      });
    },
  );

  it.each([
    {
      eventName: "issue_comment",
      resource: {
        issue: { id: 500, number: 5 },
        comment: { id: 77 },
      },
      wantPayload: {
        resourceType: "comment",
        resourceId: 77,
        parentResourceType: "issue",
        parentResourceId: 500,
        parentResourceKey: "openma-ai/OpenMatter#5",
      },
      wantResourceKey: undefined,
    },
    {
      eventName: "issue_comment",
      resource: {
        issue: {
          id: 501,
          number: 6,
          pull_request: { url: "https://api.github.com/pulls/6" },
        },
        comment: { id: 78 },
      },
      wantPayload: {
        resourceType: "comment",
        resourceId: 78,
        parentResourceType: "pull_request",
        parentResourceId: 501,
        parentResourceKey: "openma-ai/OpenMatter#6",
      },
      wantResourceKey: undefined,
    },
    {
      eventName: "pull_request_review",
      resource: {
        pull_request: { id: 600, number: 6 },
        review: { id: 88 },
      },
      wantPayload: {
        resourceType: "review",
        resourceId: 88,
        parentResourceType: "pull_request",
        parentResourceId: 600,
        parentResourceKey: "openma-ai/OpenMatter#6",
      },
      wantResourceKey: undefined,
    },
    {
      eventName: "pull_request_review_comment",
      resource: {
        pull_request: { id: 600, number: 6 },
        comment: { id: 99 },
      },
      wantPayload: {
        resourceType: "comment",
        resourceId: 99,
        parentResourceType: "pull_request",
        parentResourceId: 600,
        parentResourceKey: "openma-ai/OpenMatter#6",
      },
      wantResourceKey: undefined,
    },
    {
      eventName: "pull_request",
      resource: { pull_request: { id: 600, number: 6 } },
      wantPayload: {
        resourceType: "pull_request",
        resourceId: 600,
        resourceNumber: 6,
        resourceKey: "openma-ai/OpenMatter#6",
      },
      wantResourceKey: "openma-ai/OpenMatter#6",
    },
    {
      eventName: "workflow_run",
      resource: { workflow_run: { id: 1234 } },
      wantPayload: {
        resourceType: "workflow_run",
        resourceId: 1234,
      },
      wantResourceKey: undefined,
    },
  ])(
    "keeps $eventName resource identity separate from its parent work item",
    async ({ eventName, resource, wantPayload, wantResourceKey }) => {
      const github =
        (await import("../packages/integration-github/src/index.js")) as unknown as {
          readonly makeGitHubIntegration: (options: {
            readonly token: string;
            readonly fetch: typeof globalThis.fetch;
          }) => { readonly integration: WorkIntegration };
        };
      const adapter = github.makeGitHubIntegration({
        token: "installation-token",
        fetch: async () => new Response("{}"),
      });

      const events = await Effect.runPromise(
        adapter.integration.ingest({
          kind: "github.webhook",
          eventName,
          deliveryId: `delivery-identity-${eventName}`,
          payload: {
            action: "created",
            installation: { id: 9001 },
            repository: { id: 101, full_name: "openma-ai/OpenMatter" },
            ...resource,
          },
        }),
      );

      expect(events[0]?.payload).toMatchObject(wantPayload);
      if (wantResourceKey === undefined) {
        expect(events[0]?.payload).not.toHaveProperty("resourceKey");
        expect(events[0]?.payload).not.toHaveProperty("resourceNumber");
      }
    },
  );

  it("preserves an unknown webhook as a generic observation", async () => {
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly token: string;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      token: "installation-token",
      fetch: async () => new Response("{}"),
    });

    const events = await Effect.runPromise(
      adapter.integration.ingest({
        kind: "github.webhook",
        eventName: "milestone",
        deliveryId: "delivery-generic",
        payload: {
          action: "created",
          installation: { id: 9001 },
          repository: { id: 101, full_name: "openma-ai/OpenMatter" },
          sender: { login: "octocat" },
          milestone: { id: 4, title: "v1" },
        },
      }),
    );

    expect(events[0]).toMatchObject({
      type: "github.event.received",
      source: {
        provider: "github",
        authority: "9001",
        conversationId: "openma-ai/OpenMatter",
      },
      payload: {
        activation: "observation",
        eventName: "milestone",
        action: "created",
        installationId: "9001",
        repositoryId: 101,
        repository: "openma-ai/OpenMatter",
        resourceType: "event",
        actor: { name: "octocat" },
      },
    });
  });

  it("normalizes installation repository lifecycle without importing activation policy", async () => {
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly token: string;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      token: "installation-token",
      fetch: async () => new Response("{}"),
    });

    const events = await Effect.runPromise(
      adapter.integration.ingest({
        kind: "github.webhook",
        eventName: "installation_repositories",
        deliveryId: "delivery-repositories-added",
        payload: {
          action: "added",
          installation: { id: 9001 },
          repositories_added: [{ id: 101, full_name: "openma-ai/OpenMatter" }],
          repositories_removed: [],
          sender: { id: 7, login: "octocat" },
        },
      }),
    );

    expect(events[0]).toMatchObject({
      type: "github.installation.repositories.added",
      source: { provider: "github", authority: "9001" },
      payload: {
        activation: "observation",
        eventName: "installation_repositories",
        action: "added",
        installationId: "9001",
        resourceType: "installation",
        resourceId: "9001",
        actor: { id: "7", name: "octocat" },
      },
      raw: {
        repositories_added: [{ id: 101, full_name: "openma-ai/OpenMatter" }],
      },
    });
  });

  it("reads one explicit issue-comment page and exposes the Link cursor", async () => {
    const requests: Array<{
      readonly integrationId: string;
      readonly authority: string;
    }> = [];
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly credentials: (installationId: string) => {
            readonly token: string;
          };
          readonly fetch: typeof globalThis.fetch;
        }) => {
          readonly integration: WorkIntegration;
          readonly context: {
            readonly issueComments: (input: {
              readonly installationId: string;
              readonly owner: string;
              readonly repo: string;
              readonly issueNumber: number;
              readonly limit?: number;
              readonly page?: number;
            }) => Effect.Effect<ContextItem, unknown>;
          };
        };
      };
    const adapter = github.makeGitHubIntegration({
      credentials: (installationId: string) => {
        requests.push({ integrationId: "github", authority: installationId });
        return { token: `token-${installationId}` };
      },
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          ...(init === undefined ? {} : { init }),
        });
        return new Response(
          JSON.stringify([
            {
              id: 77,
              body: "First",
              html_url:
                "https://github.com/openma-ai/OpenMatter/issues/42#issuecomment-77",
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: '<https://api.github.com/repos/openma-ai/OpenMatter/issues/42/comments?per_page=50&page=3>; rel="next", <https://api.github.com/repos/openma-ai/OpenMatter/issues/42/comments?per_page=50&page=4>; rel="last"',
            },
          },
        );
      },
    });

    const context = await Effect.runPromise(
      adapter.context.issueComments({
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        issueNumber: 42,
        limit: 50,
        page: 2,
      }),
    );

    expect(requests).toEqual([{ integrationId: "github", authority: "9001" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/openma-ai/OpenMatter/issues/42/comments?per_page=50&page=2",
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer token-9001",
    );
    expect(context).toEqual({
      id: "github:9001:issue-comments:openma-ai/OpenMatter:42:page:2",
      kind: "github.issue-comments",
      value: {
        installationId: "9001",
        repository: "openma-ai/OpenMatter",
        issueNumber: 42,
        items: [
          {
            id: 77,
            body: "First",
            html_url:
              "https://github.com/openma-ai/OpenMatter/issues/42#issuecomment-77",
          },
        ],
        page: 2,
        limit: 50,
        hasMore: true,
        nextPage: 3,
      },
      provenance: [
        {
          sourceType: "github-rest",
          sourceId: "openma-ai/OpenMatter#42:comments:page:2",
          integrationId: "github",
          uri: "https://github.com/openma-ai/OpenMatter/issues/42",
        },
      ],
    });
  });

  it("delivers a finite issue comment operation with the installation credential", async () => {
    const credentialAuthorities: string[] = [];
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
      [];
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly credentials: (installationId: string) => {
            readonly token: string;
          };
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      credentials: (installationId: string) => {
        credentialAuthorities.push(installationId);
        return { token: `token-${installationId}` };
      },
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          ...(init === undefined ? {} : { init }),
        });
        return new Response(JSON.stringify({ id: 77, body: "On it" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await Effect.runPromise(
      adapter.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-1",
        eventId: "github:delivery-1",
        integrationId: "github",
        operation: "issue.comment.create",
        idempotencyKey: "comment-on-42",
        input: {
          installationId: "9001",
          owner: "openma-ai",
          repo: "OpenMatter",
          issueNumber: 42,
          body: "On it",
        },
      }),
    );

    expect(credentialAuthorities).toEqual(["9001"]);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/openma-ai/OpenMatter/issues/42/comments",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe('{"body":"On it"}');
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer token-9001",
    );
    expect(result).toEqual({ providerReceipt: { id: 77, body: "On it" } });
  });

  it("passes GitHub installation authority to a provider-neutral credential resolver", async () => {
    const requests: Array<{
      readonly integrationId: string;
      readonly authority: string;
    }> = [];
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly credentials: ReturnType<
            typeof makeCredentialResolver<{
              readonly token: string;
            }>
          >;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      credentials: makeCredentialResolver((request) => {
        requests.push(request);
        return { token: "resolved-installation-token" };
      }),
      fetch: async () =>
        new Response(JSON.stringify({ id: 77 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    });

    await Effect.runPromise(
      adapter.integration.deliver({
        schemaVersion: "0.1",
        id: "effect-resolver",
        eventId: "github:delivery-resolver",
        integrationId: "github",
        operation: "issue.comment.create",
        idempotencyKey: "resolver",
        input: {
          installationId: "9001",
          owner: "openma-ai",
          repo: "OpenMatter",
          issueNumber: 42,
          body: "Resolved",
        },
      }),
    );

    expect(requests).toEqual([{ integrationId: "github", authority: "9001" }]);
  });

  it("rejects arbitrary REST effects before any provider call", async () => {
    let calls = 0;
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly token: string;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      token: "installation-token",
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      },
    });

    const outcome = await Effect.runPromise(
      Effect.either(
        adapter.integration.deliver({
          schemaVersion: "0.1",
          id: "effect-arbitrary",
          eventId: "github:delivery-1",
          integrationId: "github",
          operation: "rest.call",
          idempotencyKey: "arbitrary",
          input: {
            installationId: "9001",
            method: "DELETE",
            path: "/repos/openma-ai/OpenMatter",
          },
        }),
      ),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toMatchObject({ retryable: false });
    }
    expect(calls).toBe(0);
  });

  it.each([
    {
      reader: "repository",
      input: { installationId: "9001", owner: "openma-ai", repo: "OpenMatter" },
      url: "https://api.github.com/repos/openma-ai/OpenMatter",
      response: { id: 101, full_name: "openma-ai/OpenMatter" },
      kind: "github.repository",
      valueKey: "repositoryData",
    },
    {
      reader: "issue",
      input: {
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        issueNumber: 42,
      },
      url: "https://api.github.com/repos/openma-ai/OpenMatter/issues/42",
      response: { id: 42, number: 42, title: "Issue" },
      kind: "github.issue",
      valueKey: "issue",
    },
    {
      reader: "pullRequest",
      input: {
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        pullNumber: 7,
      },
      url: "https://api.github.com/repos/openma-ai/OpenMatter/pulls/7",
      response: { id: 7, number: 7, title: "Pull request" },
      kind: "github.pull-request",
      valueKey: "pullRequest",
    },
    {
      reader: "pullRequestFiles",
      input: {
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        pullNumber: 7,
        page: 2,
        limit: 25,
      },
      url: "https://api.github.com/repos/openma-ai/OpenMatter/pulls/7/files?per_page=25&page=2",
      response: [{ sha: "abc", filename: "src/index.ts", status: "modified" }],
      kind: "github.pull-request-files",
      valueKey: "items",
    },
    {
      reader: "pullRequestReviews",
      input: {
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        pullNumber: 7,
        page: 1,
        limit: 40,
      },
      url: "https://api.github.com/repos/openma-ai/OpenMatter/pulls/7/reviews?per_page=40&page=1",
      response: [{ id: 88, state: "APPROVED", body: "LGTM" }],
      kind: "github.pull-request-reviews",
      valueKey: "items",
    },
    {
      reader: "workflowRun",
      input: {
        installationId: "9001",
        owner: "openma-ai",
        repo: "OpenMatter",
        runId: 1234,
      },
      url: "https://api.github.com/repos/openma-ai/OpenMatter/actions/runs/1234",
      response: { id: 1234, name: "CI", status: "completed" },
      kind: "github.workflow-run",
      valueKey: "workflowRun",
    },
  ])(
    "$reader reads only its explicit GitHub resource",
    async ({ reader, input, url, response, kind, valueKey }) => {
      const calls: string[] = [];
      const github =
        (await import("../packages/integration-github/src/index.js")) as unknown as {
          readonly makeGitHubIntegration: (options: {
            readonly token: string;
            readonly fetch: typeof globalThis.fetch;
          }) => {
            readonly context: Record<
              string,
              (
                input: Readonly<Record<string, string | number>>,
              ) => Effect.Effect<ContextItem, unknown>
            >;
          };
        };
      const adapter = github.makeGitHubIntegration({
        token: "installation-token",
        fetch: async (request) => {
          calls.push(String(request));
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const context = await Effect.runPromise(adapter.context[reader]!(input));

      expect(calls).toEqual([url]);
      expect(context.kind).toBe(kind);
      expect(context.value).toMatchObject({
        installationId: "9001",
        repository: "openma-ai/OpenMatter",
        [valueKey]: response,
      });
      expect(context.provenance).toEqual([
        expect.objectContaining({
          sourceType: "github-rest",
          integrationId: "github",
        }),
      ]);
    },
  );

  it.each([
    {
      operation: "issue.comment.update",
      input: { commentId: 77, body: "Updated" },
      method: "PATCH",
      path: "/issues/comments/77",
      body: { body: "Updated" },
    },
    {
      operation: "issue.comment.delete",
      input: { commentId: 77 },
      method: "DELETE",
      path: "/issues/comments/77",
      body: undefined,
    },
    {
      operation: "issue.update",
      input: {
        issueNumber: 42,
        title: "New title",
        state: "closed",
        stateReason: "completed",
        labels: ["agent", "ready"],
        assignees: ["octocat"],
      },
      method: "PATCH",
      path: "/issues/42",
      body: {
        title: "New title",
        state: "closed",
        state_reason: "completed",
        labels: ["agent", "ready"],
        assignees: ["octocat"],
      },
    },
    {
      operation: "issue.reaction.add",
      input: { issueNumber: 42, content: "rocket" },
      method: "POST",
      path: "/issues/42/reactions",
      body: { content: "rocket" },
    },
    {
      operation: "issue.reaction.delete",
      input: { issueNumber: 42, reactionId: 501 },
      method: "DELETE",
      path: "/issues/42/reactions/501",
      body: undefined,
    },
    {
      operation: "issue.comment.reaction.add",
      input: { commentId: 77, content: "eyes" },
      method: "POST",
      path: "/issues/comments/77/reactions",
      body: { content: "eyes" },
    },
    {
      operation: "issue.comment.reaction.delete",
      input: { commentId: 77, reactionId: 502 },
      method: "DELETE",
      path: "/issues/comments/77/reactions/502",
      body: undefined,
    },
    {
      operation: "pull_request.review.create",
      input: {
        pullNumber: 7,
        commitId: "abc123",
        body: "Please fix this",
        event: "REQUEST_CHANGES",
        comments: [
          { path: "src/index.ts", line: 9, side: "RIGHT", body: "Why?" },
        ],
      },
      method: "POST",
      path: "/pulls/7/reviews",
      body: {
        commit_id: "abc123",
        body: "Please fix this",
        event: "REQUEST_CHANGES",
        comments: [
          { path: "src/index.ts", line: 9, side: "RIGHT", body: "Why?" },
        ],
      },
    },
    {
      operation: "pull_request.review_comment.create",
      input: {
        pullNumber: 7,
        commitId: "abc123",
        path: "src/index.ts",
        line: 9,
        side: "RIGHT",
        body: "Why?",
      },
      method: "POST",
      path: "/pulls/7/comments",
      body: {
        commit_id: "abc123",
        path: "src/index.ts",
        line: 9,
        side: "RIGHT",
        body: "Why?",
      },
    },
    {
      operation: "pull_request.merge",
      input: {
        pullNumber: 7,
        sha: "abc123",
        mergeMethod: "squash",
        commitTitle: "Merge PR 7",
      },
      method: "PUT",
      path: "/pulls/7/merge",
      body: {
        sha: "abc123",
        merge_method: "squash",
        commit_title: "Merge PR 7",
      },
    },
    {
      operation: "workflow.dispatch",
      input: {
        workflowId: "ci.yml",
        ref: "main",
        inputs: { environment: "staging" },
      },
      method: "POST",
      path: "/actions/workflows/ci.yml/dispatches",
      body: { ref: "main", inputs: { environment: "staging" } },
    },
  ])(
    "$operation maps to one finite GitHub REST operation",
    async ({ operation, input, method, path, body }) => {
      const calls: Array<{
        readonly url: string;
        readonly init?: RequestInit;
      }> = [];
      const github =
        (await import("../packages/integration-github/src/index.js")) as unknown as {
          readonly makeGitHubIntegration: (options: {
            readonly token: string;
            readonly fetch: typeof globalThis.fetch;
          }) => { readonly integration: WorkIntegration };
        };
      const adapter = github.makeGitHubIntegration({
        token: "installation-token",
        fetch: async (request, init) => {
          calls.push({
            url: String(request),
            ...(init === undefined ? {} : { init }),
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      await Effect.runPromise(
        adapter.integration.deliver({
          schemaVersion: "0.1",
          id: `effect-${operation}`,
          eventId: "github:delivery-1",
          integrationId: "github",
          operation,
          idempotencyKey: `key-${operation}`,
          input: {
            installationId: "9001",
            owner: "openma-ai",
            repo: "OpenMatter",
            ...input,
          },
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        `https://api.github.com/repos/openma-ai/OpenMatter${path}`,
      );
      expect(calls[0]?.init?.method).toBe(method);
      expect(calls[0]?.init?.body).toBe(
        body === undefined ? undefined : JSON.stringify(body),
      );
    },
  );

  it.each([
    {
      name: "ordinary permission denial",
      status: 403,
      headers: {},
      retryable: false,
      retryAt: undefined,
    },
    {
      name: "primary rate limit",
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1800000000",
      },
      retryable: true,
      retryAt: "2027-01-15T08:00:00.000Z",
    },
    {
      name: "429 with Retry-After",
      status: 429,
      headers: { "retry-after": "60" },
      retryable: true,
      retryAt: "2026-08-23T10:01:00.000Z",
    },
    {
      name: "provider outage",
      status: 503,
      headers: {},
      retryable: true,
      retryAt: undefined,
    },
  ])(
    "classifies $name without retrying terminal authorization errors",
    async ({ status, headers, retryable, retryAt }) => {
      const github =
        (await import("../packages/integration-github/src/index.js")) as unknown as {
          readonly makeGitHubIntegration: (options: {
            readonly token: string;
            readonly clock: () => string;
            readonly fetch: typeof globalThis.fetch;
          }) => { readonly integration: WorkIntegration };
        };
      const adapter = github.makeGitHubIntegration({
        token: "installation-token",
        clock: () => "2026-08-23T10:00:00.000Z",
        fetch: async () =>
          new Response(JSON.stringify({ message: "provider error" }), {
            status,
            headers: { "content-type": "application/json", ...headers },
          }),
      });

      const outcome = await Effect.runPromise(
        Effect.either(
          adapter.integration.deliver({
            schemaVersion: "0.1",
            id: `effect-error-${status}`,
            eventId: "github:delivery-error",
            integrationId: "github",
            operation: "issue.comment.create",
            idempotencyKey: `error-${status}`,
            input: {
              installationId: "9001",
              owner: "openma-ai",
              repo: "OpenMatter",
              issueNumber: 42,
              body: "Will fail",
            },
          }),
        ),
      );

      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left).toMatchObject({
          retryable,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
        if (retryAt === undefined) {
          expect("retryAt" in outcome.left).toBe(false);
        }
      }
    },
  );

  it("preserves rate-limit retry metadata when GitHub returns malformed JSON", async () => {
    const github =
      (await import("../packages/integration-github/src/index.js")) as unknown as {
        readonly makeGitHubIntegration: (options: {
          readonly token: string;
          readonly fetch: typeof globalThis.fetch;
        }) => { readonly integration: WorkIntegration };
      };
    const adapter = github.makeGitHubIntegration({
      token: "installation-token",
      fetch: async () =>
        new Response("not-json", {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          },
        }),
    });

    const outcome = await Effect.runPromise(
      Effect.either(
        adapter.integration.deliver({
          schemaVersion: "0.1",
          id: "effect-malformed-rate-limit",
          eventId: "github:delivery-malformed-rate-limit",
          integrationId: "github",
          operation: "issue.comment.create",
          idempotencyKey: "malformed-rate-limit",
          input: {
            installationId: "9001",
            owner: "openma-ai",
            repo: "OpenMatter",
            issueNumber: 42,
            body: "Will fail",
          },
        }),
      ),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toMatchObject({
        retryable: true,
        retryAt: "2027-01-15T08:00:00.000Z",
      });
    }
  });
});
