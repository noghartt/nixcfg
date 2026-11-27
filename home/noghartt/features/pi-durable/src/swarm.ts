import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type AgentState,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type DocumentReader,
	type Extension,
	type Harness,
	LiveDoc,
	section,
	type SubmissionDraft,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type AgyOutcome, DEFAULT_MODEL as AGY_DEFAULT_MODEL, execAgy } from "./antigravity.ts";
import { type Host, oneLine } from "./host.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentProfile } from "./profiles.ts";
import { MESSAGE_KIND, Swarm, type SwarmMember, type SwarmPost, type SwarmState, type WorktreeInfo } from "./state.ts";
import { Anchor, type ChildSpec, createChild, prepareChild } from "./subagent.ts";
import { ensureWorktree, summarizeWorktree } from "./worktrees.ts";

/** Who wrote a post: a member's name, or the coordinator. */
const COORDINATOR = "coordinator";
const RESERVED = new Set([COORDINATOR, "all", "monitor", "user", "system"]);
/** A trailing `-` or `_` would be dropped from a mention, so names end in a letter or digit. */
const NAME = /^[a-z0-9](?:[a-z0-9_-]{0,22}[a-z0-9])?$/u;
/** How often the monitor looks for a stalled swarm. */
const MONITOR_SECONDS = Number(process.env.PI_DURABLE_SWARM_MONITOR_SECONDS) || 180;
/** Posts one read_board call returns at most. */
const READ_LIMIT = 50;
/** Workers one add call may start. */
const MAX_ADD = 12;
/** How often a running Antigravity member checks whether it was killed. */
const AGY_KILL_POLL_MS = 2000;
/** Posts one Antigravity run is given at most, how much of each, and how long its answer may be as a post. */
const AGY_POSTS = 40;
const AGY_POST_CHARS = 4000;
const AGY_ANSWER_CHARS = 8000;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const COORDINATOR_GUIDE = `You coordinate a swarm: worker agents, each its own conversation, that collaborate through one shared message board. The user talks to you and to nobody else; the workers talk to you and to each other on the board.

Your tools: swarm (status, add, kill, title, plan), post_message, read_board, swarm_wait.

Do not do the work yourself: split it, brief the workers, judge their results, land them, and report to the user.

Start it:
- Size the task. Split only along independent boundaries, one worker per file, module or question, and say in each brief who owns what, so no two workers ever edit the same file. Keep the swarm lean.
- In one turn: name the swarm (swarm title), add every initial worker (swarm add), and record the plan (swarm plan: a goal and up to six threads of members, for the board's overview). Then end your turn: call swarm_wait alone, as the only call of your last step.
- swarm add takes a name, a brief, an agent (a profile from agent_profiles), and optionally thinking, workspace and tasks. workspace "worktree" gives an author its own git worktree and branch, for workers that edit files at the same time; "inherit" shares the main checkout and suits readers and verifiers. tasks shards one brief: one worker per item, named <name>-1..n, all on that profile.
- A brief is all a worker knows: the goal, its part, the files it owns, who it hands off to (@name), and what done means. It is posted on the board as "@name <brief>" and wakes the worker.
- Add verifiers, about one per two to four authors, with workspace inherit: authors hand them work ("@verifier check #12"), and they report findings to the author rather than edit.

Pick each member's model:
- Every member runs on its profile's model; agent_profiles lists them. general copies your own model, the dearest choice when you run on a large one: give it only parts that need your level of judgment.
- Match the model to the part: a fast, cheap implementer for well-specified, mechanical edits, tests and small fixes; a strong one for design, tricky bugs and anything that needs judgment; a read-only scout for searching code and answering questions. A swarm of cheap workers judged by you is the point.
- Set thinking per member when the profile's level does not fit the part: low or minimal for mechanical edits and lookups, high or xhigh for hard reasoning and reviews. On an Antigravity member it picks the model's -low, -medium or -high variant.
- Mix model families. A verifier on another family than the author it checks catches more (an OpenAI reviewer for a Claude author, and the other way round). When the right approach is unclear, let two families attempt it side by side and keep the better result.
- Antigravity profiles (Gemini through agy) join as members too. They have no conversation: a post that mentions one runs agy with every post it has not seen, and agy's answer is posted as its reply, so brief them self-contained. Read-only ones suit second opinions and web or browser research; writing ones work only in their own worktree.

Keep it going:
- You are woken by posts that mention you; while you sleep the swarm costs you nothing. Read the rest with read_board.
- @name wakes that member, @<group> every <group>-N, @all every member. A mention is a doorbell, not a CC: mention only who must act. Posts without mentions wake nobody.
- Workers report "@coordinator [done] ..." or "[blocked] ...". Judge every result: read the diff (swarm status lists branches), run the checks, then send it back with specifics or accept it.
- Land accepted work yourself: merge or cherry-pick each worker's branch into the main checkout and resolve conflicts. Do not push unless the user asked.
- Kill a member once its work is landed or no longer needed (swarm kill). Its worktree is removed when it changed nothing; a branch with commits is kept.
- A "[swarm monitor]" stall alert means nobody is working although the swarm is not done: act on it at once (read the board, answer, re-brief the silent, add or kill members).
- Add a worker when work is queued and nobody is free; do not let workers wait on you.

Finish:
- When everything is landed and verified, post one "[done] <summary>" without mentions: that closes the swarm. Then give the user the final summary: what changed and where, what was verified, and what is left.`;

const WORKER_GUIDE = `You are a member of a swarm: worker agents, each its own conversation, that collaborate through one shared message board with a coordinator. The coordinator talks to the user; you talk to the board.

- The board post that woke you (your brief) is all you know of the task. Start on it right away.
- Only board posts reach anyone: your plain answers go nowhere. Post with post_message; read with read_board, which starts after the newest post you have read.
- @name wakes that member, @coordinator the coordinator, @all everyone. Mention only who must act. Hand work straight to the peer who needs it (for example "@verifier check #12") rather than through the coordinator.
- Keep posts short and concrete. Refer to earlier posts as #seq instead of quoting them. No greetings, thanks or acknowledgements.
- When your part is finished (committed, if you have a worktree), post "@coordinator [done] <what you did, where, how you checked it>". When blocked, post "@coordinator [blocked] <what you need>".
- Change only the files your brief gives you.
- Members may run on other models. Antigravity members (Gemini through agy) cannot read the board: a post that mentions one hands it every post since its last reply, and its answer comes back as its post.
- Waiting costs nothing: end your turn by passing wait: true to your last post_message, or by calling swarm_wait alone. A post that mentions you wakes you.`;

/** The first message of an Antigravity member's agy conversation, before the posts it has not seen. */
function agyGuide(name: string, member: Readonly<SwarmMember>): string {
	const agy = member.agy!;
	const workspace =
		member.worktree !== undefined && agy.allowWrites
			? `You work in your own git worktree at ${member.worktree.path}, on branch ${member.worktree.branch}; others work in the ` +
				"main checkout and their own worktrees at the same time. Change files only inside it, and commit your work on " +
				"that branch before you report it done: the coordinator reviews and merges it."
			: "You are read-only: do not change files, report what you find.";
	return [
		`You are "${name}", a member of a swarm: agents, each on its own model, that collaborate through one shared message ` +
			"board with a coordinator, who talks to the user. You cannot read or post on the board yourself: each message " +
			"you get carries the board posts you have not seen, and your final answer is posted on the board as your reply, " +
			"verbatim.",
		[
			"- The posts that mention you (@" + name + ") are your work; the first is your brief. Start on it right away.",
			"- Make your final answer the post itself: short and concrete, no greetings. Refer to earlier posts as #seq.",
			"- @name wakes that member, @coordinator the coordinator, @all everyone; mention only who must act. A reply that " +
				"mentions nobody goes to whoever mentioned you.",
			"- When your part is finished, answer \"@coordinator [done] <what you did, where, how you checked it>\"; when " +
				"blocked, \"@coordinator [blocked] <what you need>\".",
			"- Change only the files your brief gives you.",
		].join("\n"),
		workspace,
		agy.instructions || undefined,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** What one round of an Antigravity member asks agy: the posts it has not seen, and who to answer when it mentions nobody. */
type AgyAsk = { prompt: string; newest: number; askers: string[] };

function agyAsk(swarm: Readonly<SwarmState>, name: string, member: Readonly<SwarmMember>): AgyAsk {
	const unread = swarm.posts.filter((post) => post.seq > member.lastRead && post.from !== name);
	const shown = unread.slice(-AGY_POSTS);
	const omitted = unread.length - shown.length;
	const posts = shown.map((post) => {
		const body = post.text.length > AGY_POST_CHARS ? `${post.text.slice(0, AGY_POST_CHARS)}… (cut)` : post.text;
		return `#${post.seq} ${post.from}: ${body}`;
	});
	const askers = [
		...new Set(unread.filter((post) => mentioned(swarm, post.text, post.from).includes(name)).map((post) => post.from)),
	];
	const first = member.agy?.conversation === undefined;
	const prompt = [
		first ? agyGuide(name, member) : undefined,
		`${first ? "Board posts you have not seen" : "Board posts since your last reply"}, oldest first` +
			`${omitted > 0 ? ` (${omitted} older ones left out)` : ""}:`,
		posts.join("\n\n"),
		first ? undefined : "Your final answer is your next post.",
	]
		.filter(Boolean)
		.join("\n\n");
	return { prompt, newest: swarm.posts.at(-1)?.seq ?? member.lastRead, askers: askers.length > 0 ? askers : [COORDINATOR] };
}

// ─── Board ───────────────────────────────────────────────────────────────────

/** Who `id` is in the swarm: the coordinator, a live member, or nobody. */
function roleOf(swarm: Readonly<SwarmState>, id: ConversationId): string | undefined {
	if (swarm.coordinator === id) return COORDINATOR;
	return Object.entries(swarm.members).find(([, member]) => member.conversationId === id && member.killed !== true)?.[0];
}

/** The live members and the coordinator a post mentions: `@name`, `@<group>` for every `<group>-N`, `@all`. */
export function mentioned(swarm: Readonly<SwarmState>, body: string, from: string): string[] {
	const live = Object.entries(swarm.members).filter(([, member]) => member.killed !== true).map(([name]) => name);
	const found = new Set<string>();
	for (const match of body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_-]*)/giu)) {
		const token = match[1]!.toLowerCase().replace(/[-_]+$/u, "");
		if (token === "all") for (const name of live) found.add(name);
		else if (token === COORDINATOR) found.add(COORDINATOR);
		else if (live.includes(token)) found.add(token);
		else for (const name of live) if (inGroup(name, token)) found.add(name);
	}
	found.delete(from);
	return [...found];
}

/** Whether `name` is `<group>-N`. */
function inGroup(name: string, group: string): boolean {
	return name.startsWith(`${group}-`) && /^\d+$/u.test(name.slice(group.length + 1));
}

/** The input that wakes a member (or the coordinator) with a post. */
function wakeDraft(swarm: Readonly<SwarmState>, post: SwarmPost, reader: string, unreadBefore: number): SubmissionDraft {
	const note = unreadBefore > 0 ? `\n\n(${unreadBefore} earlier post${unreadBefore === 1 ? "" : "s"} unread; read_board shows them.)` : "";
	return {
		type: "input",
		content: `[swarm #${post.seq} from ${post.from}] ${post.text}${note}`,
		whenBusy: "followUp",
		// Another agent's message: Esc must not drop it.
		onAbort: "keep",
		// Per swarm: a later swarm's post numbers start again, and request IDs are never reused in a conversation.
		requestId: `swarm:${swarm.started ?? 0}:${post.seq}:${reader}`,
		entry: { kind: MESSAGE_KIND, data: { from: `swarm #${post.seq} ${post.from}`, text: post.text } },
	};
}

function readerConversation(swarm: Readonly<SwarmState>, reader: string): ConversationId | undefined {
	return reader === COORDINATOR ? swarm.coordinator : swarm.members[reader]?.conversationId;
}

function lastReadOf(swarm: Readonly<SwarmState>, reader: string): number {
	return reader === COORDINATOR ? (swarm.coordinatorRead ?? 0) : (swarm.members[reader]?.lastRead ?? 0);
}

function setLastRead(swarm: SwarmState, reader: string, seq: number): void {
	if (reader === COORDINATOR) swarm.coordinatorRead = Math.max(swarm.coordinatorRead ?? 0, seq);
	else if (swarm.members[reader] !== undefined) swarm.members[reader]!.lastRead = Math.max(swarm.members[reader]!.lastRead, seq);
}

/**
 * The wake of each reader for `post`, and whether its read mark moves past the post (when it was the only thing unread).
 * Pure: a transaction submits before it writes.
 */
function wakes(
	swarm: Readonly<SwarmState>,
	post: SwarmPost,
	readers: readonly string[],
): { reader: string; draft: SubmissionDraft; caughtUp: boolean }[] {
	return readers.map((reader) => {
		const read = lastReadOf(swarm, reader);
		const unread = swarm.posts.filter((p) => p.seq > read && p.seq < post.seq && p.from !== reader).length;
		return { reader, draft: wakeDraft(swarm, post, reader, unread), caughtUp: unread === 0 };
	});
}

function formatPost(post: SwarmPost): string {
	return `#${post.seq} ${post.from} (${new Date(post.time).toISOString().slice(11, 19)}): ${post.text}`;
}

/** Whether a member is at work: its conversation has a live run, or its Antigravity run is live. */
async function isWorking(reader: DocumentReader, member: Readonly<SwarmMember>, context: Context): Promise<boolean> {
	if (member.agy !== undefined) return member.agy.run !== undefined;
	if (member.conversationId === undefined) return false;
	return (await reader.snapshot(LiveDoc, member.conversationId, context))?.run !== undefined;
}

/** A member's state: killed, working (a run is live), or idle (waiting on the board). */
async function memberState(reader: DocumentReader, member: Readonly<SwarmMember>, context: Context): Promise<string> {
	if (member.killed === true) return "killed";
	return (await isWorking(reader, member, context)) ? "working" : "idle";
}

/** A conversation's model as `provider/model:thinking`, the notation of profiles and `--model`. */
async function modelOf(reader: DocumentReader, id: ConversationId, context: Context): Promise<string | undefined> {
	const agent = (await reader.snapshot(AgentDoc, id, context)) as AgentState | undefined;
	if (agent?.model === undefined) return undefined;
	return `${agent.model.provider}/${agent.model.modelId}${agent.thinkingLevel === undefined ? "" : `:${agent.thinkingLevel}`}`;
}

const AGY_LEVEL = /-(low|medium|high|xhigh)$/u;

/**
 * The agy model for a thinking level: agy has no thinking setting, but most of its models come in -low, -medium, -high
 * (and for Gemini 4 Neon and Hydrogen -xhigh) variants. Other models (gpt-oss comes in -medium only) are kept.
 */
export function agyModelFor(model: string, thinking: ModelThinkingLevel | undefined): string {
	if (thinking === undefined || !/^(gemini|claude)-/u.test(model) || !AGY_LEVEL.test(model)) return model;
	const xhigh = /^gemini-4-(neon|hydrogen)-/u.test(model);
	const level = thinking === "off" || thinking === "minimal" ? "low" : thinking === "xhigh" && !xhigh ? "high" : thinking;
	return model.replace(AGY_LEVEL, `-${level}`);
}

async function memberModel(reader: DocumentReader, member: Readonly<SwarmMember>, context: Context): Promise<string | undefined> {
	if (member.agy !== undefined) return `antigravity/${member.agy.model}`;
	return member.conversationId === undefined ? undefined : modelOf(reader, member.conversationId, context);
}

/** How to reach a member outside the board: its conversation, or its agy conversation. */
function memberWhere(member: Readonly<SwarmMember>): string {
	if (member.agy === undefined) return `conversation #${member.conversationId}`;
	return `Antigravity${member.agy.conversation === undefined ? "" : `, agy conversation ${member.agy.conversation}`}`;
}

async function statusText(reader: DocumentReader, swarm: Readonly<SwarmState>, context: Context): Promise<string> {
	const lines = [
		`Swarm ${swarm.title ? `"${swarm.title}"` : "(untitled)"}: ${swarm.active ? "running" : swarm.done ? "done" : "ended"}, ${swarm.posts.length} posts.`,
		swarm.goal === undefined ? undefined : `Goal: ${swarm.goal}`,
	];
	const members = Object.entries(swarm.members);
	if (members.length === 0) lines.push("No members yet.");
	for (const [name, member] of members) {
		const state = await memberState(reader, member, context);
		const unread = swarm.posts.filter((p) => p.seq > member.lastRead && p.from !== name).length;
		const traits = [
			state,
			`profile ${member.profile}`,
			await memberModel(reader, member, context),
			member.worktree === undefined ? "shares the main checkout" : `branch ${member.worktree.branch} at ${member.worktree.path}`,
			`read through #${member.lastRead}${unread > 0 ? ` (${unread} unread)` : ""}`,
			memberWhere(member),
		].filter(Boolean);
		lines.push(`- ${name}: ${traits.join("; ")}`);
	}
	for (const thread of swarm.threads) lines.push(`Thread "${thread.title}": ${thread.members.join(", ")}`);
	return lines.filter(Boolean).join("\n");
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

type MonitorState = { phase: "sleep"; alerted?: string } | { phase: "check"; alerted?: string };

/**
 * Wakes the coordinator when the swarm stalls: every member and the coordinator idle while it is not done. Plain code,
 * not a model: it sleeps durably between checks and alerts once per board state, so a quiet board is not nagged.
 */
export const SwarmMonitor = defineTask<null, MonitorState, null>({
	name: "pi-durable.swarm-monitor",
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: (task, runtime, context) =>
			runtime.sleepUntil(
				runtime.now() + MONITOR_SECONDS * 1000,
				{ phase: "check", ...(task.state.checkpoint.alerted === undefined ? {} : { alerted: task.state.checkpoint.alerted }) },
				context,
			),
		check: async (task, runtime, context) => {
			const swarm = await runtime.snapshot(Swarm, context);
			const finish = () => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			if (swarm === undefined || !swarm.active || swarm.monitor !== runtime.taskId || swarm.coordinator === undefined) return finish();
			const members = Object.entries(swarm.members).filter(([, member]) => member.killed !== true);
			const busy = async (id: ConversationId) => (await runtime.snapshot(LiveDoc, id, context))?.run !== undefined;
			let working = await busy(swarm.coordinator);
			for (const [, member] of members) working ||= await isWorking(runtime, member, context);
			// One alert per board state: killing or adding members alone does not alert again.
			const signature = String(swarm.next);
			let alerted = task.state.checkpoint.alerted;
			if (!working && signature !== alerted) {
				const last = swarm.posts.at(-1);
				const idle = members.map(([name, member]) => {
					const unread = swarm.posts.filter((p) => p.seq > member.lastRead && p.from !== name).length;
					return `${name} ${member.agy === undefined ? `#${member.conversationId}` : "(Antigravity)"} (read through #${member.lastRead}${unread > 0 ? `, ${unread} unread` : ""})`;
				});
				const report =
					"Stall: nobody in the swarm is working, and it is not done. " +
					(last === undefined ? "The board is empty. " : `Last post #${last.seq} from ${last.from}: "${oneLine(last.text, 160)}". `) +
					(idle.length > 0 ? `Idle members: ${idle.join(", ")}. ` : "No members. ") +
					"Act now: read the board, answer or re-brief who is waiting, add or kill members, or post [done] if the work is finished. " +
					"A member that answered without posting shows what it said with agents read #<conversation>.";
				const coordinator = await runtime.conversation(swarm.coordinator, context);
				await coordinator?.submit(
					{
						type: "input",
						content: `[swarm monitor] ${report}`,
						whenBusy: "followUp",
						onAbort: "keep",
						requestId: `swarm-stall:${runtime.taskId}:${signature}`,
						entry: { kind: MESSAGE_KIND, data: { from: "swarm monitor", text: report } },
					},
					context,
				);
				alerted = signature;
			}
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "sleep", ...(alerted === undefined ? {} : { alerted }) } }),
				context,
			);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// ─── Antigravity members ─────────────────────────────────────────────────────

type AgyRunInput = { name: string; started: number };
type AgyRunState = { phase: "run"; round: number } | { phase: "deliver"; round: number };

const completed = { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };

/**
 * Inside a commit: queue `seq` for the Antigravity members among `names`, and start a run for each that has none. Runs
 * belong to the coordinator's conversation, in the background, so they outlive whoever posted.
 */
async function queueAgy(tx: Tx, doc: SwarmState, names: readonly string[], seq: number): Promise<void> {
	for (const name of names) {
		const member = doc.members[name];
		if (member?.agy === undefined || member.killed === true || doc.coordinator === undefined) continue;
		if (!member.agy.queue.includes(seq)) member.agy.queue.push(seq);
		member.agy.run ??= await tx.createTask(
			SwarmAgyRun,
			{ name, started: doc.started ?? 0 },
			{ ownership: { kind: "conversation" }, conversationId: doc.coordinator, background: true },
		);
	}
}

/**
 * An Antigravity member at work: round after round, it gives agy every post the member has not seen (continuing one agy
 * conversation), posts agy's answer as the member, and wakes who that post mentions, until no post that mentions the
 * member is left. Each round's question is a memo and each post records its round, so a rerun after a crash asks agy
 * the same and posts once; an agy run a crash cut off runs again.
 */
export const SwarmAgyRun = defineTask<AgyRunInput, AgyRunState, null>({
	name: "pi-durable.swarm-agy",
	version: 1,
	initial: () => ({ phase: "run", round: 1 }),
	phases: {
		run: async (task, runtime, context) => {
			const { name, started } = task.input;
			const round = task.state.checkpoint.round;
			const swarm = await runtime.snapshot(Swarm, context);
			const member = swarm?.members[name];
			const gone = (doc: Readonly<SwarmState> | undefined) =>
				doc === undefined || (doc.started ?? 0) !== started || doc.members[name]?.agy === undefined || doc.members[name]!.killed === true;
			if (gone(swarm)) return settle(runtime, name, started, context);
			const agy = member!.agy!;
			const ask = await runtime.memo<AgyAsk>(`ask-${round}`, agyAsk(swarm!, name, member!), context);

			// Killing the member (or ending the swarm) stops agy; closing the Harness stops it too, and it runs again later.
			const killed = new AbortController();
			const poll = setInterval(() => {
				void runtime
					.snapshot(Swarm, context)
					.then((doc) => gone(doc) && killed.abort())
					.catch(() => {});
			}, AGY_KILL_POLL_MS);
			let outcome: AgyOutcome | undefined;
			let failure: string | undefined;
			try {
				outcome = await execAgy(
					{
						task: ask.prompt,
						model: agy.model,
						cwd: agy.cwd,
						allowWrites: agy.allowWrites,
						...(agy.conversation === undefined ? {} : { conversationId: agy.conversation }),
					},
					{ output: () => {}, details: async () => {} },
					withAbortSignal(killed.signal, withAbortSignal(runtime.signal, context)),
				);
			} catch (error) {
				if (runtime.signal.aborted) throw error;
				if (killed.signal.aborted) return settle(runtime, name, started, context);
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				clearInterval(poll);
			}

			let body = outcome?.answer ?? "";
			if (body.length > AGY_ANSWER_CHARS) body = `${body.slice(0, AGY_ANSWER_CHARS)}… (cut)`;
			if (!body) {
				const why = failure ?? `status ${outcome?.details.status ?? `exit ${outcome?.exitCode}`}${outcome?.details.notes.length ? `: ${oneLine(outcome.details.notes.join(" "), 300)}` : ""}`;
				body = `@coordinator [blocked] agy (${agy.model}) gave no answer (${why}).`;
			} else if (outcome?.failed === true) {
				body += `\n\n(agy ended with status ${outcome.details.status ?? `exit ${outcome.exitCode}`})`;
			}
			if (mentioned(swarm!, body, name).length === 0) body = `${ask.askers.map((asker) => `@${asker}`).join(" ")} ${body}`;
			const conversation = outcome?.details.conversationId;

			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Swarm);
				const self = doc.members[name];
				if ((doc.started ?? 0) !== started || self?.agy === undefined) return completed;
				if (conversation !== undefined) self.agy.conversation = conversation;
				self.lastRead = Math.max(self.lastRead, ask.newest);
				self.agy.queue = self.agy.queue.filter((seq) => seq > ask.newest);
				const posted = doc.posts.some((post) => post.by === runtime.taskId && post.round === round);
				// After [done] the board takes no posts, as for every member.
				if (!posted && doc.active && self.killed !== true) {
					const post: SwarmPost = { seq: doc.next, from: name, text: body, time: runtime.now(), by: runtime.taskId, round };
					const readers = mentioned(doc, body, name);
					const sent = wakes(doc, post, readers.filter((reader) => readerConversation(doc, reader) !== undefined));
					const unread = doc.posts.some((p) => p.seq > self.lastRead && p.from !== name);
					doc.next++;
					doc.posts.push(post);
					if (!unread) self.lastRead = post.seq;
					for (const { reader, caughtUp } of sent) if (caughtUp) setLastRead(doc, reader, post.seq);
					await queueAgy(tx, doc, readers, post.seq);
				}
				return { status: "running", checkpoint: { phase: "deliver", round } };
			}, context);
		},
		// A phase of its own, so a crash between the post and its wakes still sends them; request IDs keep each to one.
		deliver: async (task, runtime, context) => {
			const { name, started } = task.input;
			const round = task.state.checkpoint.round;
			const swarm = await runtime.snapshot(Swarm, context);
			const post = swarm?.posts.find((p) => p.by === runtime.taskId && p.round === round);
			if (swarm !== undefined && post !== undefined && (swarm.started ?? 0) === started) {
				const readers = mentioned(swarm, post.text, name).filter((reader) => readerConversation(swarm, reader) !== undefined);
				for (const { reader, draft } of wakes(swarm, post, readers)) {
					await (await runtime.conversation(readerConversation(swarm, reader)!, context))?.submit(draft, context);
				}
			}
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Swarm);
				const self = doc.members[name];
				if ((doc.started ?? 0) !== started || self?.agy === undefined) return completed;
				// Mentioned again while agy worked: another round.
				if (self.agy.queue.length > 0 && self.killed !== true) return { status: "running", checkpoint: { phase: "run", round: round + 1 } };
				if (self.agy.run === runtime.taskId) delete self.agy.run;
				return completed;
			}, context);
		},
	},
	abort: (task, runtime, context) =>
		runtime.commit(async (tx) => {
			const doc = await tx.doc(Swarm);
			const self = doc.members[task.input.name];
			if ((doc.started ?? 0) === task.input.started && self?.agy?.run === runtime.taskId) delete self.agy.run;
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context),
});

/** Ends a run that has nothing left to do: its member was killed, or its swarm is gone. */
function settle(
	runtime: { readonly taskId: TaskId; commit: (change: (tx: Tx) => Promise<typeof completed>, context: Context) => Promise<void> },
	name: string,
	started: number,
	context: Context,
): Promise<void> {
	return runtime.commit(async (tx) => {
		const doc = await tx.doc(Swarm);
		const self = doc.members[name];
		if ((doc.started ?? 0) === started && self?.agy !== undefined) {
			self.agy.queue = [];
			if (self.agy.run === runtime.taskId) delete self.agy.run;
		}
		return completed;
	}, context);
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const SwarmParameters = obj({
	action: oneOf(["status", "add", "kill", "title", "plan"], {
		description:
			"status: members, their state and branches; add: start workers (coordinator); kill: stop members for good " +
			"(coordinator); title: name the swarm (coordinator); plan: record the goal and threads for the board's overview (coordinator)",
	}),
	name: opt(str({ description: "add: the worker's name (lowercase, up to 24 of a-z 0-9 - _); kill: a member or group" })),
	brief: opt(str({ description: "add: everything the worker needs, posted on the board as @name <brief>" })),
	agent: opt(
		str({
			description:
				"add (required): the profile whose model fits this part (see agent_profiles); general copies your own model",
		}),
	),
	workspace: opt(
		oneOf(["inherit", "worktree"], {
			description: "add: inherit shares the main checkout; worktree gives each its own git worktree and branch (default: the profile's choice)",
		}),
	),
	thinking: opt(
		oneOf(["off", "minimal", "low", "medium", "high", "xhigh"], {
			description: "add: thinking level for these workers, replacing the profile's (default: the profile's)",
		}),
	),
	tasks: opt(arr(str(), { description: "add: one worker per item, named <name>-1..n, each given the brief plus its item" })),
	title: opt(str({ description: "title: 2 to 6 words" })),
	goal: opt(str({ description: "plan: the goal in one line" })),
	threads: opt(
		arr(obj({ title: str(), members: arr(str()) }), {
			description: "plan: up to six workstreams by outcome, each with the members on it",
		}),
	),
});

const PostParameters = obj({
	text: str({ description: "The post. @name wakes that member, @coordinator the coordinator, @all every member; refer to posts as #seq" }),
	wait: opt(bool({ description: "End your turn after posting, as swarm_wait does" })),
});

const ReadParameters = obj({
	since: opt(int({ description: "Posts after this #seq (default: after the newest post you have read)" })),
	limit: opt(int({ description: `How many posts at most (default ${READ_LIMIT})` })),
});

const WaitParameters = obj({});

/** The swarm tools, their monitor, and the prompt section that tells coordinator and members how to work. */
export function createSwarm(host: Host, orchestration: Extension): { extension: Extension; tools: ToolRegistration[] } {
	async function current(api: ToolExecutionApi, context: Context): Promise<Readonly<SwarmState>> {
		const swarm = await api.snapshot(Swarm, context);
		if (swarm?.coordinator === undefined) throw new Error("No swarm in this session; the user starts one with /swarm <task>.");
		return swarm;
	}

	async function requireRole(api: ToolExecutionApi, swarm: Readonly<SwarmState>): Promise<string> {
		const role = roleOf(swarm, api.conversationId);
		if (role === undefined) throw new Error("This conversation is not in the session's swarm.");
		return role;
	}

	const swarmTool = defineTool({
		name: "swarm",
		description:
			"The swarm itself: status shows its members, their state and branches; the coordinator adds workers (each its own " +
			"conversation, briefed on the board), kills them, titles the swarm and records its plan. Only works in a swarm " +
			"the user started with /swarm.",
		parameters: SwarmParameters,
		deferred: true,
		// add finds the members it made (keyed worktrees, createdBy) and the brief posts it wrote.
		replay: "safe",
		execute: async (args, api, context) => {
			const swarm = await current(api, context);
			const role = await requireRole(api, swarm);
			if (args.action === "status") return text(await statusText(api, swarm, context));
			if (role !== COORDINATOR) throw new Error(`Only the coordinator can ${args.action}; ask it on the board.`);
			switch (args.action) {
				case "title": {
					if (!args.title?.trim()) throw new Error("title needs a title");
					await api.commit(async (tx) => {
						(await tx.doc(Swarm)).title = oneLine(args.title!, 60);
					}, context);
					return text(`Swarm titled "${oneLine(args.title, 60)}".`);
				}
				case "plan": {
					const threads = (args.threads ?? []).slice(0, 6).map((thread) => ({
						title: oneLine(thread.title, 60),
						members: thread.members.map((name) => name.toLowerCase()),
					}));
					await api.commit(async (tx) => {
						const doc = await tx.doc(Swarm);
						if (args.goal !== undefined) doc.goal = oneLine(args.goal, 160);
						doc.threads = threads;
					}, context);
					return text(`Plan recorded: ${threads.length} thread${threads.length === 1 ? "" : "s"}.`);
				}
				case "kill":
					return kill(api, swarm, args.name, context);
				case "add":
					return add(api, swarm, args, context);
			}
		},
	});

	async function kill(api: ToolExecutionApi, swarm: Readonly<SwarmState>, name: string | undefined, context: Context) {
		const wanted = name?.trim().toLowerCase();
		if (!wanted || !NAME.test(wanted)) throw new Error("kill needs a member or group name");
		const names = Object.keys(swarm.members).filter((member) => member === wanted || inGroup(member, wanted));
		if (names.length === 0) throw new Error(`No member "${name}"; swarm status lists them.`);
		// Marked first, so no post wakes a member while it is being stopped. A rerun finds them marked and stops them again.
		await api.commit(async (tx) => {
			const doc = await tx.doc(Swarm);
			for (const member of names) {
				const record = doc.members[member];
				if (record === undefined) continue;
				record.killed = true;
				if (record.agy !== undefined) record.agy.queue = [];
			}
		}, context);
		const lines: string[] = [];
		for (const member of names) {
			const record = swarm.members[member]!;
			// An Antigravity member's run sees the mark and stops agy.
			if (record.conversationId !== undefined) await (await api.conversation(record.conversationId, context))?.abort(context);
			const worktree = record.worktree === undefined ? undefined : await summarizeWorktree(record.worktree, true);
			lines.push(`Killed ${member}.${worktree === undefined ? "" : ` ${worktree}`}`);
		}
		return text(lines.join("\n\n"));
	}

	/** The model a profile's member runs on (the profile's own, or the coordinator's), with its thinking level. */
	async function modelOfProfile(
		api: ToolExecutionApi,
		profile: AgentProfile,
		thinking: ModelThinkingLevel | undefined,
		context: Context,
	): Promise<string> {
		const resolved = host.profiles.resolveModel(profile);
		const own = await api.agent(context);
		const model = resolved.model ?? own.model;
		const level = thinking ?? resolved.thinkingLevel ?? own.thinkingLevel;
		return model === undefined ? `your model:${level}` : `${model.provider}/${model.modelId}:${level}`;
	}

	async function add(
		api: ToolExecutionApi,
		swarm: Readonly<SwarmState>,
		args: {
			name?: string;
			brief?: string;
			agent?: string;
			workspace?: "inherit" | "worktree";
			thinking?: ModelThinkingLevel;
			tasks?: string[];
		},
		context: Context,
	) {
		if (!swarm.active) throw new Error("The swarm has ended; the user starts a new one with /swarm.");
		const base = args.name?.trim().toLowerCase();
		if (!base || !NAME.test(base)) throw new Error("add needs a name: lowercase, up to 24 of a-z 0-9 - _, starting with a letter or digit");
		if (!args.brief?.trim()) throw new Error("add needs a brief: it is all the worker knows");
		const shards = args.tasks?.filter((task) => task.trim()) ?? [];
		const names = shards.length > 0 ? shards.map((_, index) => `${base}-${index + 1}`) : [base];
		if (names.length > MAX_ADD) throw new Error(`add starts at most ${MAX_ADD} workers at once`);
		for (const name of names) {
			if (!NAME.test(name)) throw new Error(`${name} is too long a name; pick a shorter one`);
			if (RESERVED.has(name)) throw new Error(`${name} is reserved; pick another name`);
			const known = swarm.members[name];
			if (known !== undefined && known.createdBy !== api.taskId) {
				throw new Error(
					known.killed === true
						? `${name} was killed and cannot come back; name the replacement ${name}-2 or similar.`
						: `The swarm already has a member named ${name}; message it on the board.`,
				);
			}
		}
		if (!args.agent?.trim()) {
			throw new Error(
				"add needs agent: the profile whose model fits this part (see agent_profiles). general copies your own model; " +
					`the profiles: ${host.profiles.all.map((profile) => profile.name).join(", ")}`,
			);
		}
		const profile = host.profiles.get(args.agent.trim());
		const agy = profile.runner === "antigravity";
		const agyModel = agyModelFor(profile.model ?? AGY_DEFAULT_MODEL, args.thinking);
		// Members hand work over through local branches the coordinator merges, so a sandbox profile joins in a worktree.
		const isolation =
			args.workspace === "worktree" || (args.workspace === undefined && profile.isolation.startsWith("sandbox"))
				? "worktree"
				: args.workspace === "inherit"
					? "none"
					: undefined;
		const cwd = (await api.agent(context)).cwd ?? host.cwd;
		type Prepared = {
			name: string;
			worktree?: WorktreeInfo;
			child?: Awaited<ReturnType<typeof prepareChild>>;
			cwd: string;
		};
		const prepared: Prepared[] = [];
		for (const [index, name] of names.entries()) {
			// Keyed by the call and position, so a rerun reuses the worktree.
			const key = `sw${api.taskId}-${index}`;
			if (agy) {
				if ((isolation ?? profile.isolation) !== "worktree") prepared.push({ name, cwd });
				else prepared.push({ name, ...(await ensureWorktree(cwd, host.sessionDir, host.sessionId, key)) });
				continue;
			}
			const spec: ChildSpec = {
				name,
				agent: profile.name,
				...(isolation === undefined ? {} : { isolation }),
				background: false,
				swarm: true,
				extraTools: memberTools,
				...(args.thinking === undefined ? {} : { thinking: args.thinking }),
			};
			const child = await prepareChild(host, orchestration, api, spec, key, context);
			prepared.push({ name, child, cwd: child.change.cwd ?? cwd, ...(child.identity.worktree === undefined ? {} : { worktree: child.identity.worktree }) });
		}
		const brief = args.brief.trim();
		const started = await api
			.commit(async (tx) => {
				const doc = await tx.doc(Swarm);
				if (!doc.active) throw new Error("The swarm has ended; the user starts a new one with /swarm.");
				const result: { name: string; post: SwarmPost; conversationId?: ConversationId }[] = [];
				for (const [index, item] of prepared.entries()) {
					const body = `@${item.name} ${brief}${shards.length > 0 ? `\n\nYour part: ${shards[index]!.trim()}` : ""}`;
					const existing = doc.members[item.name];
					// Another call in the same round took the name.
					if (existing !== undefined && existing.createdBy !== api.taskId) {
						throw new Error(`The swarm already has a member named ${item.name}; message it on the board.`);
					}
					if (existing !== undefined) {
						// A rerun after a crash: the member and its brief exist.
						const post = doc.posts.find((p) => p.by === api.taskId && p.text.startsWith(`@${item.name} `));
						if (post !== undefined) {
							result.push({
								name: item.name,
								post,
								...(existing.conversationId === undefined ? {} : { conversationId: existing.conversationId }),
							});
						}
						continue;
					}
					const post: SwarmPost = { seq: doc.next++, from: COORDINATOR, text: body, time: api.now(), by: api.taskId };
					doc.posts.push(post);
					const common = {
						profile: profile.name,
						createdBy: api.taskId,
						...(item.worktree === undefined ? {} : { worktree: item.worktree }),
					};
					if (item.child === undefined) {
						// Its first run is given the posts after lastRead: the brief onwards.
						doc.members[item.name] = {
							...common,
							lastRead: post.seq - 1,
							agy: {
								model: agyModel,
								cwd: item.cwd,
								// Writes only ever land in its own worktree.
								allowWrites: profile.allowWrites === true && item.worktree !== undefined,
								...(profile.instructions ? { instructions: profile.instructions } : {}),
								queue: [],
							},
						};
						await queueAgy(tx, doc, [item.name], post.seq);
						result.push({ name: item.name, post });
						continue;
					}
					// The member hangs off a background anchor of the coordinator: Esc there leaves it working.
					const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
					const id = await createChild(tx, anchor, item.child.change, item.child.identity);
					doc.members[item.name] = { ...common, conversationId: id, lastRead: post.seq };
					result.push({ name: item.name, post, conversationId: id });
				}
				if (doc.monitor === undefined) {
					doc.monitor = await tx.createTask(SwarmMonitor, null, { ownership: { kind: "conversation" }, background: true });
				}
				return result;
			}, context)
			.catch(async (error: unknown) => {
				// Nothing was committed: worktrees made for these workers would be left behind (unless an earlier run of
				// this call committed their members).
				const known = (await api.snapshot(Swarm, context))?.members ?? {};
				for (const item of prepared) {
					if (item.worktree === undefined || known[item.name]?.createdBy === api.taskId) continue;
					await summarizeWorktree(item.worktree, true);
				}
				throw error;
			});
		const latest = await api.snapshot(Swarm, context);
		// The brief is each member's first input; request IDs keep a rerun from sending it twice. Antigravity members
		// got theirs as a queued run.
		for (const member of started) {
			if (member.conversationId === undefined) continue;
			await (await api.conversation(member.conversationId, context))?.submit(
				wakeDraft(latest ?? swarm, member.post, member.name, 0),
				context,
			);
		}
		const model = agy ? `antigravity/${agyModel}` : await modelOfProfile(api, profile, args.thinking, context);
		const lines = started.map((member) => {
			const record = latest?.members[member.name];
			const where = record?.worktree === undefined ? "main checkout" : `branch ${record.worktree.branch}`;
			const who = record === undefined ? "" : `${memberWhere(record)}, `;
			const access = agy ? (record?.agy?.allowWrites === true ? ", may write" : ", read-only") : "";
			return `- ${member.name} (${who}${profile.name} on ${model}${access}, ${where}), briefed in #${member.post.seq}`;
		});
		return text(
			`Added ${started.length} worker${started.length === 1 ? "" : "s"}; each works from its brief and posts to the board:\n${lines.join("\n")}\n\n` +
				"End your turn (swarm_wait) once every initial worker is added; mentions of you wake you.",
		);
	}

	const postTool = defineTool({
		name: "post_message",
		description:
			"Post to the swarm's board. Members you mention (@name, @<group>, @all, @coordinator) are woken with the post; " +
			"posts without mentions wake nobody. The coordinator's \"[done] ...\" post closes the swarm.",
		parameters: PostParameters,
		deferred: true,
		replay: "safe",
		execute: async (args, api, context) => {
			const swarm = await current(api, context);
			const from = await requireRole(api, swarm);
			// A rerun of a post that closed the swarm still finds its post.
			const ended = () => new Error("The swarm has ended; nobody reads the board any more.");
			if (!swarm.active && !swarm.posts.some((p) => p.by === api.taskId)) throw ended();
			const body = args.text.trim();
			if (!body) throw new Error("post_message needs text");
			const readers = mentioned(swarm, body, from);
			// Conversation handles first: a commit's callback may not wait on other reads.
			const handles = new Map<string, NonNullable<Awaited<ReturnType<ToolExecutionApi["conversation"]>>>>();
			for (const reader of readers) {
				const id = readerConversation(swarm, reader);
				const handle = id === undefined ? undefined : await api.conversation(id, context);
				if (handle !== undefined) handles.set(reader, handle);
			}
			const agyReaders = readers.filter((reader) => swarm.members[reader]?.agy !== undefined);
			const closes = from === COORDINATOR && /^\s*\[done\]/iu.test(body);
			const { post, sent } = await api.commit(async (tx) => {
				const doc = await tx.doc(Swarm);
				const existing = doc.posts.find((p) => p.by === api.taskId);
				if (existing === undefined && !doc.active) throw ended();
				// A rerun after a crash finds its post and sends its wakes again; their request IDs keep each to one.
				const post: SwarmPost = existing ?? { seq: doc.next, from, text: body, time: api.now(), by: api.taskId };
				const sent = wakes(doc, post, [...handles.keys()]);
				if (existing === undefined) {
					const read = lastReadOf(doc, from);
					// The poster's mark moves past its own post only when it had read everything before it.
					const unread = doc.posts.some((p) => p.seq > read && p.from !== from);
					doc.next++;
					doc.posts.push(post);
					if (!unread) setLastRead(doc, from, post.seq);
					for (const { reader, caughtUp } of sent) if (caughtUp) setLastRead(doc, reader, post.seq);
					// Antigravity members are handed the post by a run, which posts their answer.
					if (!closes) await queueAgy(tx, doc, agyReaders, post.seq);
					if (closes) {
						doc.active = false;
						doc.done = true;
						// The coordinator is an ordinary agent again: /swarm added the tools to an unset filter.
						await configure(tx, api.conversationId, { modelTools: null });
					}
				}
				return { post, sent };
			}, context);
			for (const { reader, draft } of sent) await handles.get(reader)!.submit(draft, context);
			const woken = [...sent.map(({ reader }) => reader), ...(closes ? [] : agyReaders)];
			const result = [
				`Posted #${post.seq}.`,
				woken.length > 0 ? `Woke ${woken.join(", ")}.` : "Nobody was mentioned, so nobody was woken.",
				closes ? "The swarm is done; members stay until killed." : undefined,
			]
				.filter(Boolean)
				.join(" ");
			return { ...text(result), ...(args.wait === true ? { control: { terminate: true } } : {}) };
		},
	});

	const readTool = defineTool({
		name: "read_board",
		description: "Read the swarm's board, oldest first: by default every post after the newest one you have read.",
		parameters: ReadParameters,
		deferred: true,
		replay: "safe",
		execute: async (args, api, context) => {
			const swarm = await current(api, context);
			const reader = await requireRole(api, swarm);
			// Stored per call: a rerun after a crash returns the same posts, though the mark has moved.
			const since = await api.memo("since", args.since ?? lastReadOf(swarm, reader), context);
			const limit = Math.max(1, Math.min(args.limit ?? READ_LIMIT, 200));
			const after = swarm.posts.filter((post) => post.seq > since);
			const shown = after.slice(0, limit);
			const newest = shown.at(-1)?.seq;
			if (newest !== undefined) {
				await api.commit(async (tx) => setLastRead(await tx.doc(Swarm), reader, newest), context);
			}
			const header =
				shown.length === 0
					? `No posts after #${since} (${swarm.posts.length} on the board).`
					: `Posts #${shown[0]!.seq}–#${newest} of ${swarm.posts.length}${after.length > shown.length ? `; ${after.length - shown.length} more after these` : ""}:`;
			return text([header, ...shown.map(formatPost)].join("\n\n"));
		},
	});

	const waitTool = defineTool({
		name: "swarm_wait",
		description:
			"End your turn and sleep until a board post mentions you; costs nothing while asleep. Call it alone, as the " +
			"only call of your last step (a step that also runs other tools continues); after a post, prefer wait: true.",
		parameters: WaitParameters,
		deferred: true,
		replay: "safe",
		execute: async (_args, api, context) => {
			const swarm = await current(api, context);
			await requireRole(api, swarm);
			return { ...text("Waiting for a post that mentions you."), control: { terminate: true } };
		},
	});

	const memberTools = [swarmTool, postTool, readTool, waitTool];
	const extension = defineExtension({
		name: "pi-durable-swarm",
		tools: memberTools,
		tasks: [SwarmMonitor, SwarmAgyRun],
		sections: [
			section("swarm", async (input, context) => {
				const swarm = await input.read.snapshot(Swarm, context);
				if (swarm?.coordinator === undefined) return undefined;
				if (swarm.coordinator === input.conversationId) {
					// After the swarm, the coordinator works as an ordinary agent again.
					if (!swarm.active) return undefined;
					const model = await modelOf(input.read, input.conversationId, context);
					return model === undefined ? COORDINATOR_GUIDE : `${COORDINATOR_GUIDE}\n\nYou run on ${model}, and so do general members.`;
				}
				return roleOf(swarm, input.conversationId) === undefined ? undefined : WORKER_GUIDE;
			}),
		],
	});
	return { extension, tools: memberTools };
}

// ─── The TUI's side ──────────────────────────────────────────────────────────

const context = BACKGROUND_CONTEXT;

/**
 * Start a swarm with `coordinator` as its coordinator: the board is reset and the swarm tools are offered to it. Throws
 * while another swarm runs.
 */
export async function startSwarm(
	harness: Harness,
	coordinator: ConversationId,
	task: string,
	tools: readonly ToolRegistration[],
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Swarm);
		if (doc.active && doc.coordinator !== undefined) {
			throw new Error(`A swarm is running (coordinated by conversation #${doc.coordinator}); /swarm end ends it.`);
		}
		// A finished swarm's members would drop out of reach once the board is reset.
		const live = Object.entries(doc.members).filter(([, member]) => member.killed !== true);
		if (live.length > 0) {
			throw new Error(`The last swarm's members (${live.map(([name]) => name).join(", ")}) are still live; /swarm end stops them.`);
		}
		const fresh: SwarmState = {
			active: true,
			done: false,
			coordinator,
			task: oneLine(task, 400),
			started: Date.now(),
			threads: [],
			members: {},
			posts: [],
			next: 1,
		};
		for (const key of Object.keys(doc)) delete (doc as Record<string, unknown>)[key];
		Object.assign(doc, fresh);
	}, context);
	const conversation = await harness.conversation(coordinator, context);
	await conversation?.configure({ modelTools: { add: tools } }, context);
}

/** The input that makes a conversation the coordinator: a collapsed skill card, then the task. */
export function swarmInput(task: string): string {
	return (
		'<skill name="swarm" location="pi-durable:swarm">\n' +
		"Run this task as a swarm: you are its coordinator. The swarm section of your instructions says how; start by " +
		"splitting the task and adding the workers.\n</skill>\n\n" +
		task
	);
}

/**
 * End the session's swarm, also one the coordinator closed with [done]: stop every live member and the monitor, and
 * take the swarm tools back from the coordinator. The board and the members' branches are kept.
 */
export async function endSwarm(harness: Harness): Promise<string> {
	const swarm = await harness.snapshot(Swarm, context);
	const live = Object.entries(swarm?.members ?? {}).filter(([, member]) => member.killed !== true);
	if (swarm?.coordinator === undefined || (!swarm.active && live.length === 0)) throw new Error("No swarm is running");
	// Marked first, so no post wakes a member while it is being stopped.
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Swarm);
		doc.active = false;
		for (const [name] of live) {
			const member = doc.members[name];
			if (member === undefined) continue;
			member.killed = true;
			if (member.agy !== undefined) member.agy.queue = [];
		}
	}, context);
	const stopped: string[] = [];
	for (const [name, member] of live) {
		if (member.conversationId !== undefined) await (await harness.conversation(member.conversationId, context))?.abort(context);
		if (member.agy?.run !== undefined) await harness.abortTask(member.agy.run, context).catch(() => {});
		stopped.push(name);
	}
	if (swarm.monitor !== undefined) await harness.abortTask(swarm.monitor as TaskId, context).catch(() => {});
	// /swarm added the tools to an unset filter; unset again, the deferred swarm tools are no longer offered.
	await (await harness.conversation(swarm.coordinator, context))?.configure({ modelTools: null }, context);
	const branches = Object.entries(swarm.members).flatMap(([name, member]) =>
		member.worktree === undefined ? [] : [`${name}: ${member.worktree.branch}`],
	);
	return `Ended the swarm${stopped.length > 0 ? `, stopping ${stopped.join(", ")}` : ""}.${branches.length > 0 ? ` Branches kept: ${branches.join("; ")}.` : ""}`;
}

export interface SwarmBoardMember {
	readonly name: string;
	/** Absent for an Antigravity member. */
	readonly conversationId?: ConversationId;
	readonly profile: string;
	readonly state: string;
	readonly model?: string;
	readonly branch?: string;
	readonly lastRead: number;
	/** It posted [done] since its last brief. */
	readonly finished: boolean;
}

export interface SwarmBoardView {
	readonly title?: string;
	readonly goal?: string;
	readonly task?: string;
	readonly status: "running" | "done" | "ended";
	readonly coordinator: ConversationId;
	readonly members: readonly SwarmBoardMember[];
	readonly threads: readonly { title: string; members: string[] }[];
	readonly posts: readonly SwarmPost[];
}

/** The board as the TUI shows it; undefined when the session has no swarm. */
export async function loadSwarmBoard(harness: Harness): Promise<SwarmBoardView | undefined> {
	const swarm = await harness.snapshot(Swarm, context);
	if (swarm?.coordinator === undefined) return undefined;
	const members: SwarmBoardMember[] = [];
	for (const [name, member] of Object.entries(swarm.members)) {
		const model = await memberModel(harness, member, context);
		const own = swarm.posts.filter((post) => post.from === name);
		const briefed = swarm.posts.findLast((post) => post.from === COORDINATOR && mentioned(swarm, post.text, COORDINATOR).includes(name));
		const done = own.findLast((post) => /\[done\]/iu.test(post.text));
		members.push({
			name,
			...(member.conversationId === undefined ? {} : { conversationId: member.conversationId }),
			profile: member.profile,
			state: await memberState(harness, member, context),
			...(model === undefined ? {} : { model }),
			...(member.worktree === undefined ? {} : { branch: member.worktree.branch }),
			lastRead: member.lastRead,
			finished: done !== undefined && (briefed === undefined || done.seq > briefed.seq),
		});
	}
	return {
		...(swarm.title === undefined ? {} : { title: swarm.title }),
		...(swarm.goal === undefined ? {} : { goal: swarm.goal }),
		...(swarm.task === undefined ? {} : { task: swarm.task }),
		status: swarm.active ? "running" : swarm.done ? "done" : "ended",
		coordinator: swarm.coordinator,
		members,
		threads: swarm.threads,
		posts: swarm.posts,
	};
}

/** The agents panel's line while a swarm runs: cheap, since the panel refreshes on every frame of the shown conversation. */
export async function swarmActivity(harness: Harness): Promise<{ label: string; status: string } | undefined> {
	const swarm = await harness.snapshot(Swarm, context);
	if (swarm?.coordinator === undefined || !swarm.active) return undefined;
	const live = Object.values(swarm.members).filter((member) => member.killed !== true);
	let working = 0;
	for (const member of live) if (await isWorking(harness, member, context)) working++;
	const last = swarm.posts.at(-1);
	const status = [
		`${swarm.posts.length} posts`,
		`${working}/${live.length} at work`,
		last === undefined ? undefined : `#${last.seq} ${last.from}: ${oneLine(last.text, 80)}`,
	]
		.filter(Boolean)
		.join(" · ");
	return { label: `swarm ${swarm.title ?? "(untitled)"}`, status };
}

