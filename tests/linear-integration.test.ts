import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeCredentialResolver } from "../packages/credentials/src/index.js";
import {
  makeLinearHttpEndpoint,
  makeLinearIntegration,
} from "../packages/integration-linear/src/index.js";

const signedLinearRequest = (body: string, signature?: string) =>
  new Request("https://example.com/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "linear-signature":
        signature ??
        createHmac("sha256", "linear-signing-secret")
          .update(body)
          .digest("hex"),
      "linear-delivery": "delivery-1",
      "linear-event": "Issue",
      "linear-timestamp": "1787479198000",
    },
    body,
  });

const linearWebhook = (
  payload: Record<string, unknown>,
  deliveryId = "delivery-1",
) => ({
  kind: "linear.webhook" as const,
  deliveryId,
  eventName: String(payload.type ?? ""),
  timestamp: String(payload.webhookTimestamp ?? ""),
  payload,
});

describe("Linear WorkIntegration", () => {
  it("normalizes an issue creation into an organization-scoped WorkEvent", async () => {
    const linear = makeLinearIntegration({
      credentials: {
        kind: "oauth",
        accessToken: "oauth-secret",
      },
      clock: () => "2026-08-23T10:00:00.000Z",
      fetch: async () =>
        new Response(JSON.stringify({ data: {} }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const payload = {
      action: "create",
      type: "Issue",
      createdAt: "2026-08-23T09:59:58.000Z",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1787479198000,
      url: "https://linear.app/acme/issue/ENG-42/fix-build",
      actor: {
        id: "user-1",
        type: "user",
        name: "Ada",
        email: "ada@example.com",
        url: "https://linear.app/acme/profiles/ada",
      },
      data: {
        id: "issue-uuid-42",
        identifier: "ENG-42",
        title: "Fix build",
        teamId: "team-1",
        projectId: "project-1",
        createdAt: "2026-08-23T09:59:58.000Z",
        updatedAt: "2026-08-23T09:59:58.000Z",
      },
    };

    const events = await Effect.runPromise(
      linear.integration.ingest(linearWebhook(payload)),
    );

    expect(events).toEqual([
      {
        schemaVersion: "0.1",
        id: "linear:delivery-1",
        type: "linear.issue.created",
        occurredAt: "2026-08-23T09:59:58.000Z",
        receivedAt: "2026-08-23T10:00:00.000Z",
        idempotencyKey: "linear:delivery-1",
        source: {
          provider: "linear",
          authority: "org-1",
          conversationId: "project-1",
          threadId: "issue-uuid-42",
          uri: "https://linear.app/acme/issue/ENG-42/fix-build",
        },
        payload: {
          activation: "observation",
          organizationId: "org-1",
          resourceType: "issue",
          resourceId: "issue-uuid-42",
          resourceKey: "ENG-42",
          parentResourceType: "project",
          parentResourceId: "project-1",
          action: "create",
          actor: { id: "user-1", name: "Ada" },
        },
        raw: payload,
        extensions: {
          deliveryId: "delivery-1",
          eventName: "Issue",
          deliveryTimestamp: "1787479198000",
        },
      },
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("verifies a signed raw webhook before submitting semantic work", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      clock: () => "2026-08-23T10:00:00.000Z",
      fetch: async () => new Response(JSON.stringify({ data: {} })),
    });
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      createdAt: "2026-08-23T09:59:58.000Z",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: Date.parse("2026-08-23T09:59:58.000Z"),
      data: { id: "issue-uuid-42", title: "Fix build" },
    });
    const submitted: unknown[] = [];
    const events: unknown[] = [];
    const endpoint = makeLinearHttpEndpoint({
      signingSecret: "linear-signing-secret",
      now: () => Date.parse("2026-08-23T10:00:00.000Z"),
      submit: async (input) => {
        submitted.push(input);
        events.push(
          ...(await Effect.runPromise(linear.integration.ingest(input))),
        );
      },
    });

    const response = await endpoint.handle(signedLinearRequest(body));

    expect(response.status).toBe(200);
    expect(submitted).toEqual([
      {
        kind: "linear.webhook",
        deliveryId: "delivery-1",
        eventName: "Issue",
        timestamp: "1787479198000",
        payload: JSON.parse(body),
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "linear.issue.created",
        source: expect.objectContaining({ authority: "org-1" }),
      }),
    ]);
  });

  it("rejects unsigned or stale webhook deliveries without submitting", async () => {
    const submitted: unknown[] = [];
    const endpoint = makeLinearHttpEndpoint({
      signingSecret: "linear-signing-secret",
      now: () => Date.parse("2026-08-23T10:00:00.000Z"),
      submit: async (input) => {
        submitted.push(input);
      },
    });
    const currentBody = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "org-1",
      webhookTimestamp: Date.parse("2026-08-23T09:59:58.000Z"),
    });
    const staleBody = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "org-1",
      webhookTimestamp: Date.parse("2026-08-23T09:50:00.000Z"),
    });

    const invalid = await endpoint.handle(
      signedLinearRequest(currentBody, "not-a-signature"),
    );
    const stale = await endpoint.handle(signedLinearRequest(staleBody));

    expect(invalid.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(submitted).toEqual([]);
  });

  it("contains a Web Crypto verification failure at the HTTP boundary", async () => {
    const submitted: unknown[] = [];
    const endpoint = makeLinearHttpEndpoint({
      signingSecret: "linear-signing-secret",
      now: () => Date.parse("2026-08-23T10:00:00.000Z"),
      submit: async (input) => {
        submitted.push(input);
      },
    });
    const body = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "org-1",
      webhookTimestamp: Date.parse("2026-08-23T09:59:58.000Z"),
    });
    const importKey = vi
      .spyOn(globalThis.crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("crypto unavailable"));

    try {
      const response = await endpoint.handle(signedLinearRequest(body));
      expect(response.status).toBe(500);
      expect(submitted).toEqual([]);
    } finally {
      importKey.mockRestore();
    }
  });

  it("rejects a native payload that bypasses the verified delivery envelope", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
    });

    const error = await Effect.runPromise(
      linear.integration
        .ingest({
          type: "Issue",
          action: "create",
          organizationId: "org-1",
          webhookId: "subscription-1",
          webhookTimestamp: 1787479198000,
          createdAt: "2026-08-23T09:59:58.000Z",
          data: { id: "issue-1" },
        })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "IntegrationError",
      retryable: false,
    });
  });

  it("redacts credential-like fields from retained native webhook data", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
    });
    const [event] = await Effect.runPromise(
      linear.integration.ingest(
        linearWebhook({
          type: "Issue",
          action: "update",
          organizationId: "org-1",
          webhookId: "subscription-1",
          webhookTimestamp: 1787479198000,
          createdAt: "2026-08-23T09:59:58.000Z",
          data: {
            id: "issue-1",
            title: "Fix build",
            accessToken: "payload-access-secret",
            nested: {
              apiKey: "payload-api-secret",
              signingSecret: "payload-signing-secret",
              authorization: "Bearer payload-auth-secret",
            },
          },
        }),
      ),
    );

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("payload-access-secret");
    expect(serialized).not.toContain("payload-api-secret");
    expect(serialized).not.toContain("payload-signing-secret");
    expect(serialized).not.toContain("payload-auth-secret");
  });

  it.each([
    {
      type: "Issue",
      action: "update",
      data: { id: "issue-1", projectId: "project-1", title: "Updated" },
      eventType: "linear.issue.updated",
      resourceType: "issue",
      source: {
        conversationId: "project-1",
        threadId: "issue-1",
      },
      relation: {
        parentResourceType: "project",
        parentResourceId: "project-1",
      },
    },
    {
      type: "Comment",
      action: "create",
      data: { id: "comment-1", issueId: "issue-1", body: "Investigating" },
      eventType: "linear.comment.created",
      resourceType: "comment",
      source: {
        conversationId: "issue-1",
        threadId: "issue-1",
        messageId: "comment-1",
      },
      relation: {
        parentResourceType: "issue",
        parentResourceId: "issue-1",
      },
    },
    {
      type: "Project",
      action: "remove",
      data: { id: "project-1", name: "Launch" },
      eventType: "linear.project.removed",
      resourceType: "project",
      source: {
        conversationId: "project-1",
        threadId: "project-1",
      },
      relation: {},
    },
    {
      type: "Document",
      action: "update",
      data: { id: "document-1", projectId: "project-1", title: "Spec" },
      eventType: "linear.document.updated",
      resourceType: "document",
      source: {
        conversationId: "project-1",
        threadId: "document-1",
      },
      relation: {
        parentResourceType: "project",
        parentResourceId: "project-1",
      },
    },
    {
      type: "Cycle",
      action: "update",
      data: { id: "cycle-1", name: "Cycle 12" },
      eventType: "linear.event.received",
      resourceType: "event",
      source: { threadId: "cycle-1" },
      relation: {},
    },
  ])("maps $type/$action into $eventType", async (example) => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      clock: () => "2026-08-23T10:00:00.000Z",
    });
    const payload = {
      action: example.action,
      type: example.type,
      createdAt: "2026-08-23T09:59:58.000Z",
      organizationId: "org-1",
      webhookId: "webhook-1",
      webhookTimestamp: 1787479198000,
      url: `https://linear.app/acme/${example.type.toLowerCase()}/${example.data.id}`,
      actor: null,
      data: example.data,
    };

    const events = await Effect.runPromise(
      linear.integration.ingest(linearWebhook(payload)),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: "linear:delivery-1",
        idempotencyKey: "linear:delivery-1",
        type: example.eventType,
        source: {
          provider: "linear",
          authority: "org-1",
          ...example.source,
          uri: payload.url,
        },
        payload: expect.objectContaining({
          activation: "observation",
          organizationId: "org-1",
          resourceType: example.resourceType,
          resourceId: example.data.id,
          action: example.action,
          ...example.relation,
        }),
      }),
    ]);
    expect(events[0]?.payload).not.toHaveProperty("actor");
  });

  it.each([
    ["issueAssignedToYou", "linear.issue.assigned-to-agent", "assignment"],
    ["issueMention", "linear.issue.mentioned", "mention"],
    ["issueCommentMention", "linear.comment.mentioned", "mention"],
    ["issueNewComment", "linear.issue.comment-received", "notification"],
  ] as const)(
    "preserves AppUserNotification %s as %s",
    async (subtype, eventType, activation) => {
      const linear = makeLinearIntegration({
        credentials: { kind: "oauth", accessToken: "oauth-secret" },
        clock: () => "2026-08-23T10:00:00.000Z",
      });
      const notification = {
        type: subtype,
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Fix build",
        },
        comment: {
          id: "comment-1",
          body: "@Matter please investigate",
        },
        actor: { id: "user-1", name: "Ada" },
      };

      const [event] = await Effect.runPromise(
        linear.integration.ingest(
          linearWebhook({
            type: "AppUserNotification",
            action: subtype,
            createdAt: "2026-08-23T09:59:58.000Z",
            organizationId: "org-1",
            webhookId: "webhook-1",
            webhookTimestamp: 1787479198000,
            notification,
          }),
        ),
      );

      expect(event).toMatchObject({
        type: eventType,
        source: {
          provider: "linear",
          authority: "org-1",
          threadId: "issue-1",
          messageId: "comment-1",
        },
        payload: {
          activation,
          organizationId: "org-1",
          resourceType:
            subtype === "issueCommentMention" || subtype === "issueNewComment"
              ? "comment"
              : "issue",
          resourceId:
            subtype === "issueCommentMention" || subtype === "issueNewComment"
              ? "comment-1"
              : "issue-1",
          ...(subtype === "issueCommentMention" || subtype === "issueNewComment"
            ? {
                parentResourceType: "issue",
                parentResourceId: "issue-1",
                parentResourceKey: "ENG-42",
              }
            : { resourceKey: "ENG-42" }),
          action: subtype,
          notificationType: subtype,
          issueId: "issue-1",
          commentId: "comment-1",
          actor: notification.actor,
        },
      });
      expect(linear.integration.manifest.events).toContain(event?.type);
    },
  );

  it.each([
    ["created", "linear.agent-session.created"],
    ["prompted", "linear.agent-session.prompted"],
  ] as const)(
    "preserves AgentSessionEvent %s context as %s",
    async (action, eventType) => {
      const linear = makeLinearIntegration({
        credentials: { kind: "oauth", accessToken: "oauth-secret" },
        clock: () => "2026-08-23T10:00:00.000Z",
      });
      const promptContext =
        "&lt;issue identifier=&quot;ENG-42&quot;&gt;Fix build&lt;/issue&gt;";
      const agentSession = {
        id: "agent-session-1",
        issue: { id: "issue-1", identifier: "ENG-42" },
        comment: { id: "comment-1", body: "Please fix this" },
        creator: { id: "user-1", name: "Ada" },
      };

      const [event] = await Effect.runPromise(
        linear.integration.ingest(
          linearWebhook({
            type: "AgentSessionEvent",
            action,
            createdAt: "2026-08-23T09:59:58.000Z",
            organizationId: "org-1",
            webhookId: "webhook-1",
            webhookTimestamp: 1787479198000,
            agentSession,
            promptContext,
          }),
        ),
      );

      expect(event).toMatchObject({
        type: eventType,
        source: {
          provider: "linear",
          authority: "org-1",
          threadId: "issue-1",
          messageId: "comment-1",
        },
        payload: {
          activation: "direct",
          organizationId: "org-1",
          resourceType: "agent_session",
          resourceId: "agent-session-1",
          parentResourceType: "issue",
          parentResourceId: "issue-1",
          parentResourceKey: "ENG-42",
          action,
          actor: { id: "user-1", name: "Ada" },
          agentSessionId: "agent-session-1",
          issueId: "issue-1",
          commentId: "comment-1",
          promptContext,
        },
      });
      expect(linear.integration.manifest.events).toContain(event?.type);
    },
  );

  it("surfaces the parent comment id on follow-up Comment/create events", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
    });

    const [event] = await Effect.runPromise(
      linear.integration.ingest(
        linearWebhook({
          type: "Comment",
          action: "create",
          createdAt: "2026-08-23T09:59:58.000Z",
          organizationId: "org-1",
          webhookId: "webhook-1",
          webhookTimestamp: 1787479198000,
          data: {
            id: "comment-2",
            issueId: "issue-1",
            parent: { id: "comment-root" },
            body: "Here are the logs",
          },
        }),
      ),
    );

    expect(event).toMatchObject({
      type: "linear.comment.created",
      payload: {
        parentResourceType: "issue",
        parentResourceId: "issue-1",
        parentCommentId: "comment-root",
      },
    });
    expect(event?.payload).not.toHaveProperty("actor");
  });

  it.each([
    {
      method: "issue" as const,
      input: { organizationId: "org-1", issueId: "ENG-42" },
      operationName: "OpenMatterLinearIssue",
      variables: { id: "ENG-42" },
      response: {
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Fix build",
          url: "https://linear.app/acme/issue/ENG-42/fix-build",
        },
      },
      expected: {
        id: "linear:org-1:issue:ENG-42",
        kind: "linear.issue",
        sourceId: "org-1:ENG-42",
        value: {
          organizationId: "org-1",
          issue: {
            id: "issue-1",
            identifier: "ENG-42",
            title: "Fix build",
            url: "https://linear.app/acme/issue/ENG-42/fix-build",
          },
        },
      },
    },
    {
      method: "project" as const,
      input: { organizationId: "org-1", projectId: "project-1" },
      operationName: "OpenMatterLinearProject",
      variables: { id: "project-1" },
      response: {
        project: {
          id: "project-1",
          name: "Launch",
          url: "https://linear.app/acme/project/launch",
        },
      },
      expected: {
        id: "linear:org-1:project:project-1",
        kind: "linear.project",
        sourceId: "org-1:project-1",
        value: {
          organizationId: "org-1",
          project: {
            id: "project-1",
            name: "Launch",
            url: "https://linear.app/acme/project/launch",
          },
        },
      },
    },
    {
      method: "document" as const,
      input: { organizationId: "org-1", documentId: "document-1" },
      operationName: "OpenMatterLinearDocument",
      variables: { id: "document-1" },
      response: {
        document: {
          id: "document-1",
          title: "Launch spec",
          content: "Ship it",
          url: "https://linear.app/acme/document/launch-spec",
        },
      },
      expected: {
        id: "linear:org-1:document:document-1",
        kind: "linear.document",
        sourceId: "org-1:document-1",
        value: {
          organizationId: "org-1",
          document: {
            id: "document-1",
            title: "Launch spec",
            content: "Ship it",
            url: "https://linear.app/acme/document/launch-spec",
          },
        },
      },
    },
  ])("reads $method through its finite GraphQL query", async (example) => {
    const credentialRequests: unknown[] = [];
    const apiCalls: Array<Record<string, unknown>> = [];
    const linear = makeLinearIntegration({
      credentials: makeCredentialResolver((request) => {
        credentialRequests.push(request);
        return { kind: "apiKey", apiKey: "lin_api_secret" };
      }),
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "lin_api_secret",
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        apiCalls.push(body);
        return new Response(JSON.stringify({ data: example.response }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const read =
      example.method === "issue"
        ? linear.context.issue(example.input)
        : example.method === "project"
          ? linear.context.project(example.input)
          : linear.context.document(example.input);
    const item = await Effect.runPromise(read);

    expect(credentialRequests).toEqual([
      { integrationId: "linear", authority: "org-1" },
    ]);
    expect(apiCalls).toEqual([
      expect.objectContaining({
        operationName: example.operationName,
        variables: example.variables,
      }),
    ]);
    expect(item).toEqual({
      id: example.expected.id,
      kind: example.expected.kind,
      value: example.expected.value,
      provenance: [
        {
          sourceType: "linear-api",
          sourceId: example.expected.sourceId,
          integrationId: "linear",
          uri: (Object.values(example.response)[0] as { url: string }).url,
        },
      ],
    });
  });

  it("reads one explicit cursor page of issue comments", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer oauth-secret",
        );
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-1",
                identifier: "ENG-42",
                url: "https://linear.app/acme/issue/ENG-42/fix-build",
                comments: {
                  nodes: [
                    {
                      id: "comment-2",
                      body: "Investigating",
                      createdAt: "2026-08-23T09:00:00.000Z",
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-next" },
                },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const item = await Effect.runPromise(
      linear.context.issueComments({
        organizationId: "org-1",
        issueId: "ENG-42",
        first: 25,
        after: "cursor-current",
      }),
    );

    expect(calls).toEqual([
      expect.objectContaining({
        operationName: "OpenMatterLinearIssueComments",
        variables: {
          id: "ENG-42",
          first: 25,
          after: "cursor-current",
        },
      }),
    ]);
    expect(item).toMatchObject({
      id: "linear:org-1:issue-comments:ENG-42",
      kind: "linear.issue-comments",
      value: {
        organizationId: "org-1",
        issueId: "ENG-42",
        comments: [
          {
            id: "comment-2",
            body: "Investigating",
            createdAt: "2026-08-23T09:00:00.000Z",
          },
        ],
        hasMore: true,
        nextCursor: "cursor-next",
      },
    });
  });

  it("rejects invalid Context input before resolving credentials or fetching", async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify({ data: {} }))),
    );
    const credentialResolver = vi.fn(() => ({
      kind: "oauth" as const,
      accessToken: "oauth-secret",
    }));
    const linear = makeLinearIntegration({
      credentials: credentialResolver,
      fetch: fetchImplementation,
    });
    const invalidReads = [
      linear.context.issue({ organizationId: "", issueId: "ENG-42" }),
      linear.context.issue({ organizationId: "org-1", issueId: "" }),
      linear.context.project({ organizationId: "org-1", projectId: "" }),
      linear.context.document({ organizationId: "org-1", documentId: "" }),
      linear.context.issueComments({
        organizationId: "org-1",
        issueId: "ENG-42",
        first: 0,
      }),
      linear.context.issueComments({
        organizationId: "org-1",
        issueId: "ENG-42",
        first: 251,
      }),
      linear.context.issueComments({
        organizationId: "org-1",
        issueId: "ENG-42",
        first: 1.5,
      }),
      linear.context.issueComments({
        organizationId: "org-1",
        issueId: "ENG-42",
        after: "",
      }),
    ];

    for (const read of invalidReads) {
      const error = await Effect.runPromise(read.pipe(Effect.flip));
      expect(error).toMatchObject({
        _tag: "IntegrationError",
        retryable: false,
      });
    }
    expect(credentialResolver).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails an invalid credential resolver as a typed terminal error", async () => {
    const linear = makeLinearIntegration({
      credentials: {} as never,
    });

    const error = await Effect.runPromise(
      linear.context
        .issue({ organizationId: "org-1", issueId: "ENG-42" })
        .pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "IntegrationError",
      message: "Linear credential resolver is invalid",
      retryable: false,
    });
  });

  it.each([
    {
      operation: "issue.create",
      input: {
        organizationId: "org-1",
        teamId: "team-1",
        title: "Fix build",
        description: "CI is red",
        priority: 2,
        arbitrary: "must-not-pass",
      },
      operationName: "OpenMatterLinearIssueCreate",
      variables: {
        input: {
          teamId: "team-1",
          title: "Fix build",
          description: "CI is red",
          priority: 2,
        },
      },
      resultField: "issueCreate",
    },
    {
      operation: "issue.update",
      input: {
        organizationId: "org-1",
        issueId: "ENG-42",
        title: "Fix production build",
        stateId: "state-done",
        labelIds: ["label-1"],
      },
      operationName: "OpenMatterLinearIssueUpdate",
      variables: {
        id: "ENG-42",
        input: {
          title: "Fix production build",
          stateId: "state-done",
          labelIds: ["label-1"],
        },
      },
      resultField: "issueUpdate",
    },
    {
      operation: "issue.comment.create",
      input: {
        organizationId: "org-1",
        issueId: "ENG-42",
        parentId: "comment-root",
        body: "Investigating now",
      },
      operationName: "OpenMatterLinearCommentCreate",
      variables: {
        input: {
          issueId: "ENG-42",
          parentId: "comment-root",
          body: "Investigating now",
        },
      },
      resultField: "commentCreate",
    },
    {
      operation: "issue.comment.update",
      input: {
        organizationId: "org-1",
        commentId: "comment-1",
        body: "Investigation complete",
      },
      operationName: "OpenMatterLinearCommentUpdate",
      variables: {
        id: "comment-1",
        input: { body: "Investigation complete" },
      },
      resultField: "commentUpdate",
    },
    {
      operation: "issue.comment.delete",
      input: { organizationId: "org-1", commentId: "comment-1" },
      operationName: "OpenMatterLinearCommentDelete",
      variables: { id: "comment-1" },
      resultField: "commentDelete",
    },
    {
      operation: "project.update",
      input: {
        organizationId: "org-1",
        projectId: "project-1",
        name: "Launch 2",
        statusId: "status-started",
        targetDate: "2026-09-01",
      },
      operationName: "OpenMatterLinearProjectUpdate",
      variables: {
        id: "project-1",
        input: {
          name: "Launch 2",
          statusId: "status-started",
          targetDate: "2026-09-01",
        },
      },
      resultField: "projectUpdate",
    },
    {
      operation: "document.update",
      input: {
        organizationId: "org-1",
        documentId: "document-1",
        title: "Launch spec v2",
        content: "Ready to ship",
      },
      operationName: "OpenMatterLinearDocumentUpdate",
      variables: {
        id: "document-1",
        input: { title: "Launch spec v2", content: "Ready to ship" },
      },
      resultField: "documentUpdate",
    },
  ])("delivers finite $operation effects", async (example) => {
    const calls: Array<Record<string, unknown>> = [];
    const providerResult = {
      success: true,
      node: { id: "provider-node-1" },
    };
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer oauth-secret",
        );
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            data: { [example.resultField]: providerResult },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await Effect.runPromise(
      linear.integration.deliver({
        schemaVersion: "0.1",
        id: `effect-${example.operation}`,
        eventId: "event-1",
        integrationId: "linear",
        operation: example.operation,
        idempotencyKey: `effect-${example.operation}`,
        input: example.input,
      }),
    );

    expect(calls).toEqual([
      expect.objectContaining({
        operationName: example.operationName,
        variables: example.variables,
      }),
    ]);
    expect(result).toEqual({ providerReceipt: providerResult });
  });

  it("rejects arbitrary Linear operations before any provider request", async () => {
    let requested = false;
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      fetch: async () => {
        requested = true;
        return new Response(JSON.stringify({ data: {} }));
      },
    });

    const error = await Effect.runPromise(
      linear.integration
        .deliver({
          schemaVersion: "0.1",
          id: "effect-arbitrary",
          eventId: "event-1",
          integrationId: "linear",
          operation: "graphql.execute",
          idempotencyKey: "effect-arbitrary",
          input: { organizationId: "org-1", query: "mutation { deleteAll }" },
        })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "IntegrationError",
      retryable: false,
    });
    expect(requested).toBe(false);
  });

  it("rejects a GraphQL mutation receipt whose success flag is false", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      fetch: async () =>
        new Response(
          JSON.stringify({ data: { commentDelete: { success: false } } }),
          { headers: { "content-type": "application/json" } },
        ),
    });

    const error = await Effect.runPromise(
      linear.integration
        .deliver({
          schemaVersion: "0.1",
          id: "effect-delete-failed",
          eventId: "event-1",
          integrationId: "linear",
          operation: "issue.comment.delete",
          idempotencyKey: "effect-delete-failed",
          input: { organizationId: "org-1", commentId: "comment-1" },
        })
        .pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "IntegrationError",
      message:
        "Linear OpenMatterLinearCommentDelete reported an unsuccessful mutation",
      retryable: false,
    });
  });

  it("treats Linear RATELIMITED GraphQL errors as retryable at the reset time", async () => {
    const linear = makeLinearIntegration({
      credentials: { kind: "oauth", accessToken: "oauth-secret" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                message: "Rate limit exceeded",
                extensions: { code: "RATELIMITED" },
              },
            ],
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-requests-reset": "1787482800000",
            },
          },
        ),
    });

    const error = await Effect.runPromise(
      linear.context
        .issue({ organizationId: "org-1", issueId: "ENG-42" })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({
      _tag: "IntegrationError",
      retryable: true,
      retryAt: "2026-08-23T11:00:00.000Z",
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["invalid response", "[]"],
  ])(
    "honors a Linear reset header on an HTTP 400 %s body",
    async (_case, body) => {
      const linear = makeLinearIntegration({
        credentials: { kind: "oauth", accessToken: "oauth-secret" },
        fetch: async () =>
          new Response(body, {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-endpoint-requests-reset": "1787482800000",
            },
          }),
      });

      const error = await Effect.runPromise(
        linear.context
          .issue({ organizationId: "org-1", issueId: "ENG-42" })
          .pipe(Effect.flip),
      );

      expect(error).toMatchObject({
        _tag: "IntegrationError",
        retryable: true,
        retryAt: "2026-08-23T11:00:00.000Z",
      });
    },
  );
});
