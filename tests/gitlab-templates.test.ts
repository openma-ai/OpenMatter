import { readFileSync } from "node:fs";
import type { ContextProjection } from "@openma/matter";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import {
  decodeGitLabHttpRequest,
  gitlabMention,
  gitlabMergeRequestReview,
  gitlabTemplates,
  makeGitLabIntegration,
} from "@openma/matter-gitlab/bond";
import { isGuestLoop, loopConfigSchemaProblems } from "@openma/matter-loop";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const project = { id: 42, path_with_namespace: "platform/api" };

const mergeRequest = (attributes: Record<string, unknown> = {}) => ({
  object_kind: "merge_request",
  user: { id: 7, username: "alice", name: "Alice" },
  project,
  object_attributes: {
    iid: 7,
    action: "open",
    draft: false,
    title: "Add rate limits",
    url: "https://gitlab.example.com/platform/api/-/merge_requests/7",
    updated_at: "2026-08-23T08:00:01Z",
    ...attributes,
  },
});

const note = (
  text: string,
  options: {
    readonly author?: string;
    readonly system?: boolean;
    readonly discussionId?: string;
  } = {},
) => ({
  object_kind: "note",
  user: { id: 8, username: options.author ?? "bob" },
  project,
  object_attributes: {
    id: 555,
    note: text,
    noteable_type: "MergeRequest",
    system: options.system ?? false,
    ...(options.discussionId === undefined
      ? {}
      : { discussion_id: options.discussionId }),
    created_at: "2026-08-23T08:00:02Z",
  },
  merge_request: { iid: 7, draft: false },
});

let delivery = 0;
const webhookRequest = (payload: unknown, eventName: string): Request =>
  new Request("https://openmatter.test/gitlab/events", {
    method: "POST",
    headers: {
      "x-gitlab-token": "s3cret",
      "x-gitlab-event": eventName,
      "webhook-id": `delivery-${(delivery += 1)}`,
    },
    body: JSON.stringify(payload),
  });

const makeHarness = (
  agentOutput = "Looks good. One question about retries.",
) => {
  const posted: { url: string; body: unknown }[] = [];
  const contexts: ContextProjection[] = [];
  const worker = makeMockAgentDriver({ id: "worker", output: agentOutput });
  const driver = {
    ...worker.driver,
    turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
      contexts.push(input.context);
      return worker.driver.turn(input);
    },
  };
  const gitlab = makeGitLabIntegration({
    credentials: { baseUrl: "https://gitlab.example.com", token: "app-token" },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: 1000 + posted.length }, { status: 201 });
    }) as typeof globalThis.fetch,
  });
  const app = createOpenMatter({
    store: makeMemoryStore(),
    integrations: { gitlab },
    agents: { worker: driver },
  });
  const send = async (payload: unknown, eventName: string) => {
    const input = await Effect.runPromise(
      decodeGitLabHttpRequest(webhookRequest(payload, eventName), {
        webhookToken: "s3cret",
        authority: "bond_1",
      }),
    );
    const [receipt] = await app.acceptFrom("gitlab", input);
    return receipt!;
  };
  return { app, send, posted, contexts };
};

const reviewConfig = { agentId: "worker", projects: ["project:42"] };
const mentionConfig = { ...reviewConfig, username: "oma-bot" };

describe("GitLab Loop templates", () => {
  it("ship portable definitions that run as the app principal", () => {
    expect(gitlabTemplates.map((loop) => loop.definition.id)).toEqual([
      "gitlab-mr-review",
      "gitlab-mention",
    ]);
    for (const loop of gitlabTemplates) {
      expect(isGuestLoop(loop)).toBe(true);
      expect(Object.isFrozen(loop.definition)).toBe(true);
      expect(JSON.parse(JSON.stringify(loop.definition))).toEqual(
        loop.definition,
      );
      expect(loopConfigSchemaProblems(loop.definition.configSchema!)).toEqual(
        [],
      );
      expect(loop.definition.runAs).toBe("app");
      expect(loop.definition.requiredBonds).toEqual([
        { provider: "gitlab", operations: ["fetch", "comment_mr"] },
      ]);
      expect(loop.definition.configSchema!.properties.projects).toMatchObject({
        "x-oma-widget": "bond-resources",
        "x-bond-provider": "gitlab",
      });
    }
    const source = readFileSync(
      new URL(
        "../packages/gitlab/src/bond/integration/templates.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["@openma/matter-loop"]);
  });

  it("reviews an opened merge request and posts the review as a note", async () => {
    const { app, send, posted, contexts } = makeHarness();
    app.loop(gitlabMergeRequestReview, reviewConfig);

    const receipt = await send(mergeRequest(), "Merge Request Hook");

    expect(receipt.reaction.status).toBe("completed");
    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        integrationId: "gitlab",
        operation: "merge_request.note.create",
        status: "delivered",
      }),
    ]);
    expect(posted).toEqual([
      {
        url: "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes",
        body: { body: "Looks good. One question about retries." },
      },
    ]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      scopeId: "gitlab:bond_1:project:42",
      workThreadId: "merge_request:7",
      grants: ["gitlab.merge_request.note.create"],
    });
    const instructions = contexts[0]!.items.find(
      (item) => item.kind === "instructions",
    );
    expect(String(instructions?.value)).toContain(
      "Review merge request !7 in platform/api",
    );
  });

  it("skips edits without commits, drafts, and unwatched projects", async () => {
    const { app, send, posted } = makeHarness();
    app.loop(gitlabMergeRequestReview, {
      ...reviewConfig,
      instructions: "Focus on SQL.",
    });

    const reasons = [];
    reasons.push(
      (await send(mergeRequest({ action: "update" }), "Merge Request Hook"))
        .reaction.reason,
    );
    reasons.push(
      (await send(mergeRequest({ draft: true }), "Merge Request Hook")).reaction
        .reason,
    );
    reasons.push(
      (
        await send(
          {
            ...mergeRequest(),
            project: { id: 99, path_with_namespace: "x/y" },
          },
          "Merge Request Hook",
        )
      ).reaction.reason,
    );
    expect(reasons).toEqual([
      "No new commits",
      "Draft merge request",
      "Project is not watched",
    ]);
    expect(posted).toEqual([]);

    await send(
      mergeRequest({ action: "update", oldrev: "0ld" }),
      "Merge Request Hook",
    );
    expect(posted).toHaveLength(1);
  });

  it("reviews drafts when skipDrafts is false and carries extra instructions", async () => {
    const { app, send, posted, contexts } = makeHarness();
    app.loop(gitlabMergeRequestReview, {
      ...reviewConfig,
      skipDrafts: false,
      instructions: "  Focus on SQL.  ",
    });
    await send(mergeRequest({ draft: true }), "Merge Request Hook");
    expect(posted).toHaveLength(1);
    const instructions = contexts[0]!.items.find(
      (item) => item.kind === "instructions",
    );
    expect(String(instructions?.value)).toMatch(/\n\nFocus on SQL\.$/);
  });

  it("posts nothing when the Agent produces no output", async () => {
    const { app, send, posted } = makeHarness("   ");
    app.loop(gitlabMergeRequestReview, reviewConfig);
    const receipt = await send(mergeRequest(), "Merge Request Hook");
    expect(receipt.reaction.reason).toBe("The Agent produced no reply");
    expect(posted).toEqual([]);
  });

  it("refuses a configuration without projects", () => {
    const { app } = makeHarness();
    expect(() =>
      app.loop(gitlabMergeRequestReview, { agentId: "worker", projects: [] }),
    ).toThrow("Invalid configuration for Loop gitlab-mr-review");
    expect(() => app.loop(gitlabMention, reviewConfig)).toThrow(
      "Invalid configuration for Loop gitlab-mention",
    );
  });

  it("answers a mention in the same discussion and shares the review's Session", async () => {
    const { app, send, posted, contexts } = makeHarness("Retries back off.");
    app.loop(gitlabMergeRequestReview, reviewConfig);
    app.loop(gitlabMention, { ...mentionConfig, username: "@oma-bot" });

    await send(mergeRequest(), "Merge Request Hook");
    const receipt = await send(
      note("@OMA-bot how do retries work?", { discussionId: "d1e2f3" }),
      "Note Hook",
    );

    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        operation: "merge_request.discussion.reply",
        status: "delivered",
      }),
    ]);
    expect(posted[1]).toEqual({
      url: "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/discussions/d1e2f3/notes",
      body: { body: "Retries back off." },
    });
    expect(contexts.map((context) => context.workThreadId)).toEqual([
      "merge_request:7",
      "merge_request:7",
    ]);
    expect(contexts[1]!.grants).toEqual([
      "gitlab.merge_request.discussion.reply",
    ]);
  });

  it("falls back to a new note when the comment has no discussion", async () => {
    const { app, send, posted } = makeHarness();
    app.loop(gitlabMention, mentionConfig);
    await send(note("ping @oma-bot"), "Note Hook");
    expect(posted.map((call) => call.url)).toEqual([
      "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes",
    ]);
  });

  it("ignores its own notes, system notes, and near-miss mentions", async () => {
    const { app, send, posted } = makeHarness();
    app.loop(gitlabMention, mentionConfig);
    const reason = async (payload: unknown) =>
      (await send(payload, "Note Hook")).reaction.reason;

    expect(await reason(note("@oma-bot again", { author: "OMA-bot" }))).toBe(
      "The Agent's own note",
    );
    expect(await reason(note("@oma-bot assigned", { system: true }))).toBe(
      "System note",
    );
    expect(await reason(note("@oma-bot2 please look"))).toBe(
      "The Agent is not mentioned",
    );
    expect(await reason(note("mail ops@oma-bot.example"))).toBe(
      "The Agent is not mentioned",
    );
    expect(await reason(note("no mention here"))).toBe(
      "The Agent is not mentioned",
    );
    expect(posted).toEqual([]);
  });
});
