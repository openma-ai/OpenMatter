import { describe, expect, it } from "vitest";
import { buildHttpRequest, type HttpOperationPlan } from "../src/index.js";

const plan: HttpOperationPlan = {
  kind: "http",
  operationId: "issue.comment.create",
  method: "POST",
  pathTemplate: "/issues/{issueId}/comments",
  parameters: [
    { name: "issueId", in: "path", required: true },
    { name: "notify", in: "query" },
    { name: "X-Tenant", in: "header", required: true },
  ],
  requestBody: { mediaType: "application/json", required: true },
};

describe("buildHttpRequest", () => {
  it("executes from a self-contained HTTP plan with partitioned input", () => {
    const request = buildHttpRequest(plan, {
      baseUrl: "https://api.example.test/v1",
      input: {
        path: { issueId: "WEB-42" },
        query: { notify: true },
        headers: { "X-Tenant": "workspace-1" },
        body: { body: "hello" },
      },
    });

    expect(request).toEqual({
      url: "https://api.example.test/v1/issues/WEB-42/comments?notify=true",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant": "workspace-1",
        },
        body: "{\"body\":\"hello\"}",
      },
    });
  });

  it("fails before I/O when a required path parameter is missing", () => {
    expect(() =>
      buildHttpRequest(plan, {
        baseUrl: "https://api.example.test",
        input: {
          headers: { "X-Tenant": "workspace-1" },
          body: { body: "hello" },
        },
      }),
    ).toThrowError('Missing required path parameter "issueId"');
  });
});
