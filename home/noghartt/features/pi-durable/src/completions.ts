import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { oneLine } from "./host.ts";
import { quoteReference, sessionLabels } from "./messaging.ts";
import type { ConversationSummary } from "./runtime.ts";
import { isSessionOpen, listAllSessions, type SessionListing } from "./sessions.ts";

/** What the reference completions read: this session, its conversations and labels. */
export interface ReferenceSources {
	sessionId(): string;
	conversations(): readonly ConversationSummary[];
	labels(): Promise<string[]>;
}

const KINDS: readonly AutocompleteItem[] = [
	{
		value: "@session:",
		label: "@session:",
		description: "another session's transcript (read-only)",
	},
	{
		value: "@agent:",
		label: "@agent:",
		description: "another conversation of this session",
	},
	{
		value: "@label:",
		label: "@label:",
		description: "this session up to a labelled entry",
	},
];

/** The `@` token the cursor is in; tokens may sit in prose, as in "(@x" or "`@x". */
const TOKEN = /(?:^|\s)[([{<`]*(@\S*)$/u;
const REFERENCE = /^@(session|agent|label):(.*)$/su;
/** A reference target, then `#` and the start of a label. */
const WITH_LABEL = /^("[^"]*"|[^\s#"]*)#(.*)$/su;
/** Sessions and their labels are read from disk; a popup's keystrokes reuse one read. */
const CACHE_MS = 3000;
const LIMIT = 40;

/**
 * pi's `@` file completion, plus `@session:`, `@agent:` and `@label:` references: the kinds themselves next to files
 * after a bare `@`, then sessions (newest first), this session's conversations, and labels, also after `#`.
 */
export class ReferenceAutocomplete implements AutocompleteProvider {
	/** `:` completes `@session:` right away, before a character of the ID is typed. */
	readonly triggerCharacters = [":"];
	readonly #base: AutocompleteProvider;
	readonly #sources: ReferenceSources;
	#sessions: { at: number; list: Promise<SessionListing[]> } | undefined;
	readonly #sessionLabels = new Map<string, { at: number; labels: Promise<string[]> }>();

	constructor(base: AutocompleteProvider, sources: ReferenceSources) {
		this.#base = base;
		this.#sources = sources;
		if (base.shouldTriggerFileCompletion !== undefined) {
			this.shouldTriggerFileCompletion = base.shouldTriggerFileCompletion.bind(base);
		}
	}

	shouldTriggerFileCompletion?: AutocompleteProvider["shouldTriggerFileCompletion"];

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const token = TOKEN.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
		if (token === undefined) return this.#base.getSuggestions(lines, cursorLine, cursorCol, options);
		const reference = REFERENCE.exec(token);
		if (reference !== null) {
			const items = await this.#references(reference[1] as "session" | "agent" | "label", reference[2]!);
			return items.length === 0 ? null : { items, prefix: token };
		}
		const files = await this.#base.getSuggestions(lines, cursorLine, cursorCol, options);
		const word = token.slice(1);
		const kinds = word.startsWith('"') ? [] : KINDS.filter((kind) => kind.value.slice(1).startsWith(word));
		if (kinds.length === 0) return files;
		if (files !== null && files.prefix !== token) return files;
		return { items: [...kinds, ...(files?.items ?? [])], prefix: token };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const ours = REFERENCE.test(prefix) || KINDS.some((kind) => kind.value === item.value);
		if (!ours) return this.#base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		// A kind or a target waiting for its label keeps the cursor on the token.
		const suffix = /[:#]$/u.test(item.value) ? "" : " ";
		const next = [...lines];
		next[cursorLine] = `${before}${item.value}${suffix}${line.slice(cursorCol)}`;
		return {
			lines: next,
			cursorLine,
			cursorCol: before.length + item.value.length + suffix.length,
		};
	}

	async #references(kind: "session" | "agent" | "label", rest: string): Promise<AutocompleteItem[]> {
		const withLabel = kind === "label" ? null : WITH_LABEL.exec(rest);
		if (withLabel !== null) {
			const target = withLabel[1]!;
			const labels = kind === "agent" ? await this.#sources.labels() : await this.#labelsOf(target.replaceAll('"', ""));
			return fuzzyFilter(labels, unquote(withLabel[2]!), (label) => label)
				.slice(0, LIMIT)
				.map((label) => {
					const value = `@${kind}:${target}#${quoteReference(label)}`;
					return {
						value,
						label,
						description: `up to the entry labelled "${label}"`,
					};
				});
		}
		const query = unquote(rest);
		if (kind === "label") {
			return fuzzyFilter(await this.#sources.labels(), query, (label) => label)
				.slice(0, LIMIT)
				.map((label) => ({
					value: `@label:${quoteReference(label)}`,
					label,
					description: "this session up to it",
				}));
		}
		if (kind === "agent") {
			return fuzzyFilter([...this.#sources.conversations()], query, (c) => `${c.label} ${c.name ?? ""} ${c.id}`)
				.slice(0, LIMIT)
				.map((c) => ({
					value: `@agent:${agentRef(c)}`,
					label: c.label,
					description: [c.kind, c.profile, c.title === undefined ? undefined : oneLine(c.title, 80)]
						.filter(Boolean)
						.join(" · "),
				}));
		}
		const all = (await this.#allSessions()).filter((s) => s.id !== this.#sources.sessionId());
		const shown = fuzzyFilter(all, query, (s) => `${s.id} ${s.name ?? ""} ${s.firstMessage} ${s.cwd}`).slice(0, LIMIT);
		// By its lock, as the dashboard does: `live` outlasts a crashed process.
		const open = await Promise.all(shown.map((s) => isSessionOpen(s.path)));
		return shown.map((s, index) => ({
			value: `@session:${shortId(s, all)}`,
			label: s.name ?? (oneLine(s.firstMessage, 60) || s.id.slice(0, 13)),
			description: [open[index] ? "open" : undefined, s.cwd || undefined, age(s.modified)].filter(Boolean).join(" · "),
		}));
	}

	#allSessions(): Promise<SessionListing[]> {
		if (this.#sessions === undefined || Date.now() - this.#sessions.at > CACHE_MS) {
			const list = listAllSessions().catch(() => []);
			this.#sessions = { at: Date.now(), list };
		}
		return this.#sessions.list;
	}

	async #labelsOf(ref: string): Promise<string[]> {
		const session = (await this.#allSessions()).find((s) => s.id.startsWith(ref) || s.name === ref);
		if (session === undefined) return [];
		let cached = this.#sessionLabels.get(session.path);
		if (cached === undefined || Date.now() - cached.at > CACHE_MS) {
			cached = {
				at: Date.now(),
				labels: sessionLabels(session.path).catch(() => []),
			};
			this.#sessionLabels.set(session.path, cached);
		}
		return cached.labels;
	}
}

function unquote(text: string): string {
	return text.replaceAll('"', "");
}

/** Subagents by name, branches by ID (their labels are not names `@agent:` resolves). */
function agentRef(conversation: ConversationSummary): string {
	if (conversation.kind === "main") return "main";
	if (conversation.name !== undefined && /^[^\s#"]+$/u.test(conversation.name)) return conversation.name;
	return String(conversation.id);
}

/** The session's start time (13 digits), longer only when another session started in the same millisecond. */
function shortId(session: SessionListing, all: readonly SessionListing[]): string {
	const start = session.id.slice(0, 13);
	return all.some((other) => other !== session && other.id.startsWith(start)) ? session.id.slice(0, 22) : start;
}

function age(date: Date): string {
	const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
	return `${Math.round(minutes / 1440)}d ago`;
}
