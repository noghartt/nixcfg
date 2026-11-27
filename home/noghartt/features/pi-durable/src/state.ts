import type { ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";

/** Where a subagent works when it is isolated: its own git worktree and branch, cut from `base`. */
export type WorktreeInfo = { path: string; branch: string; base: string };

/**
 * An sbx sandbox a conversation's tools run in (`src/sandbox.ts`). Found again by `name` on `provider` (a provider id from
 * the sbx config), so a reopened session reattaches to it.
 */
export type SandboxRef = {
	name: string;
	provider: string;
	kind: string;
	/** Absolute home directory on the sandbox. */
	home: string;
	/** Absolute path of the checkout on the sandbox; absent without one. */
	workdir?: string;
	/** The local repository it was seeded from: local paths below it map into `workdir`, and pulls land in it. */
	localRoot?: string;
	/** The commit it was seeded at. */
	base?: string;
	/** The branch the agent works on there. */
	branch?: string;
	/** Whose it is: the whole session's, a subagent's (pulled back when it answers), or one the user attached by name. */
	purpose: "session" | "subagent";
	/** Kept after its work is pulled back. */
	keep?: boolean;
	/**
	 * A git worktree inside another conversation's sandbox (a subagent of a sandboxed session): the main checkout it
	 * belongs to there. The sandbox is not this conversation's to remove; its branch stays in that checkout.
	 */
	worktreeOf?: string;
};

/**
 * Who a conversation is, written by the commit that creates it. Absent for main and for branches (forks start from the
 * initial value, so a branch of a subagent is not that subagent).
 */
export type IdentityState = {
	name?: string;
	profile?: string;
	/** The conversation that started it. */
	parent?: number;
	background?: boolean;
	worktree?: WorktreeInfo;
	/** Notes from making its workspace (uncommitted local changes left behind, a kind not honoured), for its result. */
	warnings?: string[];
	/** Its own sandbox (isolation `sandbox[:kind]`): its tools run there. */
	sandbox?: SandboxRef;
	/** A swarm member: it talks through the board, and its answers go nowhere. */
	swarm?: boolean;
};

export const Identity = defineDoc<IdentityState>({
	kind: "pi-durable.identity",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => false,
});

export type BackgroundAgent = {
	conversationId: ConversationId;
	profile?: string;
	/** The tool call that created it, so a rerun after a crash finds it instead of starting another. */
	createdBy: TaskId;
	/** Answers already reported back: several messages can end in one answer, reported once. */
	reported: EntryId[];
};

export type WatcherRecord = { taskId: TaskId; name: string; kind: string; description: string };

/** A conversation's background subagents (by name) and watchers (by task ID). Forks start without them. */
export type BackgroundState = {
	agents: Record<string, BackgroundAgent>;
	watchers: Record<string, WatcherRecord>;
};

export const Background = defineDoc<BackgroundState>({
	kind: "pi-durable.background",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, watchers: {} }),
	checkpointWhen: () => false,
});

/**
 * Which sandbox a conversation's tools run in, when it has its own. Unlike Identity, forks keep it, so a /tree branch
 * of a sandbox subagent keeps working where the subagent did instead of falling back to the session or this machine.
 */
export type SandboxBindingState = { ref?: SandboxRef };

export const SandboxBinding = defineDoc<SandboxBindingState>({
	kind: "pi-durable.sandbox-binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
	checkpointWhen: () => false,
});

/** The whole session's sandbox (`--sandbox`, `/sandbox`): every conversation without its own runs its tools there. */
export type SessionSandboxState = {
	ref?: SandboxRef;
	/**
	 * A sandbox being made or attached. While set (also after a crash cut it short) or after it `failed`, tools refuse to
	 * run rather than run on this machine, and prompts are not sent.
	 */
	pending?: { name: string; kind?: string; since: number };
	failed?: string;
};

export const SessionSandbox = defineDoc<SessionSandboxState>({
	kind: "pi-durable.sandbox",
	version: 1,
	scope: "session",
	initial: () => ({}),
	checkpointWhen: () => false,
});

/** Labels on entries, by entry ID, for the whole session: the tree shows them and references find entries by them. */
export type LabelsState = { labels: Record<string, string> };

export const Labels = defineDoc<LabelsState>({
	kind: "pi-durable.labels",
	version: 1,
	scope: "session",
	initial: () => ({ labels: {} }),
	checkpointWhen: () => false,
});

/**
 * An Antigravity member: no conversation, but one agy conversation continued across runs. A post that mentions it is
 * queued, and a run (a `pi-durable.swarm-agy` task) gives agy every post it has not seen and posts agy's answer.
 */
export type SwarmAgyMember = {
	model: string;
	cwd: string;
	allowWrites: boolean;
	/** The profile's instructions, as they were when it joined. */
	instructions?: string;
	/** agy's conversation ID, once the first run started it. */
	conversation?: string;
	/** The live run; absent while it waits on the board. */
	run?: TaskId;
	/** Posts that mention it and that no run has answered yet. */
	queue: number[];
};

export type SwarmMember = {
	/** Absent for an Antigravity member, which has none. */
	conversationId?: ConversationId;
	agy?: SwarmAgyMember;
	profile: string;
	/** The `swarm add` call that made it, so a rerun after a crash finds it. */
	createdBy: TaskId;
	/** The newest post it has read (or was woken with). */
	lastRead: number;
	worktree?: WorktreeInfo;
	killed?: boolean;
};

export type SwarmPost = {
	seq: number;
	from: string;
	text: string;
	time: number;
	/** The `post_message` call (or Antigravity run) that wrote it, so a rerun does not post twice. */
	by?: TaskId;
	/** Which of its run's rounds an Antigravity member's post answers. */
	round?: number;
};

export type SwarmThread = { title: string; members: string[] };

/**
 * The session's swarm: its coordinator, members by name, and the board, an append-only list of numbered posts. One swarm
 * per session at a time; `/swarm` starts it and `/swarm end` (or the coordinator's `[done]` post) ends it.
 */
export type SwarmState = {
	active: boolean;
	done: boolean;
	coordinator?: ConversationId;
	task?: string;
	title?: string;
	goal?: string;
	threads: SwarmThread[];
	members: Record<string, SwarmMember>;
	posts: SwarmPost[];
	next: number;
	monitor?: TaskId;
	started?: number;
	/** The newest post the coordinator has read (or was woken with). */
	coordinatorRead?: number;
};

export const Swarm = defineDoc<SwarmState>({
	kind: "pi-durable.swarm",
	version: 1,
	scope: "session",
	initial: () => ({ active: false, done: false, threads: [], members: {}, posts: [], next: 1 }),
	// Every post is a delta; a full base now and then keeps replay short.
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** Entry kinds of inputs that did not come from the user; the model sees their content as a user message. */
export const REPORT_KIND = "pi-durable.report";
export const MESSAGE_KIND = "pi-durable.message";

/** What the TUI shows for a report or message input. */
export type NoteData = { from: string; text: string; conversationId?: number; session?: string };
