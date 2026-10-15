import { createHash } from "node:crypto";
import type { WorkEffect, WorkEvent } from "@openma/matter";
import { makeCredentialResolver } from "@openma/matter/credentials";
import {
  GITLAB_EVENT_TYPES,
  decodeGitLabHttpRequest,
  makeGitLabHttpEndpoint,
  makeGitLabIntegration,
  verifyGitLabToken,
  type GitLabWebhookInput,
} from "@openma/matter-gitlab/bond";
import { IntegrationError } from "@openma/matter/integration";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-23T08:00:05.000Z";
const clock = () => NOW;

const project = {
  id: 42,
  name: "api",
  path_with_namespace: "platform/api",
  web_url: "https://gitlab.example.com/platform/api",
};
const user = { id: 7, username: "alice", name: "Alice" };

const mergeRequestPayload = (attributes: Record<string, unknown> = {}) => ({
  object_kind: "merge_request",
  event_type: "merge_request",
  user,
  project,
  object_attributes: {
    id: 9001,
    iid: 7,
    title: "Add rate limits",
    state: "opened",
    action: "open",
    draft: false,
    source_branch: "feat/limits",
    target_branch: "main",
    url: "https://gitlab.example.com/platform/api/-/merge_requests/7",
    created_at: "2026-08-23 08:00:00 UTC",
    updated_at: "2026-08-23 08:00:01 UTC",
    last_commit: { id: "abc123", message: "limits" },
    ...attributes,
  },
});

const notePayload = (
  attributes: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  object_kind: "note",
  event_type: "note",
  user,
  project_id: 42,
  project,
  object_attributes: {
    id: 555,
    note: "@oma-bot can you check the retry logic?",
    noteable_type: "MergeRequest",
    discussion_id: "d1e2f3",
    system: false,
    url: "https://gitlab.example.com/platform/api/-/merge_requests/7#note_555",
    created_at: "2026-08-23T08:00:02Z",
    updated_at: "2026-08-23T08:00:02Z",
    ...attributes,
  },
  merge_request: { id: 9001, iid: 7, title: "Add rate limits", draft: false },
  ...extra,
});

const webhook = (
  payload: unknown,
  overrides: Partial<GitLabWebhookInput> = {},
): GitLabWebhookInput => ({
  kind: "gitlab.webhook",
  authority: "bond_1",
  eventName: "Merge Request Hook",
  deliveryId: "delivery-1",
  // A JSON round trip drops `undefined` fields, as a real delivery would.
  payload: JSON.parse(JSON.stringify(payload)) as GitLabWebhookInput["payload"],
  ...overrides,
});

const request = (
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request("https://openmatter.test/gitlab/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": "s3cret",
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-event-uuid": "event-uuid",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const decodeOptions = { webhookToken: "s3cret", authority: "bond_1" };

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(effect));

const ingest = async (input: unknown): Promise<readonly WorkEvent[]> =>
  Effect.runPromise(
    makeGitLabIntegration({
      credentials: { baseUrl: "https://gitlab.example.com", token: "t" },
      clock,
    }).ingest(input),
  );

describe("GitLab webhook HTTP boundary", () => {
  it("decodes a verified request and prefers the retry-stable delivery id", async () => {
    const decoded = await Effect.runPromise(
      decodeGitLabHttpRequest(
        request(mergeRequestPayload(), {
          "webhook-id": "webhook-msg",
          "idempotency-key": "idem-key",
          "x-gitlab-instance": "https://gitlab.example.com",
        }),
        decodeOptions,
      ),
    );
    expect(decoded).toEqual({
      kind: "gitlab.webhook",
      authority: "bond_1",
      eventName: "Merge Request Hook",
      deliveryId: "webhook-msg",
      instance: "https://gitlab.example.com",
      payload: mergeRequestPayload(),
    });

    const idem = await Effect.runPromise(
      decodeGitLabHttpRequest(
        request(mergeRequestPayload(), { "idempotency-key": "idem-key" }),
        decodeOptions,
      ),
    );
    expect(idem.deliveryId).toBe("idem-key");
    const legacy = await Effect.runPromise(
      decodeGitLabHttpRequest(request(mergeRequestPayload()), decodeOptions),
    );
    expect(legacy.deliveryId).toBe("event-uuid");
    expect("instance" in legacy).toBe(false);
  });

  it("rejects bad tokens with 401 and malformed requests with 400", async () => {
    const failure = async (
      req: Request,
      options = decodeOptions,
    ): Promise<{ status: number; message: string }> => {
      const result = await run(decodeGitLabHttpRequest(req, options));
      if (Either.isRight(result)) throw new Error("expected a failure");
      return { status: result.left.status, message: result.left.message };
    };
    const body = mergeRequestPayload();
    expect(await failure(request(body, { "x-gitlab-token": "wrong" }))).toEqual(
      { status: 401, message: "GitLab webhook token is invalid" },
    );
    expect(
      (await failure(request(body, { "x-gitlab-token": "" }))).status,
    ).toBe(401);
    expect(
      (
        await failure(request(body, { "x-gitlab-token": "" }), {
          webhookToken: "",
          authority: "bond_1",
        })
      ).status,
    ).toBe(401);
    expect(await failure(request(body, { "x-gitlab-event": "" }))).toEqual({
      status: 400,
      message: "GitLab event and delivery id headers are required",
    });
    expect(
      (await failure(request(body, { "x-gitlab-event-uuid": "" }))).status,
    ).toBe(400);
    expect(await failure(request("{not json"))).toEqual({
      status: 400,
      message: "GitLab request body is malformed",
    });
    expect((await failure(request([1, 2]))).message).toBe(
      "GitLab request body must be a portable JSON object",
    );
  });

  it("compares tokens by value regardless of length", async () => {
    const verify = (webhookToken: string, received: string) =>
      Effect.runPromise(verifyGitLabToken({ webhookToken, received }));
    expect(await verify("s3cret", "s3cret")).toBe(true);
    expect(await verify("s3cret", "s3cre")).toBe(false);
    expect(await verify("s3cret", "s3cret!")).toBe(false);
    expect(await verify("s3cret", "S3cret")).toBe(false);
    expect(await verify("", "")).toBe(false);

    // A token whose SHA-256 shares a prefix with the secret's must still fail,
    // so the comparison covers every byte, not just the first.
    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    const secret = digest("s3cret");
    let near = "";
    for (let index = 0; near === ""; index += 1) {
      const candidate = `candidate-${index}`;
      const hash = digest(candidate);
      if (hash[0] === secret[0] && hash[1] === secret[1]) near = candidate;
    }
    expect(await verify("s3cret", near)).toBe(false);
  });

  it("answers 202 after submitting, 401 for a bad token, and 503 when submission fails", async () => {
    const submitted: GitLabWebhookInput[] = [];
    const endpoint = makeGitLabHttpEndpoint({
      ...decodeOptions,
      submit: async (input) => {
        submitted.push(input);
      },
    });
    expect(endpoint).toMatchObject({ method: "POST", path: "/gitlab/events" });
    expect((await endpoint.handle(request(mergeRequestPayload()))).status).toBe(
      202,
    );
    expect(submitted).toHaveLength(1);
    const denied = await endpoint.handle(
      request(mergeRequestPayload(), { "x-gitlab-token": "nope" }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      ok: false,
      error: "GitLab webhook token is invalid",
    });
    expect(submitted).toHaveLength(1);

    const failing = makeGitLabHttpEndpoint({
      ...decodeOptions,
      path: "/hooks/gitlab",
      submit: async () => {
        throw new Error("queue down");
      },
    });
    expect(failing.path).toBe("/hooks/gitlab");
    expect((await failing.handle(request(mergeRequestPayload()))).status).toBe(
      503,
    );
  });
});

describe("GitLab Event normalization", () => {
  it("normalizes an opened merge request", async () => {
    const [event] = await ingest(webhook(mergeRequestPayload()));
    expect(event).toEqual({
      schemaVersion: "0.1",
      id: "gitlab:bond_1:delivery-1",
      type: "gitlab.merge_request.opened",
      occurredAt: "2026-08-23T08:00:01.000Z",
      receivedAt: NOW,
      idempotencyKey: "gitlab:bond_1:delivery-1",
      source: {
        provider: "gitlab",
        authority: "bond_1",
        conversationId: "platform/api",
        threadId: "merge_request:7",
        uri: "https://gitlab.example.com/platform/api/-/merge_requests/7",
      },
      payload: {
        activation: "observation",
        eventName: "Merge Request Hook",
        objectKind: "merge_request",
        authority: "bond_1",
        projectId: 42,
        project: "platform/api",
        resource: "project:42",
        resourceType: "merge_request",
        mergeRequestIid: 7,
        title: "Add rate limits",
        draft: false,
        state: "opened",
        sourceBranch: "feat/limits",
        targetBranch: "main",
        headSha: "abc123",
        newCommits: true,
        actor: { id: "7", username: "alice", name: "Alice" },
      },
      raw: mergeRequestPayload(),
    });
  });

  it("marks new commits only for pushes and maps every merge request action", async () => {
    const typeAndCommits = async (attributes: Record<string, unknown>) => {
      const [event] = await ingest(webhook(mergeRequestPayload(attributes)));
      const payload = event!.payload as Record<string, unknown>;
      return [event!.type, payload.newCommits];
    };
    expect(await typeAndCommits({ action: "update", oldrev: "0ld" })).toEqual([
      "gitlab.merge_request.updated",
      true,
    ]);
    expect(await typeAndCommits({ action: "update" })).toEqual([
      "gitlab.merge_request.updated",
      false,
    ]);
    expect(await typeAndCommits({ action: "reopen" })).toEqual([
      "gitlab.merge_request.reopened",
      true,
    ]);
    expect((await typeAndCommits({ action: "merge" }))[0]).toBe(
      "gitlab.merge_request.merged",
    );
    expect((await typeAndCommits({ action: "approval" }))[0]).toBe(
      "gitlab.merge_request.approval_added",
    );
    expect((await typeAndCommits({ action: "explode" }))[0]).toBe(
      "gitlab.event.received",
    );
    const [legacyDraft] = await ingest(
      webhook(
        mergeRequestPayload({ draft: undefined, work_in_progress: true }),
      ),
    );
    expect((legacyDraft!.payload as Record<string, unknown>).draft).toBe(true);
  });

  it("normalizes merge request and issue notes", async () => {
    const [created] = await ingest(
      webhook(notePayload(), { eventName: "Note Hook" }),
    );
    expect(created!.type).toBe("gitlab.merge_request.note.created");
    expect(created!.source).toEqual({
      provider: "gitlab",
      authority: "bond_1",
      conversationId: "platform/api",
      threadId: "merge_request:7",
      messageId: "note:555",
      uri: "https://gitlab.example.com/platform/api/-/merge_requests/7#note_555",
    });
    expect(created!.payload).toMatchObject({
      resource: "project:42",
      resourceType: "note",
      noteId: 555,
      text: "@oma-bot can you check the retry logic?",
      discussionId: "d1e2f3",
      noteableType: "MergeRequest",
      mergeRequestIid: 7,
      draft: false,
      system: false,
    });

    const [updated] = await ingest(webhook(notePayload({ action: "update" })));
    expect(updated!.type).toBe("gitlab.merge_request.note.updated");

    const [issueNote] = await ingest(
      webhook(
        notePayload(
          { noteable_type: "Issue" },
          { merge_request: undefined, issue: { iid: 3 } },
        ),
      ),
    );
    expect(issueNote!.type).toBe("gitlab.issue.note.created");
    expect(issueNote!.source.threadId).toBe("issue:3");
    expect(issueNote!.payload).toMatchObject({ issueIid: 3 });
    expect(issueNote!.payload).not.toHaveProperty("mergeRequestIid");
  });

  it("puts a merge request pipeline on the merge request thread", async () => {
    const pipeline = (status: string, mergeRequest?: unknown) => ({
      object_kind: "pipeline",
      user,
      project,
      object_attributes: {
        id: 77,
        status,
        ref: "feat/limits",
        sha: "abc123",
        created_at: "2026-08-23 08:00:00 UTC",
        finished_at: "2026-08-23 08:04:00 UTC",
      },
      ...(mergeRequest === undefined ? {} : { merge_request: mergeRequest }),
    });
    const [onMr] = await ingest(webhook(pipeline("success", { iid: 7 })));
    expect(onMr!.type).toBe("gitlab.pipeline.success");
    expect(onMr!.occurredAt).toBe("2026-08-23T08:04:00.000Z");
    expect(onMr!.source.threadId).toBe("merge_request:7");
    expect(onMr!.source.messageId).toBe("pipeline:77:success");
    expect(onMr!.payload).toMatchObject({
      resourceType: "pipeline",
      pipelineId: 77,
      status: "success",
      mergeRequestIid: 7,
    });
    const [branch] = await ingest(webhook(pipeline("failed")));
    expect(branch!.source.threadId).toBe("pipeline:77");
    const [odd] = await ingest(webhook(pipeline("exploded")));
    expect(odd!.type).toBe("gitlab.event.received");
  });

  it("ignores other inputs, strips credentials from raw, and keys Events by authority", async () => {
    expect(await ingest({ kind: "github.webhook" })).toEqual([]);
    expect(await ingest(webhook([] as unknown))).toEqual([]);
    expect(
      await ingest({ ...webhook(mergeRequestPayload()), authority: "" }),
    ).toEqual([]);

    const [push] = await ingest(
      webhook({
        object_kind: "push",
        project,
        token: "leak",
        nested: { private_token: "leak", keep: 1 },
      }),
    );
    expect(push!.type).toBe("gitlab.event.received");
    expect(push!.raw).toEqual({
      object_kind: "push",
      project,
      nested: { keep: 1 },
    });

    const [a] = await ingest(webhook(mergeRequestPayload()));
    const [b] = await ingest(webhook(mergeRequestPayload()));
    const [c] = await ingest(
      webhook(mergeRequestPayload(), { authority: "bond_2" }),
    );
    expect(a!.id).toBe(b!.id);
    expect(c!.id).not.toBe(a!.id);
  });

  it("lists every produced Event type in the manifest", async () => {
    const integration = makeGitLabIntegration({
      credentials: { baseUrl: "https://gitlab.example.com", token: "t" },
    });
    expect(integration.manifest.events).toBe(GITLAB_EVENT_TYPES);
    expect(new Set(GITLAB_EVENT_TYPES).size).toBe(GITLAB_EVENT_TYPES.length);
    const produced = [
      ...(await ingest(webhook(mergeRequestPayload()))),
      ...(await ingest(webhook(notePayload()))),
      ...(await ingest(webhook({ object_kind: "push" }))),
    ].map((event) => event.type);
    for (const type of produced) expect(GITLAB_EVENT_TYPES).toContain(type);
  });
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const fakeFetch = (
  respond: (call: Call) => Response | Promise<Response> = () =>
    Response.json({ id: 999 }, { status: 201 }),
) => {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const effect = (operation: string, input: unknown): WorkEffect =>
  ({
    schemaVersion: "0.1",
    id: "effect-1",
    eventId: "event-1",
    integrationId: "gitlab",
    operation,
    idempotencyKey: "effect-1",
    input,
  }) as WorkEffect;

const noteInput = {
  authority: "bond_1",
  projectId: 42,
  mergeRequestIid: 7,
  body: "Looks good",
};

describe("GitLab Effect delivery", () => {
  it("posts merge request notes and discussion replies", async () => {
    const { fetch, calls } = fakeFetch();
    const integration = makeGitLabIntegration({
      credentials: { baseUrl: "https://gitlab.example.com", token: "glpat-x" },
      fetch,
      clock,
    });
    const note = await Effect.runPromise(
      integration.deliver(effect("merge_request.note.create", noteInput)),
    );
    expect(note).toEqual({ providerReceipt: { noteId: 999 } });
    const reply = await Effect.runPromise(
      integration.deliver(
        effect("merge_request.discussion.reply", {
          ...noteInput,
          projectId: "platform/api",
          discussionId: "d1e2f3",
        }),
      ),
    );
    expect(reply).toEqual({
      providerReceipt: { noteId: 999, discussionId: "d1e2f3" },
    });
    await Effect.runPromise(
      integration.deliver(
        effect("issue.note.create", {
          authority: "bond_1",
          projectId: 42,
          issueIid: 3,
          body: "Noted",
        }),
      ),
    );

    expect(calls).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes",
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer glpat-x",
          "content-type": "application/json; charset=utf-8",
        },
        body: { body: "Looks good" },
      },
      expect.objectContaining({
        url: "https://gitlab.example.com/api/v4/projects/platform%2Fapi/merge_requests/7/discussions/d1e2f3/notes",
        body: { body: "Looks good" },
      }),
      expect.objectContaining({
        url: "https://gitlab.example.com/api/v4/projects/42/issues/3/notes",
        body: { body: "Noted" },
      }),
    ]);
    expect(integration.manifest.operations).toEqual([
      "merge_request.note.create",
      "merge_request.discussion.reply",
      "issue.note.create",
      "issue.discussion.reply",
    ]);
  });

  it("refuses incomplete inputs and unknown operations without calling GitLab", async () => {
    const { fetch, calls } = fakeFetch();
    const integration = makeGitLabIntegration({
      credentials: { baseUrl: "https://gitlab.example.com", token: "t" },
      fetch,
    });
    const refused = async (operation: string, input: unknown) => {
      const result = await run(integration.deliver(effect(operation, input)));
      if (Either.isRight(result)) throw new Error("expected a failure");
      expect(result.left).toBeInstanceOf(IntegrationError);
      expect(result.left.retryable).toBe(false);
      return result.left.message;
    };
    expect(
      await refused("merge_request.discussion.reply", noteInput),
    ).toContain("discussionId");
    expect(
      await refused("merge_request.note.create", { ...noteInput, body: "" }),
    ).toContain("non-empty body");
    expect(
      await refused("merge_request.note.create", {
        ...noteInput,
        mergeRequestIid: 0,
      }),
    ).toContain("positive mergeRequestIid");
    expect(await refused("issue.note.create", noteInput)).toContain(
      "positive issueIid",
    );
    expect(
      await refused("merge_request.note.create", {
        ...noteInput,
        authority: "",
      }),
    ).toContain("authority");
    expect(await refused("merge_request.merge", noteInput)).toBe(
      "GitLab does not support the operation merge_request.merge",
    );
    expect(await refused("merge_request.note.create", "text")).toContain(
      "object input",
    );
    expect(calls).toEqual([]);
  });

  it("classifies GitLab failures as retryable or not", async () => {
    const failureFor = async (respond: () => Response | Promise<Response>) => {
      const integration = makeGitLabIntegration({
        credentials: { baseUrl: "https://gitlab.example.com", token: "t" },
        fetch: fakeFetch(respond).fetch,
        clock,
      });
      const result = await run(
        integration.deliver(effect("merge_request.note.create", noteInput)),
      );
      if (Either.isRight(result)) throw new Error("expected a failure");
      return result.left;
    };
    const limited = await failureFor(
      () =>
        new Response(JSON.stringify({ message: "429 Too Many Requests" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    expect(limited).toMatchObject({
      retryable: true,
      retryAt: "2026-08-23T08:00:35.000Z",
      message:
        "GitLab POST /projects/42/merge_requests/7/notes failed with HTTP 429",
    });
    const reset = await failureFor(
      () =>
        new Response("", {
          status: 429,
          headers: { "ratelimit-reset": "1787472000" },
        }),
    );
    expect(reset.retryAt).toBe(new Date(1787472000 * 1000).toISOString());
    expect(
      (
        await failureFor(
          () => new Response("<html>bad gateway</html>", { status: 502 }),
        )
      ).retryable,
    ).toBe(true);
    const forbidden = await failureFor(() =>
      Response.json({ message: "403 Forbidden" }, { status: 403 }),
    );
    expect(forbidden.retryable).toBe(false);
    expect(forbidden.retryAt).toBeUndefined();
    expect(
      (
        await failureFor(() => {
          throw new TypeError("network down");
        })
      ).retryable,
    ).toBe(true);
  });

  it("resolves the instance and token per authority", async () => {
    const { fetch, calls } = fakeFetch();
    const requests: unknown[] = [];
    const integration = makeGitLabIntegration({
      credentials: makeCredentialResolver((request) => {
        requests.push(request);
        return request.authority === "bond_1"
          ? { baseUrl: "https://gitlab.example.com", token: "one" }
          : { baseUrl: "https://code.example.org/gitlab", token: "two" };
      }),
      fetch,
    });
    await Effect.runPromise(
      integration.deliver(effect("merge_request.note.create", noteInput)),
    );
    await Effect.runPromise(
      integration.deliver(
        effect("merge_request.note.create", {
          ...noteInput,
          authority: "bond_2",
        }),
      ),
    );
    expect(requests).toEqual([
      { integrationId: "gitlab", authority: "bond_1" },
      { integrationId: "gitlab", authority: "bond_2" },
    ]);
    expect(calls.map((call) => [call.url, call.headers.authorization])).toEqual(
      [
        [
          "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes",
          "Bearer one",
        ],
        [
          "https://code.example.org/gitlab/api/v4/projects/42/merge_requests/7/notes",
          "Bearer two",
        ],
      ],
    );

    const failing = makeGitLabIntegration({
      credentials: (authority) => {
        throw new Error(`no Bond for ${authority}`);
      },
      fetch,
    });
    const failed = await run(
      failing.deliver(effect("merge_request.note.create", noteInput)),
    );
    expect(Either.isLeft(failed)).toBe(true);

    const invalid = makeGitLabIntegration({
      credentials: { baseUrl: "ftp://gitlab.example.com", token: "t" },
      fetch,
    });
    const rejected = await run(
      invalid.deliver(effect("merge_request.note.create", noteInput)),
    );
    expect(Either.isLeft(rejected) && rejected.left.message).toBe(
      "GitLab baseUrl must use http or https",
    );
    expect(calls).toHaveLength(2);
  });
});
