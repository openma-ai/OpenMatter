import type { JsonValue } from "./json.js";
import type { BoundDefinitionRef } from "./profile.js";

export interface WorkEventData<TPayload extends JsonValue = JsonValue> {
  readonly payload: TPayload;
  readonly openmatter: BoundDefinitionRef;
}

export interface WorkEvent<TPayload extends JsonValue = JsonValue> {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly data: WorkEventData<TPayload>;
}

export interface CreateWorkEventInput<TPayload extends JsonValue> {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly binding: BoundDefinitionRef;
  readonly payload: TPayload;
}

export function createWorkEvent<TPayload extends JsonValue>(
  input: CreateWorkEventInput<TPayload>,
): WorkEvent<TPayload> {
  if (!input.source.trim()) {
    throw new Error("WorkEvent source must not be empty");
  }

  return {
    specversion: "1.0",
    id: input.id,
    source: input.source,
    type: input.type,
    time: input.time,
    datacontenttype: "application/json",
    data: {
      payload: input.payload,
      openmatter: input.binding,
    },
  };
}
