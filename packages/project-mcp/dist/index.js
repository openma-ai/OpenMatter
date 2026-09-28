import { McpServer } from "@modelcontextprotocol/server";
import { Effect } from "effect";
import * as z from "zod/v4";
//#region src/index.ts
const THREAD_GOAL_INSTRUCTIONS = "Goal tracking belongs to this WorkThread and is managed by OpenMatter. Use only get_goal, create_goal and update_goal from the OpenMatter Project MCP server for it; do not start a provider-native goal or another automatic continuation loop. Create a goal only when explicitly requested; an ordinary task or delegation alone does not request goal tracking. Supply a token budget only when explicitly requested. Inspect the current goal before creating one. Ending a turn does not complete a goal. Mark complete only after verifying the entire objective against current evidence. Mark blocked only when the same genuine obstacle prevents meaningful progress for at least three consecutive goal turns; after an explicit resume, begin a fresh blocked audit. Do not mark blocked merely because work is slow, difficult or incomplete. Pause, resume and budget changes belong to the user or host; do not change them through other tools. Report the returned status and final usage when completing a budgeted goal.";
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
		"complete"
	]),
	tokenBudget: z.number().positive().optional(),
	tokensUsed: z.number().nonnegative(),
	timeUsedSeconds: z.number().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
	revision: z.number().int().nonnegative(),
	reason: z.string().optional()
});
const GoalResultSchema = z.object({ goal: GoalSchema.nullable() });
const goalResult = (goal) => ({
	content: [{
		type: "text",
		text: JSON.stringify({ goal })
	}],
	structuredContent: { goal }
});
const ReceiptSchema = z.object({
	commandId: z.string(),
	idempotencyKey: z.string(),
	status: z.enum(["accepted", "duplicate"])
});
const StatusSchema = z.object({
	project: z.object({
		id: z.string(),
		name: z.string().max(2e3)
	}),
	pending: z.number().int().nonnegative(),
	error: z.string().max(2e3).nullable(),
	threads: z.array(z.object({
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
				"expired"
			]),
			generation: z.number(),
			lastUsedAt: z.string()
		}),
		turn: z.object({
			id: z.string(),
			state: z.enum([
				"queued",
				"running",
				"completed",
				"failed",
				"cancelled"
			]),
			createdAt: z.string(),
			completedAt: z.string().optional(),
			summary: z.string().max(2e3).optional(),
			summaryTruncated: z.boolean().optional(),
			error: z.string().max(2e3).optional()
		}).optional(),
		outcome: z.object({
			id: z.string(),
			objective: z.string().max(2e3),
			status: z.enum([
				"active",
				"paused",
				"blocked",
				"usage_limited",
				"budget_limited",
				"complete"
			]),
			tokensUsed: z.number().nonnegative(),
			timeUsedSeconds: z.number().nonnegative(),
			tokenBudget: z.number().positive().optional(),
			reason: z.string().max(2e3).optional(),
			revision: z.number().int().nonnegative()
		}).optional()
	})).max(30),
	totalThreads: z.number().int().nonnegative(),
	truncated: z.boolean()
});
const result = (receipt) => ({
	content: [{
		type: "text",
		text: `Project command ${receipt.status}: ${receipt.commandId}`
	}],
	structuredContent: receipt
});
/** Build a transport-neutral MCP server bound to exactly one Project Scope. */
const makeProjectMcpServer = (options) => {
	const control = options.control;
	const tools = new Set(options.tools ?? (control ? ["delegate"] : []));
	if (!control && tools.size) throw new Error("Project controls require a host control binding");
	const instructions = [
		options.goal ? THREAD_GOAL_INSTRUCTIONS : void 0,
		options.readStatus ? "Use project.status to read current project execution facts. A completed turn is not task review or acceptance." : void 0,
		tools.has("delegate") ? "Delegate independent work to named workers. Read each returned command id as an accepted durable request, not a completed task." : void 0,
		tools.has("steer") || tools.has("cancel") ? "Steer or cancel only workers already known in this project." : void 0,
		tools.has("complete") ? "Call project.complete only after reviewing worker results supplied by the coordinator context." : void 0
	].filter((instruction) => instruction !== void 0).join(" ");
	const server = new McpServer({
		name: options.name ?? "openmatter-project-control",
		version: options.version ?? "0.1.0"
	}, { instructions });
	if (options.goal) {
		const goal = options.goal;
		server.registerTool("get_goal", {
			description: "Read the current OpenMatter goal and usage for this WorkThread.",
			inputSchema: z.strictObject({}),
			outputSchema: GoalResultSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		}, async () => goalResult(await goal.get()));
		server.registerTool("create_goal", {
			description: "Create a goal for this WorkThread only when explicitly requested. Ordinary tasks do not imply goal creation. Supply tokenBudget only if explicitly requested; an unfinished goal cannot be replaced.",
			inputSchema: z.strictObject({
				objective: z.string().trim().min(1),
				tokenBudget: z.number().int().positive().optional()
			}),
			outputSchema: GoalResultSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false
			}
		}, async ({ objective, tokenBudget }) => goalResult(await goal.create({
			objective,
			...tokenBudget === void 0 ? {} : { tokenBudget }
		})));
		server.registerTool("update_goal", {
			description: "Mark this WorkThread's current goal complete only when all requirements are verified, or blocked only after the same genuine obstacle prevents progress for three consecutive goal turns. A resumed blocked goal starts a fresh audit. User and host control pause, resume, limits and budgets.",
			inputSchema: z.strictObject({
				status: z.enum(["complete", "blocked"]),
				reason: z.string().trim().min(1).optional()
			}),
			outputSchema: GoalResultSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		}, async ({ status, reason }) => goalResult(await goal.update({
			status,
			...reason === void 0 ? {} : { reason }
		})));
	}
	if (options.readStatus) {
		const readStatus = options.readStatus;
		server.registerTool("project.status", {
			description: "Read this project's pending work, error, and latest coordinator/worker session and turn facts. Results are bounded; completed turns still require review.",
			inputSchema: z.strictObject({
				workerId: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(30).default(10)
			}),
			outputSchema: StatusSchema,
			annotations: {
				title: "Read project status",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		}, async (query) => {
			const status = StatusSchema.parse(await readStatus({
				limit: query.limit,
				...query.workerId === void 0 ? {} : { workerId: query.workerId }
			}));
			return {
				content: [{
					type: "text",
					text: JSON.stringify(status)
				}],
				structuredContent: status
			};
		});
	}
	if (tools.has("delegate")) server.registerTool("project.delegate", {
		description: "Queue a durable task for a new or existing named project worker.",
		inputSchema: z.object({
			workerId: z.string().min(1),
			task: z.string().min(1)
		}),
		outputSchema: ReceiptSchema,
		annotations: {
			title: "Delegate project work",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false
		}
	}, async ({ workerId, task }) => result(await Effect.runPromise(control.delegate({
		workerId,
		task
	}))));
	if (tools.has("steer")) server.registerTool("project.steer", {
		description: "Queue a follow-up instruction on an existing worker Session.",
		inputSchema: z.object({
			workerId: z.string().min(1),
			instruction: z.string().min(1)
		}),
		outputSchema: ReceiptSchema,
		annotations: {
			title: "Steer project worker",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false
		}
	}, async ({ workerId, instruction }) => result(await Effect.runPromise(control.steer({
		workerId,
		instruction
	}))));
	if (tools.has("cancel")) server.registerTool("project.cancel", {
		description: "Request cancellation of an existing project worker Turn.",
		inputSchema: z.object({
			workerId: z.string().min(1),
			reason: z.string().min(1).optional()
		}),
		outputSchema: ReceiptSchema,
		annotations: {
			title: "Cancel project worker",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true
		}
	}, async ({ workerId, reason }) => result(await Effect.runPromise(control.cancel({
		workerId,
		...reason === void 0 ? {} : { reason }
	}))));
	if (tools.has("complete")) server.registerTool("project.complete", {
		description: "Mark the coordinator's project work complete with a reviewed summary.",
		inputSchema: z.object({ summary: z.string().min(1) }),
		outputSchema: ReceiptSchema,
		annotations: {
			title: "Complete project work",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false
		}
	}, async ({ summary }) => result(await Effect.runPromise(control.complete({ summary }))));
	return server;
};
//#endregion
export { THREAD_GOAL_INSTRUCTIONS, makeProjectMcpServer };

//# sourceMappingURL=index.js.map