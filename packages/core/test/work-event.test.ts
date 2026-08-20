import { describe, expect, it } from "vitest";
import { createWorkEvent } from "../src/index.js";

describe("createWorkEvent", () => {
  it("pins the profile and bound surface inside the event data", () => {
    const event = createWorkEvent({
      id: "evt-1",
      source: "urn:linear:workspace-1",
      type: "com.linear.issue.updated",
      time: "2026-08-19T08:30:00.000Z",
      binding: {
        profile: {
          id: "urn:openmatter:profile:linear",
          version: "1.0.0",
          digest: "sha256:profile-v1",
        },
        surfaceId: "linear-project",
        authorityId: "workspace-1",
        definitionId: "issue.updated",
      },
      payload: { id: "WEB-42" },
    });

    expect(event).toEqual({
      specversion: "1.0",
      id: "evt-1",
      source: "urn:linear:workspace-1",
      type: "com.linear.issue.updated",
      time: "2026-08-19T08:30:00.000Z",
      datacontenttype: "application/json",
      data: {
        payload: { id: "WEB-42" },
        openmatter: {
          profile: {
            id: "urn:openmatter:profile:linear",
            version: "1.0.0",
            digest: "sha256:profile-v1",
          },
          surfaceId: "linear-project",
          authorityId: "workspace-1",
          definitionId: "issue.updated",
        },
      },
    });
  });

  it("rejects an event without a stable source", () => {
    expect(() =>
      createWorkEvent({
        id: "evt-1",
        source: " ",
        type: "issue.updated",
        time: "2026-08-19T08:30:00.000Z",
        binding: {
          profile: {
            id: "urn:openmatter:profile:test",
            version: "1.0.0",
            digest: "sha256:test",
          },
          surfaceId: "test",
          authorityId: "test",
          definitionId: "issue.updated",
        },
        payload: {},
      }),
    ).toThrowError("WorkEvent source must not be empty");
  });
});
