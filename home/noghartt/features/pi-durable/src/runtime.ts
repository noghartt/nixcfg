import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type AuthInteraction,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type ConversationView,
	type ConversationWatch,
	type ConversationWindow,
	type Cursor,
	type EntryId,
	type EntryRecord,
	Harness,
	LiveDoc,
	type LiveState,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Submission,
	type TaskGraph,
	type TaskGraphWatch,
	type TaskId,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CredentialSynchronizationError, ModelRuntime, type SessionEntry, type SessionTreeNode } from "#pi/index.js";
import {
	extraAccountNames,
	loginAccount,
	MAIN_ACCOUNT,
	openAccounts,
	POOLED_PROVIDER,
	recordLogin,
	removeAccount,
} from "./accounts.ts";
import { type LoginProvider, loadAccounts, type ProviderAccountsView } from "./accounts-view.ts";
import { createAntigravity } from "./antigravity.ts";
import { type BtwProgress, runBtw } from "./btw.ts";
import { Approvals } from "./approvals.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "./harness-setup.ts";
import type { Host } from "./host.ts";
import { createMessaging, expandReferences, startInbox } from "./messaging.ts";
import { createResearch } from "./research.ts";
import { AgentProfiles } from "./profiles.ts";
import { PiResources } from "./resources.ts";
import {
	type LiveStatus,
	readMeta,
	removeSession,
	type SessionTarget,
	selectSession,
	writeMeta,
} from "./sessions.ts";
import {
	markSessionSandboxPending,
	parseSandboxArgument,
	Sandboxes,
	sandboxTarget,
	sessionSandboxProblem,
	setSessionSandbox,
} from "./sandbox.ts";
import { createSandboxTools } from "./sandbox-tools.ts";
import { Background, Identity, Labels, SessionSandbox } from "./state.ts";
import { loadStatus, type StatusReport, usageSince } from "./status.ts";
import { closeBackgroundSandboxes, createOrchestration } from "./subagent.ts";
import { createSwarm, endSwarm, loadSwarmBoard, startSwarm, type SwarmBoardView, swarmActivity, swarmInput } from "./swarm.ts";
import { createSpillExtension } from "./spill.ts";
import { createWatchExtension } from "./watch.ts";

const context = BACKGROUND_CONTEXT;

/**
 * The TUI renders the whole transcript, so the view's window holds every entry instead of Durable's default newest 50.
 * A local SQLite session stays small enough for that.
 */
const WHOLE_TRANSCRIPT: ConversationWindow = { min: 1_000_000, max: 1_000_000 };

/** Start a watch and forward each new value; Durable's watches never send failed calls. */
function follow<T>(
	watch: { start(listener: (call: { kind: string; value?: T }) => Promise<void>): void },
	on: (value: T) => void,
): void {
	watch.start(async (call) => {
		if (call.kind === "value") on(call.value as T);
	});
}

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
	readonly reasoning: boolean;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/**
 * A conversation the user can switch to. `main` is the session's root, a `branch` a fork of another (made by /tree,
 * /fork, or /clone), and a `subagent` one a subagent call created.
 */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly kind: "main" | "branch" | "subagent";
	readonly label: string;
	/** The first user message, for a subagent its task. */
	readonly title?: string;
	/** A subagent's name and profile. */
	readonly name?: string;
	readonly profile?: string;
	readonly background?: boolean;
}

/** Something working besides the shown conversation: another conversation with a run going, or a watcher. */
export interface ActivityItem {
	readonly key: string;
	readonly kind: "conversation" | "watcher" | "swarm";
	readonly label: string;
	readonly status: string;
	readonly model?: string;
	readonly cost?: number;
	readonly conversationId?: ConversationId;
	readonly taskId?: TaskId;
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string; readonly name?: string };
	/** The conversation shown and talked to. */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** The live task graph while the task panel is open. */
	readonly tasks?: TaskGraph;
	/** Other conversations at work and running watchers, for the agents panel. */
	readonly activity: readonly ActivityItem[];
	/** The Claude account requests go to; set only with more than one account (`pi-durable accounts`). */
	readonly account?: string;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** The session as pi's tree selector shows it: one node per message or summary, branches where forks start. */
export interface SessionTree {
	readonly tree: SessionTreeNode[];
	readonly leafId: string | null;
	/** Main and its branches, oldest first, for the overview above /tree and /fork. */
	readonly branches: readonly BranchSummary[];
}

/** One line of the branch overview. */
export interface BranchSummary {
	readonly id: ConversationId;
	readonly label: string;
	readonly shown: boolean;
	/** Inputs in its whole history, and how many of them it added after its fork point. */
	readonly messages: number;
	readonly own: number;
	/** Its first own input. */
	readonly title?: string;
	/** Where it forked: the parent's label and how many inputs it inherited. */
	readonly from?: { readonly label: string; readonly after: number };
}

/** What the TUI may ask for. */
export interface DurableController {
	/** Prompt when idle; otherwise steer or queue a follow-up. Skills and prompt templates expand here. */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setThinking(level: ModelThinkingLevel): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. */
	switchConversation(id: ConversationId): Promise<void>;
	tree(): Promise<SessionTree>;
	/**
	 * Continue from a tree node, like pi's /tree: the shown branch moves there, forking when it is not some branch's
	 * end. A user message is left out and returned, for the editor, so it can be edited and sent again.
	 */
	navigate(nodeId: string): Promise<string | undefined>;
	/** A fork of the shown branch at its end, switched to. */
	clone(): Promise<void>;
	/** Label a tree node (an entry ID), or clear its label. */
	setLabel(nodeId: string, label: string | undefined): Promise<void>;
	/** Label the newest entry of the shown conversation. */
	labelLatest(label: string): Promise<void>;
	/** This session's labels, for `@label:` completion. */
	labels(): Promise<string[]>;
	/** Stop an activity item: abort a conversation's work or end a watcher. */
	stop(item: ActivityItem): Promise<void>;
	rename(name: string): Promise<void>;
	reload(): Promise<void>;
	trust(): Promise<void>;
	notify(level: Notice["level"], message: string): void;
	/** Start a swarm with the shown conversation as its coordinator, and give it the task. */
	startSwarm(task: string): Promise<void>;
	/** Stop the running swarm's members and monitor. */
	endSwarm(): Promise<void>;
	/** The session's swarm board; undefined without a swarm. */
	swarmBoard(): Promise<SwarmBoardView | undefined>;
	/** Answer a side question about the shown conversation in one tool-less request that is not kept (/btw). */
	btw(question: string, signal: AbortSignal, onProgress: (progress: BtwProgress) => void): Promise<void>;
	/** Subscription limits, today's spend across sessions, and session counts (/status). */
	status(): Promise<StatusReport>;
	/** Every login by provider, with emails and blocks (/accounts). */
	accounts(): Promise<ProviderAccountsView[]>;
	/** The extra Claude accounts, for completion. */
	accountNames(): readonly string[];
	/** The providers pi signs in to through OAuth, for `/accounts login`. */
	loginProviders(): readonly LoginProvider[];
	/**
	 * Sign in through `interaction` (pi's login dialog): an extra Claude account, which joins the fallback at once, or
	 * the agent dir to a provider, whose models join /model. Failures and cancels end as notices.
	 */
	login(target: LoginTarget, interaction: AuthInteraction): Promise<void>;
	/** Delete an extra Claude account and stop falling back to it. */
	removeAccount(name: string): Promise<void>;
	/**
	 * The session's sandbox (`/sandbox`): "" shows it, "off" detaches it, a kind makes (or reattaches) the session's
	 * sandbox of that kind, `kind:name` one with that name, anything else attaches an existing sandbox by name.
	 */
	sandbox(argument: string): Promise<void>;
	/** sbx kinds, for completion. */
	sandboxKinds(): readonly string[];
}

export type LoginTarget =
	| { readonly kind: "account"; readonly name: string }
	| { readonly kind: "provider"; readonly id: string };

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly target: SessionTarget;
	/** `--sandbox[=kind[:name]]`: run the session's tools in a sandbox; "" for the default kind. */
	readonly sandbox?: string;
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	/** pi's settings, skills, and prompt templates for the session's directory. */
	readonly resources: PiResources;
	/** Questions tools put to the user; the TUI answers them. */
	readonly approvals: Approvals;
	readonly profiles: AgentProfiles;
	close(): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

/** A placed input: `pi.user`, or an application entry whose model is one user message. */
export function isInput(entry: EntryRecord): boolean {
	if (entry.kind === "pi.user") return true;
	return !entry.kind.startsWith("pi.") && entry.model?.length === 1 && entry.model[0]!.role === "user";
}

export function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function inputText(entry: EntryRecord | undefined): string | undefined {
	const message = entry?.model?.[0];
	return message?.role === "user" ? userText(message.content) : undefined;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Every entry a conversation wrote itself, oldest first; a fork's inherited history belongs to its parents. */
async function ownEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
		for (const entry of page.items) if (entry.conversationId === conversation.id) entries.push(entry);
		cursor = page.next;
	} while (cursor !== undefined);
	return entries;
}

/** The entry just before `id` in a conversation's visible history. */
async function entryBefore(conversation: Conversation, id: EntryId): Promise<EntryRecord | undefined> {
	if (id <= 1) return undefined;
	const page = await conversation.entries(
		{ maxEntryId: (id - 1) as EntryId, order: "descending" },
		1,
		undefined,
		context,
	);
	return page.items[0];
}

const timestampOf = (entry: EntryRecord): string => {
	const time = (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp;
	return new Date(time ?? 0).toISOString();
};

/** The tree selector's form of an entry; `undefined` for bookkeeping the tree does not show. */
function treeEntry(entry: EntryRecord, id: string, parentId: string | null): SessionEntry | undefined {
	const message = entry.model?.[0];
	const base = { id, parentId, timestamp: timestampOf(entry) };
	if (entry.kind === "pi.compaction") {
		return { ...base, type: "compaction", summary: inputText(entry) ?? "", firstKeptEntryId: "", tokensBefore: 0 };
	}
	if (message === undefined) return undefined;
	if (isInput(entry) || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
		return { ...base, type: "message", message } as SessionEntry;
	}
	return undefined;
}

export async function openDurable(options: OpenDurableOptions): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.target);
	const sandboxes = new Sandboxes();
	const envs = new ExecutionEnvs(location.cwd, sandboxes);
	let harness: Harness | undefined;
	try {
		const modelRuntime = await ModelRuntime.create();
		const resources = await PiResources.load(location.cwd);
		const settingsManager = resources.settings;
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createCodingRegistry(resources);
		const profiles = new AgentProfiles(resources, modelRuntime);
		// Claude requests fall back across the agent dir's accounts; with one, they go straight to modelRuntime.
		const accounts = openAccounts(modelRuntime);
		const host: Host = {
			sessionId: location.id,
			sessionDir: location.directory,
			cwd: location.cwd,
			profiles,
			sandboxes,
			harness: undefined,
		};
		const { orchestration, tasks: agentTasks } = createOrchestration(host);
		registry.install(agentTasks);
		registry.install(orchestration);
		const swarm = createSwarm(host, orchestration);
		registry.install(swarm.extension);
		registry.install(createWatchExtension(location.cwd));
		registry.install(createMessaging(host));
		registry.install(createResearch(location.cwd));
		const approvals = new Approvals();
		registry.install(createSandboxTools(host, approvals));
		registry.install(createAntigravity(approvals));
		// Last, so its afterTool hook sees the text the Harness is about to bound.
		registry.install(createSpillExtension(envs.env));

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: accounts.models,
				registry,
				settings,
				env: envs.env,
				onReport: (error) => report(error),
			},
			context,
		);
		const opened = harness;
		host.harness = opened;
		const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime) : undefined;
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});
		const meta = await readMeta(location.directory);
		// Reopen on the branch the session was left on.
		const saved =
			meta.current === undefined ? undefined : await opened.conversation(meta.current as ConversationId, context);
		let current: Conversation = saved ?? root;
		let conversation: ConversationWatch = await current.watch(context, WHOLE_TRANSCRIPT);

		const records = async (): Promise<ConversationRecord[]> => {
			const found: ConversationRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
				found.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			return found;
		};
		const summarize = async (record: ConversationRecord): Promise<ConversationSummary> => {
			const kind = record.id === ROOT_CONVERSATION_ID ? "main" : record.owner !== undefined ? "subagent" : "branch";
			const identity = await opened.snapshot(Identity, record.id, context);
			const label =
				kind === "main"
					? "main"
					: identity?.name !== undefined
						? `${identity.name} #${record.id}`
						: `${kind} ${record.id}`;
			const handle = (await opened.conversation(record.id, context))!;
			const first = (await ownEntries(handle)).find(isInput);
			const title = inputText(first);
			return {
				id: record.id,
				kind,
				label,
				...(title === undefined ? {} : { title: oneLine(title) }),
				...(identity?.name === undefined ? {} : { name: identity.name }),
				...(identity?.profile === undefined ? {} : { profile: identity.profile }),
				...(identity?.background === true ? { background: true } : {}),
			};
		};
		const models = (): ModelSummary[] =>
			modelRuntime.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				reasoning: Boolean(model.reasoning),
			}));

		let state: DurableView = {
			session: {
				id: location.id,
				directory: location.directory,
				cwd: location.cwd,
				...(meta.name === undefined ? {} : { name: meta.name }),
			},
			conversation: conversation.value,
			conversations: await Promise.all((await records()).map(summarize)),
			models: models(),
			notices: [],
			activity: [],
			...(accounts.pool.size > 1 ? { account: accounts.pool.active } : {}),
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		// Commit listeners and Chord frames call this on the Session line; rendering runs afterwards, once per burst.
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		{
			const pool = accounts.pool;
			pool.onNotice = notice;
			// The footer names the account only while there is more than one; /accounts add and remove change that.
			pool.onChange = () => {
				const account = pool.size > 1 ? pool.active : undefined;
				if (account !== state.account) update({ account } as Partial<DurableView>);
			};
		}
		// One line for every skill or template that failed to load; they are listed in full by /session.
		const warnResources = (): void => {
			const problems = resources.diagnostics;
			if (problems.length === 0) return;
			notice("warning", `${problems.length} skill/prompt warning(s), /session lists them: ${problems[0]}`);
		};
		// Set once the task graph is watched; activity reads it. Close stops the refreshes.
		let taskWatch: TaskGraphWatch | undefined;
		let closing: Promise<void> | undefined;
		const watchConversation = (watch: ConversationWatch): void =>
			follow<ConversationView>(watch, (value) => {
				if (watch !== conversation) return;
				update({ conversation: value });
				requestActivity();
			});
		watchConversation(conversation);

		// What works besides the shown conversation, for the agents panel and the dashboard (meta.json `live`). Other
		// conversations' streams reach no watch here, so this polls while any of them works.
		let activityRun: Promise<void> | undefined;
		let activityAgain = false;
		let activityPoll: NodeJS.Timeout | undefined;
		let lastLive = "";
		const refreshActivity = async (): Promise<void> => {
			const items: ActivityItem[] = [];
			let running = 0;
			let others = 0;
			for (const summary of state.conversations) {
				const live = await opened.snapshot(LiveDoc, summary.id, context);
				if (live?.run === undefined) continue;
				running++;
				if (summary.id === current.id) continue;
				others++;
				const agent = await opened.snapshot(AgentDoc, summary.id, context);
				const usage = await opened.snapshot(UsageDoc, summary.id, context);
				items.push({
					key: `c${summary.id}`,
					kind: "conversation",
					label: summary.label,
					status: liveStatus(live),
					...(agent?.model === undefined ? {} : { model: `${agent.model.provider}/${agent.model.modelId}` }),
					cost: totalCost(usage),
					conversationId: summary.id,
				});
			}
			let watchers = 0;
			for (const summary of state.conversations) {
				const background = await opened.snapshot(Background, summary.id, context);
				for (const watcher of Object.values(background?.watchers ?? {})) {
					if (taskWatch?.value.tasks[String(watcher.taskId)] === undefined) continue;
					watchers++;
					items.push({
						key: `w${watcher.taskId}`,
						kind: "watcher",
						label: `watch ${watcher.name}`,
						status: `${watcher.kind} ${watcher.description}`,
						taskId: watcher.taskId,
					});
				}
			}
			const swarmLine = await swarmActivity(opened);
			if (swarmLine !== undefined) items.unshift({ key: "swarm", kind: "swarm", ...swarmLine });
			if (JSON.stringify(items) !== JSON.stringify(state.activity)) update({ activity: items });
			if (others > 0) activityPoll ??= setTimeout(() => ((activityPoll = undefined), requestActivity()), 1000);

			const shown = state.conversation.docs["pi.live"] as LiveState | undefined;
			const model = agentOf(state.conversation).model;
			const answer = lastAnswer(state.conversation);
			const status: Omit<LiveStatus, "updated"> = {
				pid: process.pid,
				busy: running > 0,
				running,
				conversations: state.conversations.length,
				watchers,
				...(model === undefined ? {} : { model: `${model.provider}/${model.modelId}` }),
				cost: totalCost(await opened.usage(context)),
				...(shown?.run !== undefined
					? { activity: liveStatus(shown) }
					: answer === undefined
						? {}
						: { activity: oneLine(answer).slice(0, 160) }),
			};
			const key = JSON.stringify(status);
			if (key !== lastLive) {
				lastLive = key;
				await writeMeta(location.directory, { live: { ...status, updated: new Date().toISOString() } });
			}
		};
		const countWorking = async (): Promise<number> => {
			let working = 0;
			for (const summary of state.conversations) {
				if ((await opened.snapshot(LiveDoc, summary.id, context))?.run !== undefined) working++;
			}
			return working;
		};
		const requestActivity = (): void => {
			if (closing !== undefined || taskWatch === undefined) return;
			if (activityRun !== undefined) {
				activityAgain = true;
				return;
			}
			activityRun = refreshActivity()
				.catch((error) => report(error))
				.finally(() => {
					activityRun = undefined;
					if (activityAgain) {
						activityAgain = false;
						requestActivity();
					}
				});
		};

		// Durable 1.6 has no commit feed, so new branches and subagents are found by rescanning: when the task graph
		// changes (every subagent conversation is created by a task) and after this process forks. Titles fill in once a
		// conversation has an input.
		let scanning: Promise<void> | undefined;
		let rescan = false;
		const scanConversations = async (): Promise<void> => {
			let conversations = state.conversations;
			for (const record of await records()) {
				const known = conversations.find((summary) => summary.id === record.id);
				if (known?.title !== undefined) continue;
				const found = await summarize(record);
				if (known === undefined) conversations = [...conversations, found];
				else if (found.title !== undefined) conversations = conversations.map((s) => (s.id === record.id ? found : s));
			}
			if (conversations !== state.conversations) update({ conversations });
		};
		const requestScan = (): void => {
			if (scanning !== undefined) {
				rescan = true;
				return;
			}
			scanning = scanConversations()
				.catch((error) => report(error))
				.finally(() => {
					scanning = undefined;
					if (rescan) {
						rescan = false;
						requestScan();
					}
				});
		};

		// The task graph is always watched (it drives the rescan); the panel only decides whether the TUI sees it.
		let showTasks = false;
		const graphWatch: TaskGraphWatch = await opened.watchTaskGraph(context);
		taskWatch = graphWatch;
		follow<TaskGraph>(graphWatch, (value) => {
			requestScan();
			requestActivity();
			if (showTasks) update({ tasks: value });
		});

		let queue = Promise.resolve();
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = <T>(operation: () => Promise<T>): Promise<T | undefined> => {
			const run = queue.then(operation);
			queue = run.then(
				() => {},
				() => {},
			);
			return run.catch((error) => {
				fail(error);
				return undefined;
			});
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined) throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		/** Show `next`; the session reopens on it. */
		const show = async (next: Conversation): Promise<void> => {
			if (next.id === current.id) return;
			const nextWatch = await next.watch(context, WHOLE_TRANSCRIPT);
			const previous = conversation;
			current = next;
			conversation = nextWatch;
			await previous.stop();
			watchConversation(nextWatch);
			update({ conversation: nextWatch.value });
			await writeMeta(location.directory, { current: next.id });
		};
		const fork = async (from: Conversation, at: EntryId): Promise<void> => {
			await show(await from.fork(at, { ownership: { kind: "ownerless" } }, context));
			requestScan();
		};

		// The tree: main and its branches (subagents are listed by /agents). A branch hangs off the node at or before its
		// fork point; each conversation's end is where navigating there just switches to it.
		const buildTree = async () => {
			const nodes = new Map<string, SessionTreeNode>();
			const roots: SessionTreeNode[] = [];
			/** Per entry ID, the nearest shown node at or before it. */
			const nearest = new Map<EntryId, string | null>();
			const entries = new Map<string, EntryRecord>();
			/** Per conversation, its last visible entry. */
			const ends = new Map<ConversationId, EntryId | undefined>();
			/** Per entry ID, how many inputs its conversation's history holds through it. */
			const inputsAt = new Map<EntryId, number>();
			const summaries: BranchSummary[] = [];
			const branchLabel = (id: ConversationId) => (id === ROOT_CONVERSATION_ID ? "main" : `branch ${id}`);
			const branches = (await records())
				.filter((record) => record.owner === undefined)
				.sort((left, right) => left.id - right.id);
			const labels = (await opened.snapshot(Labels, context))?.labels ?? {};
			for (const record of branches) {
				const handle = (await opened.conversation(record.id, context))!;
				let parent = record.parent === undefined ? null : (nearest.get(record.parent.at) ?? null);
				let end = record.parent?.at;
				const inherited = record.parent === undefined ? 0 : (inputsAt.get(record.parent.at) ?? 0);
				let inputs = inherited;
				let title: string | undefined;
				for (const entry of await ownEntries(handle)) {
					end = entry.id;
					if (isInput(entry)) {
						inputs += 1;
						title ??= inputText(entry);
					}
					inputsAt.set(entry.id, inputs);
					const id = String(entry.id);
					const shown = treeEntry(entry, id, parent);
					if (shown !== undefined) {
						const label = labels[id];
						const node: SessionTreeNode = { entry: shown, children: [], ...(label === undefined ? {} : { label }) };
						nodes.set(id, node);
						entries.set(id, entry);
						if (parent === null) roots.push(node);
						else nodes.get(parent)?.children.push(node);
						parent = id;
					}
					nearest.set(entry.id, parent);
				}
				ends.set(record.id, end);
				summaries.push({
					id: record.id,
					label: branchLabel(record.id),
					shown: record.id === current.id,
					messages: inputs,
					own: inputs - inherited,
					...(title === undefined ? {} : { title: oneLine(title) }),
					...(record.parent === undefined
						? {}
						: { from: { label: branchLabel(record.parent.conversationId), after: inherited } }),
				});
			}
			const end = ends.get(current.id);
			const leafId = end === undefined ? null : (nearest.get(end) ?? null);
			return { tree: roots, leafId, entries, ends, branches: summaries };
		};

		const controller: DurableController = {
			submit: (text, whenBusy) =>
				command(async () => {
					// Fail closed: with the session's sandbox pending or failed, the prompt is not sent at all.
					const target = await sandboxTarget(opened, current.id, context);
					if (target.kind === "blocked") throw new Error(`Not sent. ${target.reason}`);
					const expanded = REFERENCE_HINT.test(text)
						? await expandReferences(resources.expandInput(text), host)
						: resources.expandInput(text);
					watchAnswer(await current.submit({ type: "input", content: expanded, whenBusy }, context));
					const known = await readMeta(location.directory);
					await writeMeta(location.directory, {
						messageCount: (known.messageCount ?? 0) + 1,
						...(known.firstMessage === undefined ? { firstMessage: oneLine(text).slice(0, 200) } : {}),
					});
				}).then(() => {}),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					// Report the outcome once it is known; the status line shows the compaction meanwhile.
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							// A summary written while busy is a submission: placed now, queued, or dropped as stale.
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}).then(() => {}),
			// Not queued: it waits until the conversation is idle.
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}).then(() => {}),
			setThinking: (level) =>
				command(async () => {
					await current.configure({ thinkingLevel: clampThinkingLevel(agentModel(), level) }, context);
				}).then(() => {}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}).then(() => {}),
			toggleTasks: () =>
				command(async () => {
					showTasks = !showTasks;
					update({ tasks: showTasks ? graphWatch.value : undefined });
				}).then(() => {}),
			switchConversation: (id) =>
				command(async () => {
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					await show(next);
				}).then(() => {}),
			tree: async () => {
				const { tree, leafId, branches } = (await command(buildTree)) ?? { tree: [], leafId: null, branches: [] };
				return { tree, leafId, branches };
			},
			navigate: (nodeId) =>
				command(async () => {
					const { entries, ends } = await buildTree();
					const entry = entries.get(nodeId);
					if (entry === undefined) throw new Error(`No such entry: ${nodeId}`);
					const owner = (await opened.conversation(entry.conversationId, context))!;
					const text = isInput(entry) ? inputText(entry) : undefined;
					// A user message is re-asked from just before it.
					const target = text === undefined ? entry : await entryBefore(owner, entry.id);
					if (target === undefined) {
						// Before the first message: an empty conversation with the shown one's agent.
						const agent = agentOf(state.conversation);
						const fresh = await opened.createConversation(
							{
								ownership: { kind: "ownerless" },
								agent: {
									cwd: location.cwd,
									...(agent.model === undefined ? {} : { model: agent.model }),
									...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
								},
							},
							context,
						);
						await show(fresh);
						requestScan();
						return text;
					}
					// A branch already ending there is reused; the shown one first.
					const ending = [current.id, ...ends.keys()].find((id) => ends.get(id) === target.id);
					if (ending !== undefined) await show((await opened.conversation(ending, context))!);
					else await fork(owner, target.id);
					return text;
				}),
			clone: () =>
				command(async () => {
					const last = state.conversation.entries.at(-1);
					if (last === undefined) throw new Error("Nothing to clone yet");
					await fork(current, last.id);
					notice("info", `Cloned into ${current.id === ROOT_CONVERSATION_ID ? "main" : `branch ${current.id}`}.`);
				}).then(() => {}),
			rename: (name) =>
				command(async () => {
					await writeMeta(location.directory, { name });
					update({ session: { ...state.session, name } });
				}).then(() => {}),
			setLabel: (nodeId, label) =>
				command(async () => {
					const trimmed = label?.trim();
					await opened.commit(async (tx) => {
						const labels = (await tx.doc(Labels)).labels;
						if (trimmed) labels[nodeId] = trimmed;
						else delete labels[nodeId];
					}, context);
				}).then(() => {}),
			labelLatest: (label) =>
				command(async () => {
					const last = state.conversation.entries.findLast((entry) => treeEntry(entry, "", null) !== undefined);
					if (last === undefined) throw new Error("Nothing to label yet");
					await opened.commit(async (tx) => {
						(await tx.doc(Labels)).labels[String(last.id)] = label.trim();
					}, context);
					notice("info", `Labelled entry ${last.id} "${label.trim()}"; @label:${label.trim()} refers to it.`);
				}).then(() => {}),
			labels: async () => Object.values((await opened.snapshot(Labels, context))?.labels ?? {}),
			stop: (item) =>
				command(async () => {
					if (item.taskId !== undefined) await opened.abortTask(item.taskId, context);
					else if (item.conversationId !== undefined) {
						await (await opened.conversation(item.conversationId, context))?.abort(context);
					}
					notice("info", `Stopped ${item.label}.`);
					requestActivity();
				}).then(() => {}),
			reload: () =>
				command(async () => {
					await resources.reload();
					profiles.reload();
					update({ models: models() });
					warnResources();
					notice(
						"info",
						`Reloaded: ${resources.skills.length} skills, ${resources.prompts.length} prompt templates, ${profiles.all.length} agent profiles.`,
					);
				}).then(() => {}),
			trust: () =>
				command(async () => {
					await resources.trust();
					profiles.reload();
					notice("info", `Trusted ${location.cwd}: ${resources.skills.length} skills loaded.`);
				}).then(() => {}),
			notify: notice,
			startSwarm: (task) =>
				command(async () => {
					const record = (await records()).find((candidate) => candidate.id === current.id);
					if (record?.owner !== undefined) throw new Error("A subagent cannot coordinate a swarm; switch to main or a branch");
					await startSwarm(opened, current.id, task, swarm.tools);
					const expanded = REFERENCE_HINT.test(task) ? await expandReferences(task, host) : task;
					watchAnswer(await current.submit({ type: "input", content: swarmInput(expanded), whenBusy: "followUp" }, context));
					const known = await readMeta(location.directory);
					await writeMeta(location.directory, {
						messageCount: (known.messageCount ?? 0) + 1,
						...(known.firstMessage === undefined ? { firstMessage: oneLine(`/swarm ${task}`).slice(0, 200) } : {}),
					});
					requestActivity();
				}).then(() => {}),
			endSwarm: () =>
				command(async () => {
					notice("info", await endSwarm(opened));
					requestActivity();
				}).then(() => {}),
			swarmBoard: () => loadSwarmBoard(opened),
			// Not queued behind commands: a side question runs beside whatever the agent and the TUI are doing.
			btw: async (question, signal, onProgress) => {
				const agent = agentOf(state.conversation);
				const { messages } = await current.context(context);
				await runBtw(accounts.models, agentModel(), agent.thinkingLevel, messages, question, signal, onProgress);
			},
			status: async () => {
				accounts.sync();
				const working = await countWorking();
				return loadStatus({
					directory: location.directory,
					usageSince: (since) => usageSince(opened, since),
					cost: totalCost(await opened.usage(context)),
					conversations: state.conversations.length,
					working,
					...(accounts.pool.size > 1 ? { claudeAccounts: accounts.pool.status() } : {}),
				});
			},
			accounts: async () => {
				// Accounts added or removed from a shell (`pi-durable accounts`) join here too.
				accounts.sync();
				return loadAccounts({
					credentials: await modelRuntime.listCredentials(),
					providerName: (id) => modelRuntime.getProvider(id)?.name,
					active: accounts.pool.active,
				});
			},
			accountNames: () => extraAccountNames(),
			loginProviders: () => loginProviders(modelRuntime),
			// Not queued behind commands: the dialog waits on the user while the agent keeps working.
			login: async (target, interaction) => {
				const getDeviceId = () => resources.settings.getOrCreateDeviceId();
				const what =
					target.kind === "account"
						? `Claude account "${target.name}"`
						: (modelRuntime.getProvider(target.id)?.name ?? target.id);
				try {
					if (target.kind === "account") {
						await loginAccount(target.name, interaction, { getDeviceId });
						accounts.reload([target.name]);
						notice("info", `Signed ${what} in; Claude requests fall back to it from now on (${accounts.pool.size} accounts).`);
						return;
					}
					const provider = loginProviders(modelRuntime).find((candidate) => candidate.id === target.id);
					if (provider === undefined) throw new Error(`${target.id} has no account sign-in; use pi auth login ${target.id}`);
					let lagged: string | undefined;
					try {
						await modelRuntime.login(provider.id, "oauth", interaction, { getDeviceId });
					} catch (error) {
						// As pi's /login: the login is stored, only the local model state could not follow it.
						if (!(error instanceof CredentialSynchronizationError)) throw error;
						lagged = error.message;
					}
					if (provider.id === POOLED_PROVIDER) recordLogin(MAIN_ACCOUNT);
					// Dynamic catalogs stay empty until the first authenticated refresh, as after pi's /login.
					await modelRuntime
						.refresh({ providers: [provider.id], signal: AbortSignal.timeout(15_000) })
						.catch(() => undefined);
					update({ models: models() });
					const count = modelRuntime.getAvailableSnapshot().filter((model) => model.provider === provider.id).length;
					if (lagged !== undefined) {
						notice("warning", `Logged in to ${provider.name}, but local model state could not be synchronized: ${lagged}`);
					} else notice("info", `Logged in to ${provider.name}; ${count} of its models are in /model.`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (interaction.signal?.aborted === true || message === "Login cancelled") notice("info", "Login cancelled.");
					else notice("error", `Signing ${what} in failed: ${message}`);
				}
			},
			removeAccount: (name) =>
				command(async () => {
					if (!extraAccountNames().includes(name)) throw new Error(`No extra Claude account "${name}"`);
					removeAccount(name);
					accounts.reload();
					notice("info", `Removed Claude account "${name}".`);
				}).then(() => {}),
			// Queued like other commands, so a prompt sent while a sandbox is being made runs in it.
			sandbox: (argument) =>
				command(async () => {
					notice(
						"info",
						await setSessionSandbox(
							opened,
							sandboxes,
							argument.trim(),
							{ sessionId: location.id, cwd: location.cwd, notice },
							context,
						),
					);
				}).then(() => {}),
			sandboxKinds: () => sandboxes.kinds(),
		};

		const savedModel = agentOf(state.conversation).model;
		if (savedModel === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(savedModel.provider, savedModel.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${savedModel.provider}/${savedModel.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		if (resources.undecided) {
			notice("warning", "Project resources (skills, prompts) are not trusted yet; /trust loads them.");
		}
		warnResources();
		for (const problem of profiles.diagnostics) notice("warning", `Agent profile: ${problem}`);
		// --sandbox marks the session's sandbox pending before recovered work resumes, so nothing runs on this machine
		// while it is being made.
		let startSandbox: string | undefined;
		if (options.sandbox !== undefined) {
			try {
				startSandbox = options.sandbox || sandboxes.sbx.config.defaultKind;
				const target = parseSandboxArgument(startSandbox, sandboxes.kinds(), location.id);
				await markSessionSandboxPending(opened, target.name, target.kind, context);
			} catch (error) {
				fail(error);
				startSandbox = undefined;
			}
		} else {
			const problem = sessionSandboxProblem(await opened.snapshot(SessionSandbox, context));
			if (problem !== undefined) notice("warning", problem);
		}
		// Recovered work from an interrupted turn continues now.
		harness.resume();
		if (startSandbox !== undefined) void controller.sandbox(startSandbox);
		// Messages from other sessions, also those sent while this one was closed.
		const stopInbox = startInbox(location.directory, opened, report);
		requestActivity();

		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			resources,
			approvals,
			profiles,
			close() {
				closing ??= (async () => {
					stopInbox();
					if (activityPoll !== undefined) clearTimeout(activityPoll);
					await conversation.stop();
					await graphWatch.stop();
					await scanning;
					await activityRun;
					// The dashboard shows a closed session without live status.
					await writeMeta(location.directory, { live: undefined }).catch(() => {});
					// The TUI is gone by now, so anything left behind is said on stderr.
					for (const line of await closeBackgroundSandboxes(
						opened,
						sandboxes,
						state.conversations.map((summary) => summary.id),
						context,
					).catch((error: unknown) => [`Background sandboxes were not cleaned up: ${String(error)}`])) {
						console.error(`pi-durable: ${line}`);
					}
					try {
						// Close writes no outcome: a running turn resumes with --continue.
						await opened.close(context);
						await accounts.pool.settle();
						await envs.cleanup(context);
					} finally {
						await location.release();
					}
					// Like pi, a session nobody wrote to is not kept, so /new and plain starts leave nothing behind.
					if (location.created && (await readMeta(location.directory)).messageCount === undefined) {
						await removeSession(location.directory);
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}

/** The providers pi signs in to through OAuth, by id. */
function loginProviders(runtime: ModelRuntime): LoginProvider[] {
	return runtime
		.getProviders()
		.filter((provider) => provider.auth.oauth !== undefined)
		.map((provider) => ({ id: provider.id, name: provider.name }))
		.sort((left, right) => left.id.localeCompare(right.id));
}

/** References (`@session:`, `@agent:`, `@label:`) are expanded only when an input may hold one. */
const REFERENCE_HINT = /@(session|agent|label):/u;

/** What a conversation with a run is doing, in a few words. */
function liveStatus(live: LiveState): string {
	const tool = live.tools?.find((slot) => slot.status === "running");
	if (tool !== undefined) return `running ${tool.name}`;
	const parked = live.tools?.find((slot) => slot.status === "sleeping" || slot.status === "waiting");
	if (parked !== undefined) return `waiting on ${parked.name}`;
	if (live.generation?.retry !== undefined) return "retrying";
	if (live.compactions?.[0] !== undefined) return "compacting";
	if (live.generation !== undefined) return "writing";
	return "working";
}

function totalCost(usage: UsageState | undefined): number {
	if (usage === undefined) return 0;
	let total = 0;
	for (const entry of [...Object.values(usage.models), ...Object.values(usage.tools)]) total += entry.cost.total;
	return total;
}

/** The newest answer's text in a view, for /copy. */
export function lastAnswer(view: ConversationView): string | undefined {
	for (const entry of [...view.entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		const text = (message as AssistantMessage).content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("");
		if (text) return text;
	}
	return undefined;
}
