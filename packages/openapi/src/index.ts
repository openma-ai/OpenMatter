import type { JsonValue } from "@openmatter/core";

export interface HttpParameterPlan {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required?: boolean;
}

export interface HttpOperationPlan {
  readonly kind: "http";
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly parameters: readonly HttpParameterPlan[];
  readonly requestBody?: {
    readonly mediaType: string;
    readonly required?: boolean;
  };
}

export interface HttpOperationInput {
  readonly path?: Readonly<Record<string, JsonValue>>;
  readonly query?: Readonly<Record<string, JsonValue>>;
  readonly headers?: Readonly<Record<string, JsonValue>>;
  readonly cookies?: Readonly<Record<string, JsonValue>>;
  readonly body?: JsonValue;
}

export interface BuildHttpRequestInput {
  readonly baseUrl: string;
  readonly input: HttpOperationInput;
}

export interface BuiltHttpRequest {
  readonly url: string;
  readonly init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  };
}

export function buildHttpRequest(
  plan: HttpOperationPlan,
  request: BuildHttpRequestInput,
): BuiltHttpRequest {
  const stringify = (value: JsonValue): string =>
    typeof value === "string" ? value : JSON.stringify(value);
  let path = plan.pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  for (const parameter of plan.parameters) {
    const values =
      parameter.in === "path"
        ? request.input.path
        : parameter.in === "query"
          ? request.input.query
          : parameter.in === "header"
            ? request.input.headers
            : request.input.cookies;
    const value = values?.[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        throw new Error(
          `Missing required ${parameter.in} parameter "${parameter.name}"`,
        );
      }
      continue;
    }

    const encoded = stringify(value);
    switch (parameter.in) {
      case "path":
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(encoded));
        break;
      case "query":
        query.append(parameter.name, encoded);
        break;
      case "header":
        headers[parameter.name.toLowerCase()] = encoded;
        break;
      case "cookie":
        cookies.push(`${encodeURIComponent(parameter.name)}=${encodeURIComponent(encoded)}`);
        break;
    }
  }

  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  const body = request.input.body;
  if (body === undefined && plan.requestBody?.required) {
    throw new Error("Missing required request body");
  }
  if (body !== undefined && plan.requestBody) {
    headers["content-type"] = plan.requestBody.mediaType;
  }

  const baseUrl = request.baseUrl.endsWith("/")
    ? request.baseUrl.slice(0, -1)
    : request.baseUrl;
  const queryString = query.toString();
  return {
    url: `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`,
    init: {
      method: plan.method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  };
}
