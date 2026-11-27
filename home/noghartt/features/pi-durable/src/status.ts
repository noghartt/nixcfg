import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { Container, type Focusable, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "#pi/index.js";
import { theme } from "#pi/modes/interactive/theme/theme.js";
import { type AccountStatus, clock } from "./accounts.ts";
import { type AccountIdentity, accountIdentities, createLimitsPoller, type LimitsCache, type ProviderLimits } from "./limits.ts";
import { sessionConversations, withSession } from "./messaging.ts";
import { isSessionOpen, listAllSessions } from "./sessions.ts";

const context = BACKGROUND_CONTEXT;

/** Spend of model requests since a point in time, summed from the assistant entries that recorded them. */
export interface UsageSince {
	cost: number;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Per `provider/modelId`. */
	models: Record<string, { cost: number; requests: number; tokens: number }>;
}

export function emptyUsage(): UsageSince {
	return { cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: {} };
}

function addInto(sum: UsageSince, part: UsageSince): void {
	sum.cost += part.cost;
	sum.requests += part.requests;
	sum.input += part.input;
	sum.output += part.output;
	sum.cacheRead += part.cacheRead;
	sum.cacheWrite += part.cacheWrite;
	for (const [key, model] of Object.entries(part.models)) {
		const into = (sum.models[key] ??= { cost: 0, requests: 0, tokens: 0 });
		into.cost += model.cost;
		into.requests += model.requests;
		into.tokens += model.tokens;
	}
}

/**
 * Every conversation's own assistant entries newer than `since`, newest first until the first older one. Durable's
 * usage ledger (`pi.usage`) has no dates, so a day's spend comes from the entries; compaction summaries, which write
 * no assistant entry, are left out.
 */
export async function usageSince(harness: Harness, since: number): Promise<UsageSince> {
	const usage = emptyUsage();
	for (const record of await sessionConversations(harness)) {
		let cursor: Cursor | undefined;
		scan: do {
			const page = await harness.commit(
				(tx) => tx.scanEntries({ conversationId: record.id, order: "descending" }, 256, cursor),
				context,
			);
			for (const entry of page.items as EntryRecord[]) {
				if (entry.conversationId !== record.id || entry.kind !== "pi.assistant") continue;
				const message = entry.model?.[0] as AssistantMessage | undefined;
				if (message?.role !== "assistant") continue;
				if (message.timestamp < since) break scan;
				const key = `${message.provider}/${message.model}`;
				const model = (usage.models[key] ??= { cost: 0, requests: 0, tokens: 0 });
				const { cost, input, output, cacheRead, cacheWrite } = message.usage;
				usage.cost += cost.total;
				usage.requests += 1;
				usage.input += input;
				usage.output += output;
				usage.cacheRead += cacheRead;
				usage.cacheWrite += cacheWrite;
				model.cost += cost.total;
				model.requests += 1;
				model.tokens += input + output + cacheRead + cacheWrite;
			}
			cursor = page.next;
		} while (cursor !== undefined);
	}
	return usage;
}

/** What /status shows. */
export interface StatusReport {
	readonly today: UsageSince;
	/** Sessions with a request today, and how many of them could not be read. */
	readonly todaySessions: number;
	readonly unreadable: number;
	readonly sessions: { total: number; projects: number; open: number; working: number };
	readonly thisSession: { cost: number; conversations: number; working: number };
	readonly limits: LimitsCache | undefined;
	readonly accounts: AccountIdentity[];
	/** The Claude accounts requests fall back across, when there is more than one. */
	readonly claudeAccounts?: readonly AccountStatus[];
}

/** This process's own session, which it reads through its own Harness rather than a second, read-only one. */
export interface OwnSession {
	readonly directory: string;
	usageSince(since: number): Promise<UsageSince>;
	readonly cost: number;
	readonly conversations: number;
	readonly working: number;
	readonly claudeAccounts?: readonly AccountStatus[];
}

function startOfToday(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Subscription limits through the statusline's shared cache: a fetch only when no process fetched in 5 minutes. */
async function readLimits(): Promise<LimitsCache | undefined> {
	let latest: LimitsCache | undefined;
	const poller = createLimitsPoller((cache) => {
		latest = cache;
	});
	try {
		await poller.tick();
	} finally {
		poller.stop();
	}
	return latest;
}

/** Up to `limit` of `items` at a time. */
async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export async function loadStatus(own: OwnSession): Promise<StatusReport> {
	const since = startOfToday();
	const [sessions, limits, accounts] = await Promise.all([
		listAllSessions(),
		readLimits().catch(() => undefined),
		accountIdentities().catch(() => []),
	]);
	const opened = await Promise.all(
		sessions.map(async (session) => ({
			session,
			open: session.path === own.directory || (await isSessionOpen(session.path)),
		})),
	);
	// A closed session last modified before today (meta.json moves with every live status) has no request today; the
	// rest are opened read-only, beside the processes holding them.
	const candidates = opened.filter(({ session, open }) => open || session.modified.getTime() >= since);
	let unreadable = 0;
	const usages = await mapLimited(candidates, 4, async ({ session }) => {
		try {
			return session.path === own.directory
				? await own.usageSince(since)
				: await withSession(session.path, (harness) => usageSince(harness, since));
		} catch {
			unreadable++;
			return emptyUsage();
		}
	});
	const today = emptyUsage();
	for (const usage of usages) addInto(today, usage);
	const open = opened.filter((row) => row.open);
	return {
		today,
		todaySessions: usages.filter((usage) => usage.requests > 0).length,
		unreadable,
		sessions: {
			total: sessions.length,
			projects: new Set(sessions.map((session) => session.cwd)).size,
			open: open.length,
			working: open.filter((row) => row.session.path !== own.directory && row.session.live?.busy === true).length +
				(own.working > 0 ? 1 : 0),
		},
		thisSession: { cost: own.cost, conversations: own.conversations, working: own.working },
		limits,
		accounts,
		...(own.claudeAccounts === undefined ? {} : { claudeAccounts: own.claudeAccounts }),
	};
}

function tokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function until(at: number | undefined): string {
	if (at === undefined) return "";
	const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
	if (minutes < 60) return `resets in ${minutes}m`;
	if (minutes < 48 * 60) return `resets in ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
	return `resets in ${Math.round(minutes / 1440)}d`;
}

function bar(percent: number): string {
	const width = 20;
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	const color = percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function providerLines(provider: ProviderLimits, emails: string[]): string[] {
	const head = [
		theme.bold(provider.title),
		provider.plan,
		provider.accounts > 1 ? `${provider.accounts} accounts pooled` : undefined,
		emails.length > 0 ? emails.join(", ") : undefined,
	].filter(Boolean);
	const lines = [head.join(theme.fg("dim", " · "))];
	if (provider.error !== undefined) lines.push(theme.fg("warning", `  ${provider.error}${provider.windows.length ? " (last reading)" : ""}`));
	for (const window of provider.windows) {
		lines.push(`  ${window.label.padEnd(14)} ${bar(window.percent)} ${`${Math.round(window.percent)}%`.padStart(4)}  ${theme.fg("muted", until(window.resetsAt))}`);
	}
	if (provider.spend !== undefined) {
		const { used, limit, currency, percent } = provider.spend;
		lines.push(`  ${"extra usage".padEnd(14)} ${bar(percent)} ${`${Math.round(percent)}%`.padStart(4)}  ${theme.fg("muted", `${used.toFixed(2)}/${limit.toFixed(2)} ${currency}`)}`);
	}
	return lines;
}

function age(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	return minutes < 1 ? "just now" : `${minutes}m ago`;
}

export function statusLines(report: StatusReport): string[] {
	const section = (title: string) => theme.fg("accent", theme.bold(title));
	const muted = (text: string) => theme.fg("muted", text);
	const lines: string[] = [section("Accounts")];
	const providers = report.limits?.providers ?? [];
	if (providers.length === 0) {
		lines.push(muted(report.limits === undefined ? "  No reading yet (another process is fetching); r refreshes." : "  No Claude or ChatGPT subscription signed in."));
	}
	for (const provider of providers) {
		const emails = report.accounts.filter((account) => account.provider === provider.id).map((account) => account.email);
		lines.push(...providerLines(provider, [...new Set(emails)]).map((line) => `  ${line}`));
	}
	if (report.limits !== undefined) lines.push(muted(`  checked ${age(report.limits.checkedAt)}`));
	if (report.claudeAccounts !== undefined) {
		lines.push(`  ${theme.bold("Claude fallback")}`);
		for (const account of report.claudeAccounts) {
			const state =
				account.blockedUntil === undefined
					? theme.fg("success", "free")
					: theme.fg("warning", `${account.reason === "auth" ? "auth failed, skipped" : "limited"} until ${clock(account.blockedUntil)}`);
			lines.push(`    ${account.active ? "▸" : " "} ${account.name.padEnd(16)} ${state}`);
		}
	}

	const today = report.today;
	lines.push("", section("Today"));
	lines.push(
		`  $${today.cost.toFixed(2)} · ${today.requests} requests · ${report.todaySessions} sessions` +
			muted(` · ${tokens(today.input)} in, ${tokens(today.output)} out, ${tokens(today.cacheRead)} cache read, ${tokens(today.cacheWrite)} cache write`),
	);
	const models = Object.entries(today.models).sort((left, right) => right[1].cost - left[1].cost);
	for (const [key, model] of models.slice(0, 8)) {
		lines.push(`    ${key.padEnd(44)} ${`$${model.cost.toFixed(2)}`.padStart(9)}  ${muted(`${model.requests} req · ${tokens(model.tokens)} tok`)}`);
	}
	if (models.length > 8) lines.push(muted(`    and ${models.length - 8} more models`));
	if (report.unreadable > 0) lines.push(theme.fg("warning", `  ${report.unreadable} sessions could not be read`));

	const { sessions, thisSession } = report;
	lines.push("", section("Sessions"));
	lines.push(`  ${sessions.total} sessions in ${sessions.projects} projects · ${sessions.open} open · ${sessions.working} working`);
	lines.push(
		`  this session: $${thisSession.cost.toFixed(2)} · ${thisSession.conversations} conversations · ${thisSession.working} working`,
	);
	return lines;
}

export interface ReportPanelOptions {
	readonly title: string;
	readonly loading: string;
	/** Extra text before the key hints (`r refresh · esc close`). */
	readonly hint?: string;
}

/** A report in place of the editor (/status, /accounts): loads once, r reloads, Esc or Enter closes. */
export class ReportPanel extends Container implements Focusable {
	readonly #body = new Text("", 1, 0);
	readonly #load: () => Promise<string[]>;
	readonly #loadingText: string;
	readonly #onClose: () => void;
	readonly #requestRender: () => void;
	#loading = false;
	#disposed = false;
	focused = false;

	constructor(options: ReportPanelOptions, load: () => Promise<string[]>, onClose: () => void, requestRender: () => void) {
		super();
		this.#load = load;
		this.#loadingText = options.loading;
		this.#onClose = onClose;
		this.#requestRender = requestRender;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#body);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `${options.hint === undefined ? "" : `${options.hint} · `}r refresh · esc close`), 1, 0));
		this.addChild(new DynamicBorder());
		void this.refresh();
	}

	dispose(): void {
		this.#disposed = true;
	}

	async refresh(): Promise<void> {
		if (this.#loading || this.#disposed) return;
		this.#loading = true;
		this.#body.setText(theme.fg("dim", this.#loadingText));
		this.#requestRender();
		try {
			const lines = await this.#load();
			if (!this.#disposed) this.#body.setText(lines.join("\n"));
		} catch (error) {
			if (!this.#disposed) this.#body.setText(theme.fg("error", error instanceof Error ? error.message : String(error)));
		} finally {
			this.#loading = false;
			if (!this.#disposed) this.#requestRender();
		}
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
			this.#onClose();
			return;
		}
		if (data === "r") void this.refresh();
	}
}

/** /status in place of the editor. */
export class StatusComponent extends ReportPanel {
	constructor(load: () => Promise<StatusReport>, onClose: () => void, requestRender: () => void) {
		super(
			{ title: "Status", loading: "Reading sessions and limits…" },
			async () => statusLines(await load()),
			onClose,
			requestRender,
		);
	}
}
