import { McpServer } from "@modelcontextprotocol/server";
import type { ThreadGoal } from "@openmatter/core";
import type {
  ProjectCommandReceipt,
  ProjectControl,
} from "@openmatter/project";
import { Effect } from "effect";
import type {
  ProjectStatus,
  ProjectStatusQuery,
} from "@openmatter/project-host";
import * as z from "zod/v4";

export interface ProjectMcpServerOptions {
  readonly control?: ProjectControl;
  /** Defaults to the minimal Router surface: `delegate` only. */
  readonly tools?: readonly ProjectControlTool[];
  readonly name?: string;
  readonly version?: string;
  /** Reads only the project already bound by the host; no caller-selected scope. */
  readonly readStatus?: (query: ProjectStatusQuery) => Promise<ProjectStatus>;
  /** Bound by the authenticated host, never selected in model arguments. */
  readonly goal?: {
    readonly get: () => Promise<ThreadGoal | null>;
    readonly create: (input: {
      objective: string;
      tokenBudget?: number;
    }) => Promise<ThreadGoal>;
    readonly update: (input: {
      status: "complete" | "blocked";
      reason?: string;
    }) => Promise<ThreadGoal>;
  };
}

export const THREAD_GOAL_INSTRUCTIONS =
  "Goal tracking belongs to this WorkThread and is managed by OpenMatter. Use only get_goal, create_goal and update_goal from the OpenMatter Project MCP server for it; do not start a provider-native goal or another automatic continuation loop. Create a goal only when explicitly requested; an ordinary task or delegation alone does not request goal tracking. Supply a token budget only when explicitly requested. Inspect the current goal before creating one. Ending a turn does not complete a goal. Mark complete only after verifying the entire objective against current evidence. Mark blocked only when the same genuine obstacle prevents meaningful progress for at least three consecutive goal turns; after an explicit resume, begin a fresh blocked audit. Do not mark blocked merely because work is slow, difficult or incomplete. Pause, resume and budget changes belong to the user or host; do not change them through other tools. Report the returned status and final usage when completing a budgeted goal.";

const GoalSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  workThreadId: z.string(),
  objective: z.string(),
  status: z.enum([
    "active",
    "paused",
    "blocked",
    "usage_limited",
    "budget_limited",
    "complete",
  ]),
  tokenBudget: z.number().positive().optional(),
  tokensUsed: z.number().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

const GoalResultSchema = z.object({ goal: GoalSchema.nullable() });
const goalResult = (goal: ThreadGoal | null) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ goal }) }],
  structuredContent: { goal },
});

export type ProjectControlTool = "delegate" | "steer" | "cancel" | "complete";

const ReceiptSchema = z.object({
  commandId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["accepted", "duplicate"]),
});

const StatusSchema = z.object({
  project: z.object({ id: z.string(), name: z.string().max(2000) }),
  pending: z.number().int().nonnegative(),
  error: z.string().max(2000).nullable(),
  threads: z
    .array(
      z.object({
        workThreadId: z.string(),
        role: z.enum(["coordinator", "worker"]),
        workerId: z.string().optional(),
        runId: z.string().optional(),
        session: z.object({
          id: z.string(),
          agentId: z.string(),
          state: z.enum([
            "creating",
            "open",
            "interrupted",
            "closed",
            "expired",
          ]),
          generation: z.number(),
          lastUsedAt: z.string(),
        }),
        turn: z
          .object({
            id: z.string(),
            state: z.enum([
              "queued",
              "running",
              "completed",
              "failed",
              "cancelled",
            ]),
            createdAt: z.string(),
            completedAt: z.string().optional(),
            summary: z.string().max(2000).optional(),
            summaryTruncated: z.boolean().optional(),
            error: z.string().max(2000).optional(),
          })
          .optional(),
        outcome: z
          .object({
            id: z.string(),
            objective: z.string().max(2000),
            status: z.enum([
              "active",
              "paused",
              "blocked",
              "usage_limited",
              "budget_limited",
              "complete",
            ]),
            tokensUsed: z.number().nonnegative(),
            timeUsedSeconds: z.number().nonnegative(),
            tokenBudget: z.number().positive().optional(),
            reason: z.string().max(2000).optional(),
            revision: z.number().int().nonnegative(),
          })
          .optional(),
      }),
    )
    .max(30),
  totalThreads: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const result = (receipt: ProjectCommandReceipt) => ({
  content: [
    {
      type: "text" as const,
      text: `Project command ${receipt.status}: ${receipt.commandId}`,
    },
  ],
  structuredContent: receipt,
});

/** Build a transport-neutral MCP server bound to exactly one Project Scope. */
export const makeProjectMcpServer = (
  options: ProjectMcpServerOptions,
): McpServer => {
  const control = options.control;
  const tools = new Set<ProjectControlTool>(
    options.tools ?? (control ? ["delegate"] : []),
  );
  if (!control && tools.size)
    throw new Error("Project controls require a host control binding");
  const instructions = [
    options.goal ? THREAD_GOAL_INSTRUCTIONS : undefined,
    options.readStatus
      ? "Use project.status to read current project execution facts. A completed turn is not task review or acceptance."
      : undefined,
    tools.has("delegate")
      ? "Delegate independent work to named workers. Read each returned command id as an accepted durable request, not a completed task."
      : undefined,
    tools.has("steer") || tools.has("cancel")
      ? "Steer or cancel only workers already known in this project."
      : undefined,
    tools.has("complete")
      ? "Call project.complete only after reviewing worker results supplied by the coordinator context."
      : undefined,
  ]
    .filter((instruction): instruction is string => instruction !== undefined)
    .join(" ");
  const server = new McpServer(
    {
      name: options.name ?? "openmatter-project-control",
      version: options.version ?? "0.1.0",
    },
    {
      instructions,
    },
  );

  if (options.goal) {
    const goal = options.goal;
    server.registerTool(
      "get_goal",
      {
        description:
          "Read the current OpenMatter goal and usage for this WorkThread.",
        inputSchema: z.strictObject({}),
        outputSchema: GoalResultSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => goalResult(await goal.get()),
    );
    server.registerTool(
      "create_goal",
      {
        description:
          "Create a goal for this WorkThread only when explicitly requested. Ordinary tasks do not imply goal creation. Supply tokenBudget only if explicitly requested; an unfinished goal cannot be replaced.",
        inputSchema: z.strictObject({
          objective: z.string().trim().min(1),
          tokenBudget: z.number().int().positive().optional(),
        }),
        outputSchema: GoalResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ objective, tokenBudget }) =>
        goalResult(
          await goal.create({
            objective,
            ...(tokenBudget === undefined ? {} : { tokenBudget }),
          }),
        ),
    );
    server.registerTool(
      "update_goal",
      {
        description:
          "Mark this WorkThread's current goal complete only when all requirements are verified, or blocked only after the same genuine obstacle prevents progress for three consecutive goal turns. A resumed blocked goal starts a fresh audit. User and host control pause, resume, limits and budgets.",
        inputSchema: z.strictObject({
          status: z.enum(["complete", "blocked"]),
          reason: z.string().trim().min(1).optional(),
        }),
        outputSchema: GoalResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ status, reason }) =>
        goalResult(
          await goal.update({
            status,
            ...(reason === undefined ? {} : { reason }),
          }),
        ),
    );
  }

  if (options.readStatus) {
    const readStatus = options.readStatus;
    server.registerTool(
      "project.status",
      {
        description:
          "Read this project's pending work, error, and latest coordinator/worker session and turn facts. Results are bounded; completed turns still require review.",
        inputSchema: z.strictObject({
          workerId: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(30).default(10),
        }),
        outputSchema: StatusSchema,
        annotations: {
          title: "Read project status",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (query) => {
        const status = StatusSchema.parse(
          await readStatus({
            limit: query.limit,
            ...(query.workerId === undefined
              ? {}
              : { workerId: query.workerId }),
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(status) }],
          structuredContent: status,
        };
      },
    );
  }

  if (tools.has("delegate")) {
    server.registerTool(
      "project.delegate",
      {
        description:
          "Queue a durable task for a new or existing named project worker.",
        inputSchema: z.object({
          workerId: z.string().min(1),
          task: z.string().min(1),
        }),
        outputSchema: ReceiptSchema,
        annotations: {
          title: "Delegate project work",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async ({ workerId, task }) =>
        result(await Effect.runPromise(control!.delegate({ workerId, task }))),
    );
  }

  if (tools.has("steer")) {
    server.registerTool(
      "project.steer",
      {
        description:
          "Queue a follow-up instruction on an existing worker Session.",
        inputSchema: z.object({
          workerId: z.string().min(1),
          instruction: z.string().min(1),
        }),
        outputSchema: ReceiptSchema,
        annotations: {
          title: "Steer project worker",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async ({ workerId, instruction }) =>
        result(
          await Effect.runPromise(control!.steer({ workerId, instruction })),
        ),
    );
  }

  if (tools.has("cancel")) {
    server.registerTool(
      "project.cancel",
      {
        description: "Request cancellation of an existing project worker Turn.",
        inputSchema: z.object({
          workerId: z.string().min(1),
          reason: z.string().min(1).optional(),
        }),
        outputSchema: ReceiptSchema,
        annotations: {
          title: "Cancel project worker",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async ({ workerId, reason }) =>
        result(
          await Effect.runPromise(
            control!.cancel({
              workerId,
              ...(reason === undefined ? {} : { reason }),
            }),
          ),
        ),
    );
  }

  if (tools.has("complete")) {
    server.registerTool(
      "project.complete",
      {
        description:
          "Mark the coordinator's project work complete with a reviewed summary.",
        inputSchema: z.object({ summary: z.string().min(1) }),
        outputSchema: ReceiptSchema,
        annotations: {
          title: "Complete project work",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      },
      async ({ summary }) =>
        result(await Effect.runPromise(control!.complete({ summary }))),
    );
  }

  return server;
};
