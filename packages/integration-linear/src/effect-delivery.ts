import type { JsonValue, WorkEffect } from "@openmatter/core";
import type { ProviderDeliveryResult } from "@openmatter/integration";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { LinearProviderClient } from "./provider-client.js";

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ISSUE_CREATE = `mutation OpenMatterLinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title url } }
}`;
const ISSUE_UPDATE = `mutation OpenMatterLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier title url } }
}`;
const COMMENT_CREATE = `mutation OpenMatterLinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body url } }
}`;
const COMMENT_UPDATE = `mutation OpenMatterLinearCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { id body url } }
}`;
const COMMENT_DELETE = `mutation OpenMatterLinearCommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;
const PROJECT_UPDATE = `mutation OpenMatterLinearProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) { success project { id name url } }
}`;
const DOCUMENT_UPDATE = `mutation OpenMatterLinearDocumentUpdate($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) { success document { id title url } }
}`;

const issueCreateFields = [
  "teamId",
  "title",
  "description",
  "assigneeId",
  "parentId",
  "priority",
  "estimate",
  "labelIds",
  "cycleId",
  "projectId",
  "stateId",
  "dueDate",
] as const;
const issueUpdateFields = [
  "title",
  "description",
  "assigneeId",
  "parentId",
  "priority",
  "estimate",
  "labelIds",
  "addedLabelIds",
  "removedLabelIds",
  "teamId",
  "cycleId",
  "projectId",
  "stateId",
  "dueDate",
] as const;
const projectUpdateFields = [
  "statusId",
  "name",
  "description",
  "content",
  "icon",
  "color",
  "teamIds",
  "leadId",
  "memberIds",
  "startDate",
  "targetDate",
  "priority",
  "labelIds",
] as const;
const documentUpdateFields = [
  "title",
  "icon",
  "color",
  "content",
  "projectId",
  "initiativeId",
  "teamId",
  "issueId",
  "ownerId",
] as const;

const pick = (
  input: Record<string, JsonValue>,
  fields: readonly string[],
): Record<string, JsonValue> => {
  const result: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = input[field];
    if (value !== undefined) result[field] = structuredClone(value);
  }
  return result;
};

const requiredString = (
  input: Record<string, JsonValue>,
  field: string,
  operation: string,
): Effect.Effect<string, IntegrationError> => {
  const value = input[field];
  return typeof value === "string" && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new IntegrationError({
          message: `Linear ${operation} requires ${field}`,
          retryable: false,
        }),
      );
};

const requireChanges = (
  changes: Record<string, JsonValue>,
  operation: string,
): Effect.Effect<Record<string, JsonValue>, IntegrationError> =>
  Object.keys(changes).length > 0
    ? Effect.succeed(changes)
    : Effect.fail(
        new IntegrationError({
          message: `Linear ${operation} requires at least one supported change`,
          retryable: false,
        }),
      );

export const makeLinearEffectDelivery =
  (
    provider: LinearProviderClient,
  ): ((
    effect: WorkEffect,
  ) => Effect.Effect<ProviderDeliveryResult, IntegrationError>) =>
  (effect) => {
    if (effect.integrationId !== "linear" || !isRecord(effect.input)) {
      return Effect.fail(
        new IntegrationError({
          message: `Linear ${effect.operation} effect is invalid`,
          retryable: false,
        }),
      );
    }
    const input = effect.input;
    return requiredString(input, "organizationId", effect.operation).pipe(
      Effect.flatMap((organizationId) => {
        const execute = (
          operationName: string,
          query: string,
          variables: Record<string, JsonValue>,
          resultField: string,
        ) =>
          provider
            .execute(operationName, query, variables, organizationId)
            .pipe(
              Effect.flatMap((data) => {
                const receipt = data[resultField];
                return !isRecord(receipt) || receipt.success !== true
                  ? Effect.fail(
                      new IntegrationError({
                        message: `Linear ${operationName} reported an unsuccessful mutation`,
                        retryable: false,
                      }),
                    )
                  : Effect.succeed({
                      providerReceipt: structuredClone(receipt),
                    });
              }),
            );

        switch (effect.operation) {
          case "issue.create":
            return Effect.all({
              teamId: requiredString(input, "teamId", effect.operation),
              title: requiredString(input, "title", effect.operation),
            }).pipe(
              Effect.flatMap(() =>
                execute(
                  "OpenMatterLinearIssueCreate",
                  ISSUE_CREATE,
                  { input: pick(input, issueCreateFields) },
                  "issueCreate",
                ),
              ),
            );
          case "issue.update":
            return requiredString(input, "issueId", effect.operation).pipe(
              Effect.flatMap((id) =>
                requireChanges(
                  pick(input, issueUpdateFields),
                  effect.operation,
                ).pipe(
                  Effect.flatMap((changes) =>
                    execute(
                      "OpenMatterLinearIssueUpdate",
                      ISSUE_UPDATE,
                      { id, input: changes },
                      "issueUpdate",
                    ),
                  ),
                ),
              ),
            );
          case "issue.comment.create":
            return Effect.all({
              issueId: requiredString(input, "issueId", effect.operation),
              body: requiredString(input, "body", effect.operation),
            }).pipe(
              Effect.flatMap(() =>
                execute(
                  "OpenMatterLinearCommentCreate",
                  COMMENT_CREATE,
                  { input: pick(input, ["issueId", "parentId", "body"]) },
                  "commentCreate",
                ),
              ),
            );
          case "issue.comment.update":
            return Effect.all({
              id: requiredString(input, "commentId", effect.operation),
              body: requiredString(input, "body", effect.operation),
            }).pipe(
              Effect.flatMap(({ id }) =>
                execute(
                  "OpenMatterLinearCommentUpdate",
                  COMMENT_UPDATE,
                  { id, input: pick(input, ["body"]) },
                  "commentUpdate",
                ),
              ),
            );
          case "issue.comment.delete":
            return requiredString(input, "commentId", effect.operation).pipe(
              Effect.flatMap((id) =>
                execute(
                  "OpenMatterLinearCommentDelete",
                  COMMENT_DELETE,
                  { id },
                  "commentDelete",
                ),
              ),
            );
          case "project.update":
            return requiredString(input, "projectId", effect.operation).pipe(
              Effect.flatMap((id) =>
                requireChanges(
                  pick(input, projectUpdateFields),
                  effect.operation,
                ).pipe(
                  Effect.flatMap((changes) =>
                    execute(
                      "OpenMatterLinearProjectUpdate",
                      PROJECT_UPDATE,
                      { id, input: changes },
                      "projectUpdate",
                    ),
                  ),
                ),
              ),
            );
          case "document.update":
            return requiredString(input, "documentId", effect.operation).pipe(
              Effect.flatMap((id) =>
                requireChanges(
                  pick(input, documentUpdateFields),
                  effect.operation,
                ).pipe(
                  Effect.flatMap((changes) =>
                    execute(
                      "OpenMatterLinearDocumentUpdate",
                      DOCUMENT_UPDATE,
                      { id, input: changes },
                      "documentUpdate",
                    ),
                  ),
                ),
              ),
            );
          default:
            return Effect.fail(
              new IntegrationError({
                message: `Unsupported Linear operation: ${effect.operation}`,
                retryable: false,
              }),
            );
        }
      }),
    );
  };
