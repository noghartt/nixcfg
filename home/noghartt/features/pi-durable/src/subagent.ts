import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	type JsonObject,
	section,
	type SettledSubmissionRecord,
	SubmissionSettled,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { AGY_SUBAGENT_TOOL } from "./antigravity.ts";
import type { AgentProfile } from "./profiles.ts";
import { DEFAULT_PARALLEL, type Host, MAX_PARALLEL, MAX_PARALLEL_TASKS } from "./host.ts";
import { Background, Identity, type IdentityState, MESSAGE_KIND, REPORT_KIND } from "./state.ts";
import { ensureWorktree, summarizeWorktree } from "./worktrees.ts";

/** Tools a subagent keeps whatever its profile offers: talking to other agents is how it reports mid-task. */
const ALWAYS_OFFERED = new Set(["agents", "sessions"]);

export function answerText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function answerOf(tx: Tx, id: EntryId): Promise<string> {
	return answerText((await tx.entry(AssistantEntry, id))?.model?.[0] as AssistantMessage | undefined);
}

export interface ChildSpec {
	readonly name: string;
	readonly agent?: string;
	readonly isolation?: "worktree" | "none";
	readonly background: boolean;
	/** A swarm member: it works through the board, so its instructions say so and its answers go nowhere. */
	readonly swarm?: boolean;
	/** Deferred tools to offer it besides the profile's. */
	readonly extraTools?: readonly ToolRegistration[];
	/** Replaces the profile's thinking level. */
	readonly thinking?: ModelThinkingLevel;
}

/**
 * The agent and identity of a new subagent conversation: the profile's model, tools, and instructions, in a worktree
 * when isolated. Without the orchestration extension, so subagents do not spawn subagents of their own. The worktree is
 * made here, before the creating commit; `key` names it, so a rerun reuses it.
 */
export async function prepareChild(
	host: Host,
	orchestration: Extension,
	api: ToolExecutionApi,
	spec: ChildSpec,
	key: string,
	context: Context,
): Promise<{ change: AgentChange; identity: IdentityState }> {
	const profile = host.profiles.get(spec.agent);
	const parent = await api.agent(context);
	const isolation = spec.isolation ?? profile.isolation;
	let cwd = parent.cwd ?? host.cwd;
	let worktree: IdentityState["worktree"];
	if (isolation === "worktree") ({ worktree, cwd } = await ensureWorktree(cwd, host.sessionDir, host.sessionId, key));
	const extra = spec.extraTools ?? [];
	const offered =
		profile.tools === undefined
			? undefined
			: [
					...parent.tools.filter(
						(tool) =>
							(profile.tools!.includes(tool.name) || ALWAYS_OFFERED.has(tool.name)) &&
							!extra.some((added) => added.name === tool.name),
					),
					...extra,
				];
	const instructions = [
		spec.swarm === true
			? `You are "${spec.name}"${profile.name === "general" ? "" : ` (profile ${profile.name})`}, a member of a swarm ` +
				`coordinated by conversation #${api.conversationId}. The swarm section of your instructions explains how it works.`
			: `You are the subagent "${spec.name}"${profile.name === "general" ? "" : ` (profile ${profile.name})`}, started by conversation #${api.conversationId}. ` +
				"Its task message is all you know of its work. " +
				(spec.background
					? "Each of your answers is reported back to it when you finish; it may send you more messages later."
					: "Your final answer is returned to it as the result of its call, so make it complete and self-contained.") +
				' To ask it something or report progress before you finish, use the agents tool (send to "parent").',
		worktree === undefined
			? undefined
			: `You work in your own git worktree at ${worktree.path}, on branch ${worktree.branch}; other agents work in ` +
				"the main checkout and their own worktrees at the same time. Change files only inside your worktree, and " +
				(spec.swarm === true
					? "commit your work on your branch before you report it done: the coordinator reviews and merges the branch."
					: "commit your work on your branch before you answer: the main agent reviews and merges the branch."),
		profile.instructions || undefined,
	]
		.filter(Boolean)
		.join("\n\n");
	const change: AgentChange = {
		extensions: { remove: [orchestration] },
		...host.profiles.resolveModel(profile),
		...(spec.thinking === undefined ? {} : { thinkingLevel: spec.thinking }),
		...(offered === undefined ? (extra.length === 0 ? {} : { modelTools: { add: extra } }) : { modelTools: offered }),
		instructions,
		cwd,
		...(profile.maxTurns === undefined ? {} : { maxTurns: profile.maxTurns }),
	};
	const identity: IdentityState = {
		name: spec.name,
		profile: profile.name,
		parent: api.conversationId,
		background: spec.background,
		...(worktree === undefined ? {} : { worktree }),
		...(spec.swarm === true ? { swarm: true } : {}),
	};
	return { change, identity };
}

export async function createChild(
	tx: Tx,
	ownerTask: TaskId,
	change: AgentChange,
	identity: IdentityState,
): Promise<ConversationId> {
	const created = await tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
	await configure(tx, created.id, change);
	Object.assign(await tx.doc(Identity, created.id), identity);
	return created.id;
}

/** A background subagent outlives the call that starts it: its conversation is owned by this task, which ends at once. */
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "pi-durable.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export type ReporterInput = {
	/** The subagent's name, as reports show it. */
	name: string;
	conversationId: ConversationId;
	/** Where the answer is reported. */
	reportTo: ConversationId;
	message: string;
	/** Who sent the message, when not the conversation reported to. */
	from?: string;
	followUp: boolean;
};
type ReporterState = { phase: "deliver" } | { phase: "answered" } | { phase: "report"; report?: string };

/**
 * Delivers one message to a background subagent and reports its answer back as a follow-up input. A background task,
 * so the reporting conversation's Esc and idle waits leave it alone; it parks while the subagent works. Request IDs
 * keep a restart from delivering or reporting twice.
 */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "pi-durable.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { conversationId, message, followUp, from } = task.input;
			const child = await runtime.conversation(conversationId, context);
			if (child === undefined) {
				return runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "report", report: `[subagent ${task.input.name} no longer exists]` } }),
					context,
				);
			}
			await child.submit(
				{
					type: "input",
					content: from === undefined ? message : `[message from ${from}] ${message}`,
					whenBusy: followUp ? "followUp" : "steer",
					requestId: `subagent:${task.id}`,
					notify: { taskId: task.id, key: "answered" },
					...(from === undefined ? {} : { entry: { kind: MESSAGE_KIND, data: { from, text: message } } }),
				},
				context,
			);
			await runtime.commit(
				() => ({ status: "sleeping", signals: [SubmissionSettled.key("answered")], checkpoint: { phase: "answered" } }),
				context,
			);
		},
		answered: async (task, runtime, context) => {
			const { name, conversationId, reportTo } = task.input;
			const state = await runtime.readSignal(SubmissionSettled, "answered", context);
			const settled = state !== undefined && "value" in state ? state.value : undefined;
			const identity = await runtime.snapshot(Identity, conversationId, context);
			const worktree =
				identity?.worktree === undefined ? undefined : await summarizeWorktree(identity.worktree, false);
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled === undefined) return next(`[subagent ${name} never answered]`);
				// Stopped, or withdrawn while queued: nothing to report.
				if (settled.status === "unanswered") {
					return next(settled.reason === "aborted" ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
				}
				if (settled.type !== "input") return next();
				const record = (await tx.doc(Background, reportTo)).agents[name];
				if (record?.conversationId === conversationId) {
					if (record.reported.includes(settled.answer)) return next();
					record.reported.push(settled.answer);
				}
				const answer = await answerOf(tx, settled.answer);
				return next(
					`[subagent ${name} (conversation #${conversationId}) answered]\n${answer}${worktree === undefined ? "" : `\n\n${worktree}`}`,
				);
			}, context);
		},
		report: async (task, runtime, context) => {
			const report = task.state.checkpoint.report;
			if (report !== undefined) {
				const target = await runtime.conversation(task.input.reportTo, context);
				await target?.submit(
					{
						type: "input",
						content: report,
						whenBusy: "followUp",
						// Another agent's answer: Esc must not drop it.
						onAbort: "keep",
						requestId: `subagent-report:${task.id}`,
						entry: {
							kind: REPORT_KIND,
							data: { from: `subagent ${task.input.name}`, text: report, conversationId: task.input.conversationId },
						},
					},
					context,
				);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const SubagentParameters = obj({
	task: str({ description: "The complete task: the subagent sees nothing of this conversation" }),
	agent: opt(str({ description: "Profile name (see agent_profiles); default general" })),
	name: opt(str({ description: "A short name for it, unique among background subagents" })),
	isolation: opt(
		oneOf(["worktree", "none"], {
			description: "worktree: its own git worktree and branch (default: the profile's choice)",
		}),
	),
	background: opt(
		bool({
			description:
				"Return at once and keep working; its answer arrives later as a message. Message it with agents send.",
		}),
	),
});

const ParallelParameters = obj({
	tasks: arr(
		obj({
			task: str({ description: "The complete task for this subagent" }),
			agent: opt(str({ description: "Profile name; default general" })),
			name: opt(str({ description: "A short name for it" })),
			isolation: opt(oneOf(["worktree", "none"])),
		}),
		{ description: `1 to ${MAX_PARALLEL_TASKS} independent tasks` },
	),
	maxConcurrency: opt(
		int({ description: `How many run at once (default ${DEFAULT_PARALLEL}, at most ${MAX_PARALLEL})` }),
	),
});

type ParallelCheckpoint = { started: number };

type ChildStatus = {
	index: number;
	name: string;
	agent: string;
	status: "queued" | "running" | "done" | "failed";
	conversationId?: number;
};

/** The orchestration tools and their tasks: subagent, parallel. Subagents do not get them. */
export function createOrchestration(host: Host): { orchestration: Extension; tasks: Extension } {
	// eslint-disable-next-line prefer-const -- the tools refer to their own extension, defined below them.
	let orchestration: Extension;

	const subagent = defineTool({
		name: "subagent",
		description:
			"Delegate a self-contained task to a subagent: its own conversation with a profile's model, tools, and " +
			"instructions (see agent_profiles). It does not see this conversation, so give it everything it needs. " +
			"By default this waits and returns its final answer; with background: true it returns at once and the answer " +
			"arrives later as a message, while you keep working. Isolated subagents (isolation worktree, or the worker " +
			"profile) change files in their own git worktree and branch, which you then review and merge. " +
			"For several independent tasks at once, use parallel.",
		parameters: SubagentParameters,
		// A rerun after a crash finds the child, worktree, and submission it already made.
		replay: "safe",
		execute: async (args, api, context) => {
			const state = await api.readSignal(SubmissionSettled, "answered", context);
			if (state !== undefined) {
				return finish(api, "value" in state ? state.value : undefined, context);
			}
			const profile = host.profiles.get(args.agent);
			if (profile.runner === "antigravity") {
				if (args.background === true) {
					throw new Error(
						`Profile ${profile.name} runs on Antigravity, which has no background mode; call it in the foreground or through parallel.`,
					);
				}
				return runAntigravity(api, profile, args, context);
			}
			const name = args.name?.trim() || (await uniqueName(api, profile.name, args.background === true, context));
			const spec: ChildSpec = {
				name,
				agent: profile.name,
				...(args.isolation === undefined ? {} : { isolation: args.isolation }),
				background: args.background === true,
			};
			if (args.background === true) return startBackground(api, spec, args.task, context);

			const { change, identity } = await prepareChild(host, orchestration, api, spec, `t${api.taskId}`, context);
			const child = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				return existing?.id ?? createChild(tx, api.taskId, change, identity);
			}, context);
			await api.details({ conversationId: child, name, agent: profile.name }, context);
			const handle = (await api.conversation(child, context))!;
			await handle.submit(
				{
					type: "input",
					content: args.task,
					requestId: `subagent:${api.taskId}`,
					notify: { taskId: api.taskId, key: "answered" },
				},
				context,
			);
			// Parked: the call holds no process while the subagent works, and survives a restart.
			return { sleep: { signals: [SubmissionSettled.key("answered")] } };
		},
	});

	/**
	 * A profile with `runner: antigravity`: one agy run as a nested call, in its own worktree when isolated. Replay-safe
	 * like the rest of the tool: a rerun finds the worktree (same key) and the nested call (same key and arguments).
	 */
	async function runAntigravity(
		api: ToolExecutionApi,
		profile: AgentProfile,
		args: { task: string; name?: string; isolation?: "worktree" | "none" },
		context: Context,
	) {
		const name = args.name?.trim() || profile.name;
		const isolation = args.isolation ?? profile.isolation;
		let cwd = (await api.agent(context)).cwd ?? host.cwd;
		let worktree: IdentityState["worktree"];
		if (isolation === "worktree") {
			({ worktree, cwd } = await ensureWorktree(cwd, host.sessionDir, host.sessionId, `t${api.taskId}`));
		}
		// Writes only ever land in its own worktree: an isolation "none" override makes it read-only.
		const allowWrites = profile.allowWrites === true && worktree !== undefined;
		const task = [
			profile.instructions || undefined,
			worktree === undefined
				? undefined
				: `You work in your own git worktree at ${worktree.path}, on branch ${worktree.branch}. Change files only ` +
					"inside it, and commit your work on that branch before you answer: your caller reviews and merges it.",
			`Task:\n${args.task}`,
		]
			.filter(Boolean)
			.join("\n\n");
		const call = await api.executeTool(
			AGY_SUBAGENT_TOOL,
			{ task, cwd, allowWrites, ...(profile.model === undefined ? {} : { model: profile.model }) },
			context,
			{ key: "agy", wait: false },
		);
		await api.details({ name, agent: profile.name, runner: "antigravity" }, context);
		const status = (await api.getTask(call.taskId, context))?.state.status;
		if (status !== undefined && status !== "terminal") return { wait: { on: [call.taskId], policy: "any" as const } };
		const result = await call.result(context);
		const text =
			typeof result.structuredOutput === "string"
				? result.structuredOutput
				: result.diagnostics.map((d) => d.message).join("\n") || "(agy returned nothing)";
		const summary = worktree === undefined ? undefined : await summarizeWorktree(worktree, true);
		return {
			output: [
				{
					type: "text" as const,
					text: [text, summary, `[subagent ${name} (profile ${profile.name}, Antigravity)]`].filter(Boolean).join("\n\n"),
				},
			],
			isError: result.isError,
		};
	}

	/** A name not taken among this conversation's background subagents. */
	async function uniqueName(
		api: ToolExecutionApi,
		base: string,
		background: boolean,
		context: Context,
	): Promise<string> {
		if (!background) return base;
		const taken = (await api.snapshot(Background, api.conversationId, context))?.agents ?? {};
		for (let index = 1; ; index++) {
			const name = `${base}-${index}`;
			// A rerun after a crash finds the name it took.
			if (!Object.hasOwn(taken, name) || taken[name]!.createdBy === api.taskId) return name;
		}
	}

	async function finish(api: ToolExecutionApi, settled: SettledSubmissionRecord | undefined, context: Context) {
		const child = await api.commit(
			async (tx) => (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]?.id,
			context,
		);
		const identity = child === undefined ? undefined : await api.snapshot(Identity, child, context);
		const label = `subagent ${identity?.name ?? "?"} (conversation #${child ?? "?"})`;
		if (settled === undefined || settled.status !== "done" || settled.type !== "input") {
			const reason = settled === undefined ? "no answer" : settled.status === "unanswered" ? settled.reason : "no answer";
			return { output: [{ type: "text" as const, text: `${label} ended without an answer: ${reason}` }], isError: true };
		}
		const answer = await api.commit((tx) => answerOf(tx, settled.answer), context);
		// A finished isolated subagent that changed nothing leaves no worktree behind.
		const worktree =
			identity?.worktree === undefined ? undefined : await summarizeWorktree(identity.worktree, true);
		const text = [answer || "(no text in its answer)", worktree, `[${label}]`].filter(Boolean).join("\n\n");
		return { output: [{ type: "text" as const, text }] };
	}

	async function startBackground(api: ToolExecutionApi, spec: ChildSpec, task: string, context: Context) {
		const known = (await api.snapshot(Background, api.conversationId, context))?.agents[spec.name];
		if (known !== undefined && known.createdBy !== api.taskId) {
			throw new Error(`A background subagent named ${spec.name} exists; message it with agents send, or pick another name.`);
		}
		const { change, identity } = await prepareChild(host, orchestration, api, spec, `bg${api.taskId}`, context);
		const child = await api.commit(async (tx) => {
			const state = await tx.doc(Background, api.conversationId);
			const existing = state.agents[spec.name];
			if (existing !== undefined) return existing.conversationId;
			// Both are background tasks of this conversation: its Esc and idle waits skip them.
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			const anchor = await tx.createTask(Anchor, null, background);
			const id = await createChild(tx, anchor, change, identity);
			state.agents[spec.name] = {
				conversationId: id,
				...(identity.profile === undefined ? {} : { profile: identity.profile }),
				createdBy: api.taskId,
				reported: [],
			};
			const input: ReporterInput = {
				name: spec.name,
				conversationId: id,
				reportTo: api.conversationId,
				message: task,
				followUp: false,
			};
			await tx.createTask(Reporter, input, background);
			return id;
		}, context);
		return {
			output: [
				{
					type: "text" as const,
					text:
						`Started background subagent ${spec.name} (conversation #${child}, profile ${identity.profile}). ` +
						"Its answer arrives as a message when it finishes; agents send/stop/read reach it meanwhile.",
				},
			],
			details: { conversationId: child, name: spec.name, agent: identity.profile ?? "general", background: true },
		};
	}

	const parallel = defineTool<typeof ParallelParameters, JsonValue, ParallelCheckpoint>({
		name: "parallel",
		description:
			"Run several independent tasks at once, each in its own subagent (see agent_profiles), and return all their " +
			"answers. Each subagent sees only its own task. Use it to fan out research, reviews, or changes to separate " +
			"areas; give changing subagents isolation worktree (or the worker profile) so their edits never collide. " +
			`At most ${MAX_PARALLEL_TASKS} tasks; ${DEFAULT_PARALLEL} run at a time unless maxConcurrency says otherwise.`,
		parameters: ParallelParameters,
		replay: "safe",
		execute: async (args, api, context) => {
			const total = args.tasks.length;
			if (total === 0) throw new Error("parallel needs at least one task");
			if (total > MAX_PARALLEL_TASKS) throw new Error(`parallel takes at most ${MAX_PARALLEL_TASKS} tasks`);
			const cap = Math.max(1, Math.min(args.maxConcurrency ?? DEFAULT_PARALLEL, MAX_PARALLEL));
			// Every profile is checked before anything starts.
			const specs = args.tasks.map((item, index) => {
				const agent = host.profiles.get(item.agent).name;
				return {
					agent,
					name: item.name?.trim() || `${agent}-${index + 1}`,
					args: {
						task: item.task,
						agent,
						name: item.name?.trim() || `${agent}-${index + 1}`,
						...(item.isolation === undefined ? {} : { isolation: item.isolation }),
					} as JsonObject,
				};
			});
			// Keys name the nested calls across wakes: the same key finds the same call again.
			const start = (index: number) =>
				api.executeTool("subagent", specs[index]!.args, context, { key: `t${index}`, wait: false });
			const calls = [];
			for (let index = 0; index < (api.checkpoint?.started ?? 0); index++) calls.push(await start(index));
			const done = async (taskId: TaskId) => {
				const status = (await api.getTask(taskId, context))?.state.status;
				return status === undefined || status === "terminal";
			};
			let running = 0;
			for (const call of calls) if (!(await done(call.taskId))) running++;
			while (running < cap && calls.length < total) {
				calls.push(await start(calls.length));
				running++;
			}

			const children: ChildStatus[] = [];
			const open: TaskId[] = [];
			for (let index = 0; index < total; index++) {
				const spec = specs[index]!;
				const call = calls[index];
				let status: ChildStatus["status"] = "queued";
				let conversationId: number | undefined;
				if (call !== undefined) {
					conversationId = await api.commit(
						async (tx) => (await tx.scanConversations({ ownerTaskId: call.taskId }, 1)).items[0]?.id,
						context,
					);
					if (await done(call.taskId)) {
						status = (await call.result(context)).isError ? "failed" : "done";
					} else {
						status = "running";
						open.push(call.taskId);
					}
				}
				children.push({
					index,
					name: spec.name,
					agent: spec.agent,
					status,
					...(conversationId === undefined ? {} : { conversationId }),
				});
			}
			await api.details({ parallel: children }, context);
			if (open.length > 0) {
				return { wait: { on: open, policy: "any", checkpoint: { started: calls.length } } };
			}

			const sections: string[] = [];
			let failed = 0;
			for (const [index, call] of calls.entries()) {
				const result = await call.result(context);
				const child = children[index]!;
				if (result.isError) failed++;
				const text =
					typeof result.structuredOutput === "string"
						? result.structuredOutput
						: JSON.stringify(result.structuredOutput ?? result.diagnostics ?? "no result");
				sections.push(
					`## ${index + 1}. ${child.name} (${child.agent})${result.isError ? " — failed" : ""}\n\n${text.trim()}`,
				);
			}
			const header = `${total - failed} of ${total} subagents answered${failed > 0 ? `, ${failed} failed` : ""}.`;
			return { output: [{ type: "text", text: [header, ...sections].join("\n\n") }] };
		},
	});

	orchestration = defineExtension({
		name: "pi-durable-orchestration",
		tools: [subagent, parallel],
		// Profiles change on /reload; the section is sent again only when its text changes.
		sections: [
			section(
				"agent_profiles",
				() =>
					"Subagent profiles for the subagent and parallel tools (agent parameter):\n" +
					`${host.profiles.describe()}\n` +
					"Delegate work that is self-contained or can run alongside yours; keep work that needs this conversation's " +
					"context. Run independent tasks with parallel rather than one subagent after another. Subagents that " +
					"change files at the same time need isolation worktree.",
			),
		],
	});
	// Task definitions every conversation needs, also subagents sending to background subagents.
	const tasks = defineExtension({ name: "pi-durable-tasks", tasks: [Anchor, Reporter] });
	return { orchestration, tasks };
}

