import {
  IntegrationError,
  type WorkIntegration,
} from "@openma/matter/integration";
import { Effect } from "effect";
import type { GitLabClient } from "./client.js";
import { isRecord, nonEmptyString, positiveInteger } from "./shared.js";

/** Every Effect operation `deliver` accepts. */
export const GITLAB_OPERATIONS = [
  "merge_request.note.create",
  "merge_request.discussion.reply",
  "issue.note.create",
  "issue.discussion.reply",
] as const;

export type GitLabEffectOperation = (typeof GITLAB_OPERATIONS)[number];

const fail = (message: string) =>
  Effect.fail(new IntegrationError({ message, retryable: false }));

/**
 * Delivers GitLab Effects. Every input names the `authority` whose
 * credentials post the note, the `projectId` (numeric id or full path), the
 * merge request or issue `iid`, and a non-empty `body`. Discussion replies
 * also name the `discussionId`; replying to a single comment turns it into a
 * thread.
 */
export const makeGitLabDelivery =
  (client: Pick<GitLabClient, "request">): WorkIntegration["deliver"] =>
  (effect) => {
    const operation = GITLAB_OPERATIONS.find(
      (name) => name === effect.operation,
    );
    if (effect.integrationId !== "gitlab" || operation === undefined) {
      return fail(`GitLab does not support the operation ${effect.operation}`);
    }
    if (!isRecord(effect.input)) {
      return fail(`GitLab ${operation} requires an object input`);
    }
    const { authority, projectId, body, discussionId } = effect.input;
    const [parent, iidKey] = operation.startsWith("merge_request.")
      ? (["merge_requests", "mergeRequestIid"] as const)
      : (["issues", "issueIid"] as const);
    const iid = effect.input[iidKey];
    const replying = operation.endsWith(".discussion.reply");
    if (
      !nonEmptyString(authority) ||
      !(positiveInteger(projectId) || nonEmptyString(projectId)) ||
      !positiveInteger(iid) ||
      !nonEmptyString(body) ||
      (replying && !nonEmptyString(discussionId))
    ) {
      return fail(
        `GitLab ${operation} requires authority, projectId, a positive ${iidKey}, ${
          replying ? "discussionId, " : ""
        }and a non-empty body`,
      );
    }
    const base = `/projects/${encodeURIComponent(String(projectId))}/${parent}/${iid}`;
    const path = replying
      ? `${base}/discussions/${encodeURIComponent(discussionId as string)}/notes`
      : `${base}/notes`;
    return client
      .request({ authority, method: "POST", path, body: { body } })
      .pipe(
        Effect.map(({ payload }) => ({
          providerReceipt: isRecord(payload)
            ? {
                ...(positiveInteger(payload.id) ? { noteId: payload.id } : {}),
                ...(nonEmptyString(discussionId) ? { discussionId } : {}),
              }
            : null,
        })),
      );
  };
