import type { WorkIntegration } from "@openmatter/integration";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { GitHubProviderClient } from "./provider-client.js";
import { isRecord } from "./shared.js";

const segment = (value: string): string => encodeURIComponent(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const reactionTypes = new Set([
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
]);

export const makeGitHubEffectDelivery =
  (
    provider: Pick<GitHubProviderClient, "request">,
  ): WorkIntegration["deliver"] =>
  (effect) => {
    if (effect.integrationId !== "github" || !isRecord(effect.input)) {
      return Effect.fail(
        new IntegrationError({
          message: `GitHub ${effect.operation} requires a portable object input`,
          retryable: false,
        }),
      );
    }
    const { installationId, owner, repo } = effect.input;
    if (
      typeof installationId !== "string" ||
      installationId.length === 0 ||
      typeof owner !== "string" ||
      owner.length === 0 ||
      typeof repo !== "string" ||
      repo.length === 0
    ) {
      return Effect.fail(
        new IntegrationError({
          message: `GitHub ${effect.operation} requires installationId, owner, and repo`,
          retryable: false,
        }),
      );
    }
    const repositoryPath = `/repos/${segment(owner)}/${segment(repo)}`;
    const call = (
      method: "DELETE" | "PATCH" | "POST" | "PUT",
      path: string,
      body?: Readonly<Record<string, unknown>>,
    ) =>
      provider
        .request({
          installationId,
          method,
          path: `${repositoryPath}${path}`,
          ...(body === undefined ? {} : { body }),
        })
        .pipe(
          Effect.map(({ payload: providerReceipt }) => ({ providerReceipt })),
        );
    if (effect.operation === "issue.comment.create") {
      const { issueNumber, body } = effect.input;
      if (
        typeof issueNumber !== "number" ||
        !Number.isSafeInteger(issueNumber) ||
        issueNumber <= 0 ||
        typeof body !== "string" ||
        body.length === 0
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "GitHub issue.comment.create requires a positive issueNumber and non-empty body",
            retryable: false,
          }),
        );
      }
      return call("POST", `/issues/${issueNumber}/comments`, { body });
    }
    if (
      effect.operation === "issue.comment.update" ||
      effect.operation === "issue.comment.delete"
    ) {
      const { commentId, body } = effect.input;
      if (
        !positiveInteger(commentId) ||
        (effect.operation === "issue.comment.update" &&
          (typeof body !== "string" || body.length === 0))
      ) {
        return Effect.fail(
          new IntegrationError({
            message: `GitHub ${effect.operation} requires a positive commentId${
              effect.operation === "issue.comment.update"
                ? " and non-empty body"
                : ""
            }`,
            retryable: false,
          }),
        );
      }
      return effect.operation === "issue.comment.update"
        ? call("PATCH", `/issues/comments/${commentId}`, { body })
        : call("DELETE", `/issues/comments/${commentId}`);
    }
    if (effect.operation === "issue.update") {
      const {
        issueNumber,
        title,
        body,
        state,
        stateReason,
        labels,
        assignees,
        milestone,
      } = effect.input;
      if (
        !positiveInteger(issueNumber) ||
        (title !== undefined && typeof title !== "string") ||
        (body !== undefined && body !== null && typeof body !== "string") ||
        (state !== undefined && state !== "open" && state !== "closed") ||
        (stateReason !== undefined &&
          stateReason !== null &&
          stateReason !== "completed" &&
          stateReason !== "not_planned" &&
          stateReason !== "duplicate" &&
          stateReason !== "reopened") ||
        (labels !== undefined && !stringArray(labels)) ||
        (assignees !== undefined && !stringArray(assignees)) ||
        (milestone !== undefined &&
          milestone !== null &&
          !positiveInteger(milestone))
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "GitHub issue.update input is invalid",
            retryable: false,
          }),
        );
      }
      const update = {
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(state === undefined ? {} : { state }),
        ...(stateReason === undefined ? {} : { state_reason: stateReason }),
        ...(labels === undefined ? {} : { labels }),
        ...(assignees === undefined ? {} : { assignees }),
        ...(milestone === undefined ? {} : { milestone }),
      };
      if (Object.keys(update).length === 0) {
        return Effect.fail(
          new IntegrationError({
            message: "GitHub issue.update requires at least one change",
            retryable: false,
          }),
        );
      }
      return call("PATCH", `/issues/${issueNumber}`, update);
    }
    if (
      effect.operation === "issue.reaction.add" ||
      effect.operation === "issue.reaction.delete"
    ) {
      const { issueNumber, reactionId, content } = effect.input;
      if (
        !positiveInteger(issueNumber) ||
        (effect.operation === "issue.reaction.add" &&
          (typeof content !== "string" || !reactionTypes.has(content))) ||
        (effect.operation === "issue.reaction.delete" &&
          !positiveInteger(reactionId))
      ) {
        return Effect.fail(
          new IntegrationError({
            message: `GitHub ${effect.operation} input is invalid`,
            retryable: false,
          }),
        );
      }
      return effect.operation === "issue.reaction.add"
        ? call("POST", `/issues/${issueNumber}/reactions`, { content })
        : call(
            "DELETE",
            `/issues/${issueNumber}/reactions/${reactionId as number}`,
          );
    }
    if (
      effect.operation === "issue.comment.reaction.add" ||
      effect.operation === "issue.comment.reaction.delete"
    ) {
      const { commentId, reactionId, content } = effect.input;
      if (
        !positiveInteger(commentId) ||
        (effect.operation === "issue.comment.reaction.add" &&
          (typeof content !== "string" || !reactionTypes.has(content))) ||
        (effect.operation === "issue.comment.reaction.delete" &&
          !positiveInteger(reactionId))
      ) {
        return Effect.fail(
          new IntegrationError({
            message: `GitHub ${effect.operation} input is invalid`,
            retryable: false,
          }),
        );
      }
      return effect.operation === "issue.comment.reaction.add"
        ? call("POST", `/issues/comments/${commentId}/reactions`, { content })
        : call(
            "DELETE",
            `/issues/comments/${commentId}/reactions/${reactionId as number}`,
          );
    }
    if (effect.operation === "pull_request.review.create") {
      const { pullNumber, commitId, body, event, comments } = effect.input;
      const validEvent =
        event === undefined ||
        event === "APPROVE" ||
        event === "REQUEST_CHANGES" ||
        event === "COMMENT";
      const validComments =
        comments === undefined ||
        (Array.isArray(comments) &&
          comments.every(
            (comment) =>
              isRecord(comment) &&
              typeof comment.path === "string" &&
              typeof comment.body === "string" &&
              (positiveInteger(comment.position) ||
                (positiveInteger(comment.line) &&
                  (comment.side === "LEFT" || comment.side === "RIGHT"))),
          ));
      if (
        !positiveInteger(pullNumber) ||
        (commitId !== undefined && typeof commitId !== "string") ||
        (body !== undefined && typeof body !== "string") ||
        !validEvent ||
        !validComments ||
        ((event === "REQUEST_CHANGES" || event === "COMMENT") &&
          typeof body !== "string")
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "GitHub pull_request.review.create input is invalid",
            retryable: false,
          }),
        );
      }
      return call("POST", `/pulls/${pullNumber}/reviews`, {
        ...(commitId === undefined ? {} : { commit_id: commitId }),
        ...(body === undefined ? {} : { body }),
        ...(event === undefined ? {} : { event }),
        ...(comments === undefined ? {} : { comments }),
      });
    }
    if (effect.operation === "pull_request.review_comment.create") {
      const {
        pullNumber,
        commitId,
        path,
        line,
        side,
        startLine,
        startSide,
        body,
      } = effect.input;
      if (
        !positiveInteger(pullNumber) ||
        typeof commitId !== "string" ||
        commitId.length === 0 ||
        typeof path !== "string" ||
        path.length === 0 ||
        !positiveInteger(line) ||
        (side !== "LEFT" && side !== "RIGHT") ||
        (startLine !== undefined && !positiveInteger(startLine)) ||
        (startSide !== undefined &&
          startSide !== "LEFT" &&
          startSide !== "RIGHT") ||
        typeof body !== "string" ||
        body.length === 0
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "GitHub pull_request.review_comment.create input is invalid",
            retryable: false,
          }),
        );
      }
      return call("POST", `/pulls/${pullNumber}/comments`, {
        commit_id: commitId,
        path,
        line,
        side,
        ...(startLine === undefined ? {} : { start_line: startLine }),
        ...(startSide === undefined ? {} : { start_side: startSide }),
        body,
      });
    }
    if (effect.operation === "pull_request.merge") {
      const { pullNumber, sha, mergeMethod, commitTitle, commitMessage } =
        effect.input;
      if (
        !positiveInteger(pullNumber) ||
        (sha !== undefined && typeof sha !== "string") ||
        (mergeMethod !== undefined &&
          mergeMethod !== "merge" &&
          mergeMethod !== "squash" &&
          mergeMethod !== "rebase") ||
        (commitTitle !== undefined && typeof commitTitle !== "string") ||
        (commitMessage !== undefined && typeof commitMessage !== "string")
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "GitHub pull_request.merge input is invalid",
            retryable: false,
          }),
        );
      }
      return call("PUT", `/pulls/${pullNumber}/merge`, {
        ...(sha === undefined ? {} : { sha }),
        ...(mergeMethod === undefined ? {} : { merge_method: mergeMethod }),
        ...(commitTitle === undefined ? {} : { commit_title: commitTitle }),
        ...(commitMessage === undefined
          ? {}
          : { commit_message: commitMessage }),
      });
    }
    if (effect.operation === "workflow.dispatch") {
      const { workflowId, ref, inputs } = effect.input;
      const normalizedWorkflowId =
        typeof workflowId === "string" && workflowId.length > 0
          ? workflowId
          : positiveInteger(workflowId)
            ? String(workflowId)
            : undefined;
      if (
        normalizedWorkflowId === undefined ||
        typeof ref !== "string" ||
        ref.length === 0 ||
        (inputs !== undefined &&
          (!isRecord(inputs) || Object.keys(inputs).length > 25))
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "GitHub workflow.dispatch input is invalid",
            retryable: false,
          }),
        );
      }
      return call(
        "POST",
        `/actions/workflows/${segment(normalizedWorkflowId)}/dispatches`,
        { ref, ...(inputs === undefined ? {} : { inputs }) },
      );
    }
    return Effect.fail(
      new IntegrationError({
        message: `Unsupported GitHub operation: ${effect.operation}`,
        retryable: false,
      }),
    );
  };
