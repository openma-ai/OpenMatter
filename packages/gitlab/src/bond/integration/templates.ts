// The GitLab Loop templates. They are guest Loops: they import only
// `@openma/matter-loop`, so a host can run them in process or in an isolate, and
// their definitions are JSON a console can render as a form.
//
// GitLab webhooks are unattended, so both templates run as the Bond's app
// principal (`runAs: "app"`); a host enables them only when one is
// configured. See docs/LOOPS.md, "Execution principal".

import {
  defineLoop,
  sessionBinding,
  sessionScopeField,
  type JsonValue,
  type LoopConfig,
  type LoopWork,
  type ReactionDraft,
  type WorkEvent,
} from "@openma/matter-loop";

const VERSION = "0.1.0";

const agentField = {
  type: "string",
  minLength: 1,
  title: "Agent",
  "x-oma-widget": "agent",
} as const;

const projectsField = {
  type: "array",
  items: { type: "string", minLength: 1 },
  minItems: 1,
  title: "Projects",
  description: "Bond resource ids of the projects the Loop watches",
  "x-oma-widget": "bond-resources",
  "x-bond-provider": "gitlab",
} as const;

const instructionsField = {
  type: "string",
  default: "",
  title: "Extra instructions",
  description: "Appended to the instructions the Agent receives",
} as const;

type Fields = { readonly [key: string]: JsonValue };

// `Array.isArray` does not narrow readonly arrays out of a union.
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fields = (event: WorkEvent): Fields =>
  isObject(event.payload) ? event.payload : {};

const watched = (config: LoopConfig, event: WorkEvent): boolean => {
  const resource = fields(event).resource;
  return (
    typeof resource === "string" &&
    Array.isArray(config.projects) &&
    config.projects.includes(resource)
  );
};

interface MergeRequestTarget {
  readonly authority: string;
  readonly projectId: number;
  readonly mergeRequestIid: number;
}

const mergeRequestTarget = (
  event: WorkEvent,
): MergeRequestTarget | undefined => {
  const { projectId, mergeRequestIid } = fields(event);
  return typeof projectId === "number" && typeof mergeRequestIid === "number"
    ? { authority: event.source.authority, projectId, mergeRequestIid }
    : undefined;
};

/**
 * By default one Session per merge request: both templates continue the same
 * Work Thread, so an Agent that reviewed a merge request remembers it when
 * mentioned there later. `request` starts a fresh Session for each Event.
 */
const sessionFor = (target: MergeRequestTarget, work: LoopWork) =>
  sessionBinding(work.config.sessionScope, {
    scopeId: `gitlab:${target.authority}:project:${target.projectId}`,
    default: "work-item",
    threads: {
      "work-item": `merge_request:${target.mergeRequestIid}`,
      request: `request:${work.event.id}`,
    },
  });

/** The session scope both templates offer. */
const sessionScope = sessionScopeField({
  scopes: ["work-item", "request"],
  describe: { "work-item": "work-item: one Session per merge request" },
});

/** Runs one Agent Turn and posts its output as a merge request note. */
const answer = async (
  work: LoopWork,
  target: MergeRequestTarget,
  instructions: string,
  reply:
    | { readonly operation: "merge_request.note.create" }
    | {
        readonly operation: "merge_request.discussion.reply";
        readonly discussionId: string;
      },
): Promise<ReactionDraft> => {
  const binding = sessionFor(target, work);
  const capability = `gitlab.${reply.operation}`;
  const context = await work.context.project({
    scopeId: binding.scopeId,
    workThreadId: binding.workThreadId,
    items: [
      work.context.event(),
      work.context.value({
        kind: "instructions",
        value: instructions,
        provenance: [{ sourceType: "loop-template", sourceId: "gitlab" }],
      }),
    ],
    grants: [capability],
  });
  const turn = await work
    .agent(String(work.config.agentId))
    .session(binding)
    .turn({ context, allow: [capability] });
  const body = typeof turn.output === "string" ? turn.output.trim() : "";
  if (turn.outcome !== "completed" || body.length === 0) {
    return work.react.none(
      turn.outcome === "completed"
        ? "The Agent produced no reply"
        : `The Agent Turn ended ${turn.outcome}`,
    );
  }
  const note = await work.effect(context, {
    integrationId: "gitlab",
    operation: reply.operation,
    input: {
      authority: target.authority,
      projectId: target.projectId,
      mergeRequestIid: target.mergeRequestIid,
      body,
      ...(reply.operation === "merge_request.discussion.reply"
        ? { discussionId: reply.discussionId }
        : {}),
    },
  });
  return work.react.effects([note]);
};

const extra = (config: LoopConfig): string =>
  typeof config.instructions === "string" && config.instructions.trim() !== ""
    ? `\n\n${config.instructions.trim()}`
    : "";

/**
 * Reviews a merge request when it opens, reopens, or receives new commits,
 * and posts the review as a note. Title or label edits do not trigger a
 * review. Draft merge requests are skipped unless `skipDrafts` is false.
 */
export const gitlabMergeRequestReview = defineLoop(
  {
    id: "gitlab-mr-review",
    version: VERSION,
    description: "Review merge requests when they open or receive new commits",
    spec: {
      sources: [
        "gitlab.merge_request.opened",
        "gitlab.merge_request.reopened",
        "gitlab.merge_request.updated",
      ],
      workThread: "gitlab.merge_request",
      session: "per-work-thread",
      reaction: "effects",
    },
    runAs: "app",
    requiredBonds: [
      { provider: "gitlab", operations: ["fetch", "comment_mr"] },
    ],
    configSchema: {
      type: "object",
      properties: {
        agentId: agentField,
        projects: projectsField,
        skipDrafts: {
          type: "boolean",
          default: true,
          title: "Skip draft merge requests",
        },
        sessionScope,
        instructions: instructionsField,
      },
      required: ["agentId", "projects"],
    },
  },
  (app) =>
    app.on(
      [
        "gitlab.merge_request.opened",
        "gitlab.merge_request.reopened",
        "gitlab.merge_request.updated",
      ],
      (work) => {
        const target = mergeRequestTarget(work.event);
        const { draft, newCommits, project } = fields(work.event);
        if (target === undefined) {
          return work.react.none("Not a merge request Event");
        }
        if (!watched(work.config, work.event)) {
          return work.react.none("Project is not watched");
        }
        if (newCommits !== true) {
          return work.react.none("No new commits");
        }
        if (draft === true && work.config.skipDrafts !== false) {
          return work.react.none("Draft merge request");
        }
        return answer(
          work,
          target,
          `Review merge request !${target.mergeRequestIid} in ${String(
            project ?? target.projectId,
          )}. Fetch the source branch through the GitLab Bond, read the diff ` +
            "against the target branch, and reply with a concise review: " +
            "correctness problems first, then risks, then optional " +
            "suggestions. Your reply is posted as a merge request note." +
            extra(work.config),
          { operation: "merge_request.note.create" },
        );
      },
    ),
);

const mentionPattern = (username: string): RegExp =>
  new RegExp(
    `(^|[^\\w@.-])@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`,
    "i",
  );

/**
 * Answers a merge request comment that mentions the Agent's GitLab user, in
 * the same thread. System notes and the Agent's own notes are ignored, so a
 * reply never triggers another reply.
 */
export const gitlabMention = defineLoop(
  {
    id: "gitlab-mention",
    version: VERSION,
    description: "Answer merge request comments that mention the Agent",
    spec: {
      sources: ["gitlab.merge_request.note.created"],
      workThread: "gitlab.merge_request",
      session: "per-work-thread",
      reaction: "effects",
    },
    runAs: "app",
    requiredBonds: [
      { provider: "gitlab", operations: ["fetch", "comment_mr"] },
    ],
    configSchema: {
      type: "object",
      properties: {
        agentId: agentField,
        projects: projectsField,
        username: {
          type: "string",
          minLength: 1,
          title: "GitLab username",
          description:
            "The app principal's username, without @. Comments that mention it are answered.",
        },
        sessionScope,
        instructions: instructionsField,
      },
      required: ["agentId", "projects", "username"],
    },
  },
  (app, { config }) => {
    const username = String(config.username).replace(/^@/, "");
    const mentions = mentionPattern(username);
    app.on("gitlab.merge_request.note.created", (work) => {
      const target = mergeRequestTarget(work.event);
      const { text, system, discussionId, actor } = fields(work.event);
      const author = isObject(actor) ? actor.username : undefined;
      if (target === undefined) {
        return work.react.none("Not a merge request comment");
      }
      if (!watched(work.config, work.event)) {
        return work.react.none("Project is not watched");
      }
      if (system === true) return work.react.none("System note");
      if (
        typeof author === "string" &&
        author.toLowerCase() === username.toLowerCase()
      ) {
        return work.react.none("The Agent's own note");
      }
      if (typeof text !== "string" || !mentions.test(text)) {
        return work.react.none("The Agent is not mentioned");
      }
      return answer(
        work,
        target,
        `@${String(author ?? "someone")} mentioned you (@${username}) in a ` +
          `comment on merge request !${target.mergeRequestIid}. Answer the ` +
          "comment. Fetch the code through the GitLab Bond if you need it. " +
          "Your reply is posted in the same thread." +
          extra(work.config),
        typeof discussionId === "string" && discussionId.length > 0
          ? { operation: "merge_request.discussion.reply", discussionId }
          : { operation: "merge_request.note.create" },
      );
    });
  },
);

/** The GitLab templates, in the order a console lists them. */
export const gitlabTemplates = [
  gitlabMergeRequestReview,
  gitlabMention,
] as const;
