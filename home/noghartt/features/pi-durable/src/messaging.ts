import { randomUUID } from "node:crypto";
import { type FSWatcher, watch as watchPath } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type Host, oneLine, requireHarness } from "./host.ts";
import { isSessionOpen, listAllSessions, readMeta, type SessionListing } from "./sessions.ts";
import { Background, Identity, Labels, MESSAGE_KIND, type NoteData, REPORT_KIND } from "./state.ts";
import { answerText, finishStopped, markStopped, Reporter, type ReporterInput } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;
/** Characters of transcript a read returns by default, newest kept. */
const READ_CHARS = 12_000;

// ─── Transcripts as text ─────────────────────────────────────────────────────

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" ? String(part.text) : part?.type === "image" ? "[image]" : "")).join("");
}

/** One entry as transcript text; undefined for bookkeeping. */
export function entryText(entry: EntryRecord): string | undefined {
	const message = entry.model?.[0];
	if (entry.kind === REPORT_KIND || entry.kind === MESSAGE_KIND) {
		const data = entry.data as NoteData | undefined;
		return `[${entry.kind === REPORT_KIND ? "report" : "message"} from ${data?.from ?? "?"}] ${data?.text ?? contentText(message?.role === "user" ? message.content : "")}`;
	}
	if (entry.kind === "pi.compaction") return `[summary of earlier context] ${message?.role === "user" ? contentText(message.content) : ""}`;
	if (message === undefined) return undefined;
	if (message.role === "user") return `user: ${contentText(message.content)}`;
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		const calls = assistant.content.flatMap((part) =>
			part.type === "toolCall" ? [`→ ${part.name}(${oneLine(JSON.stringify(part.arguments), 160)})`] : [],
		);
		return [answerText(assistant) ? `assistant: ${answerText(assistant)}` : undefined, ...calls].filter(Boolean).join("\n");
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		return `← ${result.toolName}${result.isError ? " (error)" : ""}: ${oneLine(contentText(result.content), 300)}`;
	}
	return undefined;
}

/**
 * The newest transcript text of a conversation, up to `upTo` when given, within `chars`: what another agent or the user
 * refers to. Entries are read newest first until the budget is spent.
 */
export async function conversationText(
	harness: Harness,
	id: ConversationId,
	options: { upTo?: EntryId; chars?: number } = {},
): Promise<string> {
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) throw new Error(`Conversation #${id} does not exist`);
	const budget = options.chars ?? READ_CHARS;
	const lines: string[] = [];
	let used = 0;
	let cursor: Cursor | undefined;
	let truncated = false;
	outer: do {
		const page = await conversation.entries(
			{ order: "descending", ...(options.upTo === undefined ? {} : { maxEntryId: options.upTo }) },
			64,
			cursor,
			context,
		);
		for (const entry of page.items) {
			const text = entryText(entry);
			if (text === undefined) continue;
			if (used + text.length > budget) {
				truncated = true;
				if (lines.length === 0) lines.push(`${text.slice(0, budget)}…`);
				break outer;
			}
			lines.push(text);
			used += text.length;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	lines.reverse();
	if (truncated) lines.unshift("[earlier entries left out]");
	return lines.join("\n\n") || "(no messages)";
}

async function allConversations(read: (cursor: Cursor | undefined) => Promise<{ items: readonly ConversationRecord[]; next?: Cursor }>) {
	const found: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await read(cursor);
		found.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return found;
}

export function sessionConversations(harness: Harness): Promise<ConversationRecord[]> {
	return allConversations((cursor) => harness.commit((tx) => tx.scanConversations({}, 256, cursor), context));
}

/** The entry a label names, in a session's labels; matched without regard to case. */
async function labelled(harness: Harness, label: string): Promise<EntryId> {
	const labels = (await harness.snapshot(Labels, context))?.labels ?? {};
	const wanted = label.toLowerCase();
	const found = Object.entries(labels).find(([, value]) => value.toLowerCase() === wanted);
	if (found === undefined) {
		const known = Object.values(labels);
		throw new Error(`No entry labelled "${label}"${known.length > 0 ? `; labels: ${known.join(", ")}` : ""}`);
	}
	return Number(found[0]) as EntryId;
}

/** A conversation that sees `entry`: the one that wrote it. */
async function ownerOf(harness: Harness, entry: EntryId): Promise<ConversationId> {
	for (const record of await sessionConversations(harness)) {
		const conversation = (await harness.conversation(record.id, context))!;
		const page = await conversation.entries({ minEntryId: entry, maxEntryId: entry }, 1, undefined, context);
		if (page.items[0]?.conversationId === record.id) return record.id;
	}
	throw new Error(`Entry ${entry} is not in this session`);
}

// ─── Conversations of this session ───────────────────────────────────────────

type Target = { kind: "conversation"; id: ConversationId; label: string } | { kind: "watcher"; taskId: TaskId; label: string };

async function labelOf(harness: Harness, record: ConversationRecord): Promise<string> {
	if (record.id === ROOT_CONVERSATION_ID) return "main";
	const identity = await harness.snapshot(Identity, record.id, context);
	if (identity?.name !== undefined) return `subagent ${identity.name} (#${record.id})`;
	return record.owner === undefined ? `branch #${record.id}` : `subagent #${record.id}`;
}

async function resolveTarget(harness: Harness, self: ConversationId, target: string): Promise<Target> {
	const trimmed = target.trim();
	const records = await sessionConversations(harness);
	const conversation = async (id: ConversationId): Promise<Target> => {
		const record = records.find((candidate) => candidate.id === id);
		if (record === undefined) throw new Error(`Conversation #${id} does not exist`);
		return { kind: "conversation", id, label: await labelOf(harness, record) };
	};
	if (trimmed === "main") return conversation(ROOT_CONVERSATION_ID);
	if (trimmed === "parent") {
		const parent = (await harness.snapshot(Identity, self, context))?.parent;
		const owner = records.find((record) => record.id === self)?.owner?.conversationId;
		if (parent === undefined && owner === undefined) throw new Error("This conversation has no parent");
		return conversation((parent ?? owner) as ConversationId);
	}
	const number = /^#?(\d+)$/u.exec(trimmed);
	if (number !== null) return conversation(Number(number[1]) as ConversationId);
	const task = /^task #?(\d+)$/u.exec(trimmed);
	const wanted = trimmed.toLowerCase();
	for (const record of records) {
		const identity = await harness.snapshot(Identity, record.id, context);
		if (identity?.name?.toLowerCase() === wanted) return conversation(record.id);
	}
	for (const record of records) {
		const watchers = (await harness.snapshot(Background, record.id, context))?.watchers ?? {};
		for (const watcher of Object.values(watchers)) {
			if (watcher.name.toLowerCase() === wanted || (task !== null && Number(task[1]) === watcher.taskId)) {
				return { kind: "watcher", taskId: watcher.taskId, label: `watch ${watcher.name}` };
			}
		}
	}
	throw new Error(`No agent or watcher "${target}"; agents list shows them`);
}

/** Whether `id` is `self` or one of the conversations that started it: stopping those would stop the caller. */
async function isAncestor(harness: Harness, self: ConversationId, id: ConversationId): Promise<boolean> {
	const records = await sessionConversations(harness);
	for (let current: ConversationId | undefined = self; current !== undefined; ) {
		if (current === id) return true;
		const identity = await harness.snapshot(Identity, current, context);
		current = (identity?.parent ?? records.find((record) => record.id === current)?.owner?.conversationId) as
			| ConversationId
			| undefined;
	}
	return false;
}

async function listAgents(harness: Harness, self: ConversationId): Promise<string> {
	const lines: string[] = [];
	const watchers: string[] = [];
	for (const record of await sessionConversations(harness)) {
		const identity = await harness.snapshot(Identity, record.id, context);
		const live = await harness.snapshot(LiveDoc, record.id, context);
		const agent = await harness.snapshot(AgentDoc, record.id, context);
		const traits = [
			identity?.profile !== undefined && identity.profile !== "general" ? `profile ${identity.profile}` : undefined,
			identity?.background === true ? "background" : undefined,
			identity?.worktree === undefined ? undefined : `branch ${identity.worktree.branch}`,
			agent?.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}`,
		].filter(Boolean);
		const busy = live?.run !== undefined ? "working" : "idle";
		lines.push(
			`- ${await labelOf(harness, record)}${record.id === self ? " (you)" : ""}: ${busy}${traits.length > 0 ? `; ${traits.join("; ")}` : ""}`,
		);
		for (const watcher of Object.values((await harness.snapshot(Background, record.id, context))?.watchers ?? {})) {
			const task = await harness.getTask(watcher.taskId, context);
			const status = task === undefined || task.state.status === "terminal" ? "ended" : "running";
			if (status === "ended") continue;
			watchers.push(`- watch ${watcher.name} (task #${watcher.taskId}, ${watcher.kind} ${watcher.description}): ${status}`);
		}
	}
	return [`Conversations:\n${lines.join("\n")}`, watchers.length > 0 ? `Watchers:\n${watchers.join("\n")}` : "No running watchers."].join("\n\n");
}

const AgentsParameters = obj({
	action: oneOf(["list", "send", "read", "stop"], {
		description:
			"list: the session's conversations (main, branches, subagents) and watchers; send: a message to one; " +
			"read: its recent transcript; stop: abort a subagent's current work or end a watcher",
	}),
	target: opt(
		str({
			description:
				'send/read/stop: "main", "parent", a subagent or watcher name, or a conversation number like "#5"',
		}),
	),
	message: opt(str({ description: "send: the message" })),
	steer: opt(
		bool({
			description: "send: deliver it into the target's current work instead of after its current answer",
		}),
	),
	chars: opt(int({ description: `read: how much transcript to return (default ${READ_CHARS} characters)` })),
});

/** `agents`: see, message, read, and stop the other agents and watchers of this session. Every conversation has it. */
function createAgentsTool(host: Host) {
	return defineTool({
		name: "agents",
		description:
			"See and talk to the other agents of this session: the main conversation, branches, subagents (also ones " +
			"working in the background), and watchers. send delivers a message (a background subagent's answer comes back " +
			"to you as a message; others can reply with agents send), read returns a transcript, stop aborts a subagent's " +
			"work or ends a watcher. Other sessions are reached with the sessions tool.",
		parameters: AgentsParameters,
		replay: "safe",
		execute: async (args, api, context) => {
			const harness = requireHarness(host);
			if (args.action === "list") return text(await listAgents(harness, api.conversationId));
			if (args.target === undefined) throw new Error(`${args.action} needs a target`);
			const target = await resolveTarget(harness, api.conversationId, args.target);
			if (args.action === "read") {
				if (target.kind !== "conversation") throw new Error("Watchers have no transcript; their reports arrive as messages");
				return text(`${target.label}:\n\n${await conversationText(harness, target.id, args.chars === undefined ? {} : { chars: args.chars })}`);
			}
			if (args.action === "stop") {
				if (target.kind === "watcher") {
					await harness.abortTask(target.taskId, context);
					return text(`Stopped ${target.label}.`);
				}
				if (await isAncestor(harness, api.conversationId, target.id)) {
					throw new Error(`${target.label} is this conversation or one that started it; it cannot be stopped from here`);
				}
				// A background subagent in a sandbox is stopped for good: its work comes back and its sandbox goes.
				const final = await markStopped(api, target.id, context);
				await (await api.conversation(target.id, context))!.abort(context);
				const wrapped = final ? await finishStopped(api, host.sandboxes, target.id, context) : undefined;
				return text(
					final
						? `Stopped ${target.label} for good; it takes no more work (start a new subagent).${wrapped === undefined ? "" : `\n${wrapped}`}`
						: `Stopped the current work of ${target.label}; it keeps its transcript and takes new messages.`,
				);
			}
			// send
			if (!args.message) throw new Error("send needs a message");
			if (target.kind !== "conversation") throw new Error("Watchers take no messages; stop and start a new one");
			if (target.id === api.conversationId) throw new Error("That is this conversation");
			return text(await send(host, api, target, args.message, args.steer === true, context));
		},
	});
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

async function senderLabel(harness: Harness, id: ConversationId): Promise<string> {
	const record = (await sessionConversations(harness)).find((candidate) => candidate.id === id);
	return record === undefined ? `conversation #${id}` : labelOf(harness, record);
}

async function send(
	host: Host,
	api: ToolExecutionApi,
	target: { id: ConversationId; label: string },
	message: string,
	steer: boolean,
	context: Context,
): Promise<string> {
	const harness = requireHarness(host);
	const from = await senderLabel(harness, api.conversationId);
	const identity = await harness.snapshot(Identity, target.id, context);
	if (identity?.background === true) {
		// A background subagent's answer comes back to the sender, like the first one went to its parent.
		const input: ReporterInput = {
			name: identity.name ?? `#${target.id}`,
			conversationId: target.id,
			reportTo: api.conversationId,
			message,
			from,
			followUp: !steer,
		};
		await api.createTask(
			Reporter,
			input,
			{ ownership: { kind: "conversation" }, background: true, abandonOnRestart: false, key: "send" },
			context,
		);
		return `Sent to ${target.label}; its answer will arrive as a message.`;
	}
	const handle = (await api.conversation(target.id, context))!;
	await handle.submit(
		{
			type: "input",
			content: `[message from ${from}${from.includes(`#${api.conversationId}`) ? "" : ` (#${api.conversationId})`}] ${message}\n\n(Reply with the agents tool: send to "#${api.conversationId}".)`,
			whenBusy: steer ? "steer" : "followUp",
			onAbort: "keep",
			requestId: `agents-send:${api.taskId}`,
			entry: { kind: MESSAGE_KIND, data: { from, text: message, conversationId: api.conversationId } },
		},
		context,
	);
	return `Sent to ${target.label}.`;
}

// ─── Other sessions ──────────────────────────────────────────────────────────

export type InboxMessage = {
	from: { session: string; name?: string; cwd: string; conversation: number; label: string };
	/** The receiving conversation; main by default. */
	conversation?: number;
	text: string;
	steer?: boolean;
};

/** Find a session by ID, ID prefix, name, or directory. */
export async function resolveSession(ref: string): Promise<SessionListing> {
	const all = await listAllSessions();
	const wanted = ref.trim();
	const exact = all.find((s) => s.id === wanted || s.path === wanted || s.name?.toLowerCase() === wanted.toLowerCase());
	if (exact !== undefined) return exact;
	const prefixed = all.filter((s) => s.id.startsWith(wanted) || s.id.split("-").slice(1).join("-").startsWith(wanted));
	if (prefixed.length === 1) return prefixed[0]!;
	if (prefixed.length > 1) throw new Error(`"${ref}" matches ${prefixed.length} sessions; give more of the ID`);
	throw new Error(`No session "${ref}"; sessions list shows them`);
}

/** Open another session's database read-only, beside the process that may hold it. */
export async function withSession<T>(directory: string, read: (harness: Harness) => Promise<T>): Promise<T> {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models: createModels(), registry: createRegistry(), readOnly: true },
		context,
	);
	try {
		return await read(harness);
	} finally {
		await harness.close(context).catch(() => {});
	}
}

/** Transcript text of a session: up to and around a labelled entry, or the end of a conversation (default: the one shown last). */
export async function sessionText(
	directory: string,
	options: { label?: string; conversation?: number; chars?: number },
): Promise<string> {
	const meta = await readMeta(directory);
	return withSession(directory, async (harness) => {
		if (options.label !== undefined) {
			const entry = await labelled(harness, options.label);
			const owner = await ownerOf(harness, entry);
			return conversationText(harness, owner, { upTo: entry, ...(options.chars === undefined ? {} : { chars: options.chars }) });
		}
		const id = (options.conversation ?? meta.current ?? ROOT_CONVERSATION_ID) as ConversationId;
		return conversationText(harness, id, options.chars === undefined ? {} : { chars: options.chars });
	});
}

function inboxDir(directory: string): string {
	return join(directory, "inbox");
}

/** Drop a message in a session's inbox; the process holding the session delivers it, now or when it next opens. */
export async function sendToSession(directory: string, message: InboxMessage): Promise<void> {
	const dir = inboxDir(directory);
	await mkdir(dir, { recursive: true });
	const name = `${String(Date.now()).padStart(13, "0")}-${randomUUID()}.json`;
	const temporary = join(dir, `.${name}.tmp`);
	await writeFile(temporary, JSON.stringify(message));
	await rename(temporary, join(dir, name));
}

/**
 * Deliver inbox messages to this session as inputs, until stopped. A message's file name is its request ID, so a crash
 * between delivering and deleting it never delivers it twice.
 */
export function startInbox(directory: string, harness: Harness, report: (error: unknown) => void): () => void {
	const dir = inboxDir(directory);
	let stopped = false;
	let running: Promise<void> | undefined;
	let again = false;
	const deliver = async (): Promise<void> => {
		const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".json")).sort();
		for (const file of files) {
			if (stopped) return;
			const path = join(dir, file);
			try {
				const message = JSON.parse(await readFile(path, "utf-8")) as InboxMessage;
				const id = (message.conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
				const conversation = (await harness.conversation(id, context)) ?? (await harness.root(context));
				const sender = `session "${message.from.name ?? message.from.session}" (${message.from.label})`;
				await conversation.submit(
					{
						type: "input",
						content:
							`[message from ${sender}, ${message.from.cwd}] ${message.text}\n\n` +
							`(Reply with the sessions tool: send to session ${message.from.session}, conversation ${message.from.conversation}.)`,
						whenBusy: message.steer === true ? "steer" : "followUp",
						onAbort: "keep",
						requestId: `inbox:${file}`,
						entry: {
							kind: MESSAGE_KIND,
							data: { from: sender, text: message.text, session: message.from.session } satisfies NoteData,
						},
					},
					context,
				);
			} catch (error) {
				report(new Error(`Inbox message ${file} could not be delivered: ${error instanceof Error ? error.message : String(error)}`));
			}
			await rm(path, { force: true });
		}
	};
	const kick = (): void => {
		if (stopped) return;
		if (running !== undefined) {
			again = true;
			return;
		}
		running = deliver()
			.catch(report)
			.finally(() => {
				running = undefined;
				if (again) {
					again = false;
					kick();
				}
			});
	};
	let watcher: FSWatcher | undefined;
	void mkdir(dir, { recursive: true }).then(() => {
		if (stopped) return;
		try {
			watcher = watchPath(dir, () => kick());
		} catch {}
		kick();
	});
	// fs.watch misses events on some filesystems; a slow poll catches those.
	const poll = setInterval(kick, 5_000);
	poll.unref();
	return () => {
		stopped = true;
		clearInterval(poll);
		watcher?.close();
	};
}

const SessionsParameters = obj({
	action: oneOf(["list", "read", "send"], {
		description: "list: pi-durable sessions on this machine; read: another session's transcript; send: a message to its agent",
	}),
	session: opt(str({ description: "read/send: session ID (or its start), name, or directory" })),
	label: opt(str({ description: "read: return the transcript up to the entry with this label" })),
	conversation: opt(int({ description: "read/send: conversation number in that session (default: main for send, the shown one for read)" })),
	message: opt(str({ description: "send: the message" })),
	steer: opt(bool({ description: "send: deliver into its current work instead of after its current answer" })),
	chars: opt(int({ description: `read: how much transcript to return (default ${READ_CHARS} characters)` })),
});

/** `sessions`: other pi-durable sessions: list them, read them (also at a label), and message their agents. */
function createSessionsTool(host: Host) {
	return defineTool({
		name: "sessions",
		description:
			"Reach other pi-durable sessions (other projects or other work on this machine): list them, read a session's " +
			"transcript (up to a labelled entry with label), or send its agent a message, delivered when that session is " +
			"open. Messages from other sessions arrive as [message from session ...] inputs; reply with send.",
		parameters: SessionsParameters,
		replay: "safe",
		execute: async (args, api, context) => {
			if (args.action === "list") {
				const sessions = (await listAllSessions()).slice(0, 40);
				const lines = await Promise.all(
					sessions.map(async (s) => {
						const open = s.path === host.sessionDir ? "this session" : (await isSessionOpen(s.path)) ? "open" : "closed";
						const title = s.name ?? s.firstMessage;
						return `- ${s.id} ${JSON.stringify(oneLine(title, 80))} in ${s.cwd || "?"}: ${open}, ${s.messageCount} messages, ${s.modified.toISOString()}`;
					}),
				);
				return text(lines.join("\n") || "No sessions.");
			}
			if (args.session === undefined) throw new Error(`${args.action} needs a session`);
			const session = await resolveSession(args.session);
			if (args.action === "read") {
				const body = await sessionText(session.path, {
					...(args.label === undefined ? {} : { label: args.label }),
					...(args.conversation === undefined ? {} : { conversation: args.conversation }),
					...(args.chars === undefined ? {} : { chars: args.chars }),
				});
				return text(`Session ${session.id} (${session.name ?? oneLine(session.firstMessage, 60)}), ${session.cwd}:\n\n${body}`);
			}
			if (!args.message) throw new Error("send needs a message");
			if (session.path === host.sessionDir) throw new Error("That is this session; use the agents tool");
			const harness = requireHarness(host);
			const meta = await readMeta(host.sessionDir);
			// The memo keeps a rerun after a crash from sending twice.
			const sent = await api.memo<boolean>("sent", context);
			if (sent !== true) {
				await sendToSession(session.path, {
					from: {
						session: host.sessionId,
						...(meta.name === undefined ? {} : { name: meta.name }),
						cwd: host.cwd,
						conversation: api.conversationId,
						label: await senderLabel(harness, api.conversationId),
					},
					...(args.conversation === undefined ? {} : { conversation: args.conversation }),
					text: args.message,
					...(args.steer === true ? { steer: true } : {}),
				});
				await api.memo("sent", true, context);
			}
			const open = await isSessionOpen(session.path);
			return text(
				`Sent to session ${session.id}. ${open ? "It is open, so its agent gets it now." : "It is closed; its agent gets it when the session is next opened."}`,
			);
		},
	});
}

/** The messaging tools, kept by every conversation, subagents included. */
export function createMessaging(host: Host): Extension {
	return defineExtension({ name: "pi-durable-messaging", tools: [createAgentsTool(host), createSessionsTool(host)] });
}

// ─── References in user input ────────────────────────────────────────────────

/** A target or label is a bare word or, holding spaces or `#`, quoted. */
const REFERENCE = /@(session|agent|label):(?:"([^"]+)"|([^\s#"]+))(?:#(?:"([^"]+)"|([^\s"]+)))?/gu;
/** Prose around an unquoted reference, as in "(see @label:x)." or "`@session:x`", is not part of it. */
const TRAILING = /[,.;:!?)\]}>`'*_]+$/u;

/** How a target or label is written in a reference: quoted when it holds spaces, `#` or quotes (which are dropped). */
export function quoteReference(text: string): string {
	return /[\s#"]/u.test(text) ? `"${text.replaceAll('"', "")}"` : text;
}

/** The labels of another session, read without opening it for writing. */
export async function sessionLabels(directory: string): Promise<string[]> {
	return withSession(directory, async (harness) =>
		Object.values((await harness.snapshot(Labels, context))?.labels ?? {}),
	);
}

/**
 * Attach what references in an input point at, as reference blocks after the text (which is kept):
 * `@session:<ref>[#label]` another session's transcript (up to a label), `@agent:<name|id>[#label]` another conversation
 * of this session, `@label:<label>` this session up to a labelled entry.
 */
export async function expandReferences(input: string, host: Host): Promise<string> {
	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const match of input.matchAll(REFERENCE)) {
		const [, kind, quotedRef, bareRef, quotedLabel, bareLabel] = match;
		const ref = quotedRef ?? (bareLabel === undefined && quotedLabel === undefined ? bareRef!.replace(TRAILING, "") : bareRef!);
		const label = quotedLabel ?? bareLabel?.replace(TRAILING, "");
		if (!ref || label === "") continue;
		const whole = `@${kind}:${quoteReference(ref)}${label === undefined ? "" : `#${quoteReference(label)}`}`;
		if (seen.has(whole)) continue;
		seen.add(whole);
		try {
			if (kind === "session") {
				const session = await resolveSession(ref!);
				const body = await sessionText(session.path, label === undefined ? {} : { label });
				blocks.push(`<reference to="${whole}" session="${session.id}" cwd="${session.cwd}">\n${body}\n</reference>`);
			} else {
				const harness = requireHarness(host);
				let id: ConversationId;
				let upTo: EntryId | undefined;
				if (kind === "label") {
					upTo = await labelled(harness, ref!);
					id = await ownerOf(harness, upTo);
				} else {
					const target = await resolveTarget(harness, ROOT_CONVERSATION_ID, ref!);
					if (target.kind !== "conversation") throw new Error("watchers have no transcript");
					id = target.id;
					if (label !== undefined) upTo = await labelled(harness, label);
				}
				const body = await conversationText(harness, id, upTo === undefined ? {} : { upTo });
				blocks.push(`<reference to="${whole}" conversation="${id}">\n${body}\n</reference>`);
			}
		} catch (error) {
			blocks.push(`<reference to="${whole}" error="${error instanceof Error ? error.message : String(error)}" />`);
		}
	}
	return blocks.length === 0 ? input : `${input}\n\n${blocks.join("\n\n")}`;
}
