import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// One cache for every Pi/OmO process of this user: with an orchestrator mesh open, per-process
// polling multiplies requests and both endpoints answer frequent polls with HTTP 429.
const CACHE_PATH = join(tmpdir(), "pi-statusline-limits.json");
const LOCK_PATH = join(tmpdir(), "pi-statusline-limits.lock");
const CACHE_VERSION = 1;
export const LIMITS_TTL_MS = 5 * 60_000;
export const LIMITS_REREAD_MS = 30_000;
// Longer than a full fetch round (parallel requests, 10s timeout each), so a live holder is
// never taken over; a crashed holder blocks fetching for at most this long.
const LOCK_STALE_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const LOCK_BUSY_RETRY_MS = 5_000;

// Claude.ai's own usage page reads this endpoint.
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Claude's OAuth tokens are opaque, so the signed-in email has to come from the profile.
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// Codex CLI's /status reads this endpoint; it rejects requests without the CLI's user agent.
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

export type LimitWindow = { label: string; percent: number; resetsAt?: number; windowMs?: number };
export type LimitSpend = { used: number; limit: number; currency: string; percent: number };
export type ProviderLimits = {
	id: "claude" | "chatgpt";
	title: string;
	plan?: string;
	accounts: number;
	ok: number;
	windows: LimitWindow[];
	spend?: LimitSpend;
	// Set when every account failed; windows then hold the last good reading.
	error?: string;
};
// The cache is shared tmp state, so it holds readings only: no tokens and no account
// identity (email, user or account ids) ever reach it; identities stay in process memory.
export type LimitsCache = { version: number; checkedAt: number; fetches: number; fetchedBy: number; providers: ProviderLimits[] };

type Account = { provider: "claude" | "chatgpt"; access: string; refresh?: string; accountId?: string; email?: string };
export type AccountIdentity = { provider: "claude" | "chatgpt"; email: string };
type AccountReading = { windows: LimitWindow[]; spend?: LimitSpend; plan?: string };

type OAuthSlot = { access?: unknown; refresh?: unknown; expires?: unknown; accountId?: unknown };
type OAuthCredential = OAuthSlot & { type?: unknown; accounts?: unknown };
type Slot = { access: string; refresh?: string; expires?: number; accountId?: string };

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

function chatgptAccountId(token: string): string | undefined {
	const auth = jwtClaims(token)?.["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function chatgptEmail(token: string): string | undefined {
	const profile = jwtClaims(token)?.["https://api.openai.com/profile"] as { email?: unknown } | undefined;
	return typeof profile?.email === "string" && profile.email !== "" ? profile.email : undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// Multi-account credentials keep a valid flat copy of one slot at the top level; the slots
// in `accounts` are authoritative when present.
function oauthSlots(credential: unknown): Slot[] {
	const flat = credential as OAuthCredential | undefined;
	if (!flat || flat.type !== "oauth") return [];
	const slots = Array.isArray(flat.accounts) && flat.accounts.length > 0 ? (flat.accounts as OAuthSlot[]) : [flat];
	return slots.flatMap((slot) => {
		const access = text(slot.access);
		if (!access) return [];
		const accountId = text(slot.accountId) ?? (access === flat.access ? text(flat.accountId) : undefined);
		return [{ access, refresh: text(slot.refresh), expires: typeof slot.expires === "number" ? slot.expires : undefined, accountId }];
	});
}

// Tokens are only read: Pi, OmO, and Codex each rotate their own refresh tokens, and a
// refresh from here would invalidate the copy the owning harness holds. Expired tokens are
// skipped until their owner refreshes them. Every harness's store is read, whichever one
// runs this, so the shared cache holds the same account set for all processes.
export function discoverAccounts(now = Date.now()): Account[] {
	const home = homedir();
	const agentDirs = new Set(
		[
			process.env.PI_CODING_AGENT_DIR,
			process.env.OMO_CODING_AGENT_DIR,
			process.env.SENPI_CODING_AGENT_DIR,
			join(home, ".pi", "agent"),
			join(home, ".omo", "agent"),
		].filter((dir): dir is string => Boolean(dir)),
	);
	const claude: Account[] = [];
	const chatgpt = new Map<string, Account>();
	const live = (expires: number | undefined) => expires === undefined || expires > now;
	// One login imported into both Claude providers shares a token pair; counting it twice
	// would skew the account count.
	const addClaude = (slot: Slot) => {
		const duplicate = claude.some(
			(account) => account.access === slot.access || (slot.refresh !== undefined && account.refresh === slot.refresh),
		);
		if (!duplicate) claude.push({ provider: "claude", access: slot.access, refresh: slot.refresh });
	};
	for (const dir of agentDirs) {
		const auth = readJson(join(dir, "auth.json")) as Record<string, unknown> | undefined;
		if (!auth || typeof auth !== "object") continue;
		for (const provider of ["anthropic", "anthropic-subscription"]) {
			for (const slot of oauthSlots(auth[provider])) if (live(slot.expires) && slot.access.startsWith("sk-ant-oat")) addClaude(slot);
		}
		for (const provider of ["chatgpt-subscription", "openai-codex"]) {
			for (const slot of oauthSlots(auth[provider])) {
				const accountId = slot.accountId ?? chatgptAccountId(slot.access);
				if (live(slot.expires) && accountId) {
					chatgpt.set(accountId, { provider: "chatgpt", access: slot.access, accountId, email: chatgptEmail(slot.access) });
				}
			}
		}
	}
	const codex = readJson(join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json")) as
		| { tokens?: { access_token?: unknown; account_id?: unknown } }
		| undefined;
	const access = text(codex?.tokens?.access_token);
	if (access) {
		const exp = jwtClaims(access)?.exp;
		const accountId = text(codex?.tokens?.account_id) ?? chatgptAccountId(access);
		if (accountId && !chatgpt.has(accountId) && live(typeof exp === "number" ? exp * 1000 : undefined)) {
			chatgpt.set(accountId, { provider: "chatgpt", access, accountId, email: chatgptEmail(access) });
		}
	}
	return [...claude, ...chatgpt.values()];
}

type RawClaudeWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawClaudeLimit = {
	kind?: string;
	percent?: number;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string | null } | null } | null;
};
type RawMoney = { amount_minor: number; currency: string; exponent: number };
type RawClaudeUsage = {
	five_hour?: RawClaudeWindow;
	seven_day?: RawClaudeWindow;
	limits?: RawClaudeLimit[] | null;
	spend?: { used?: RawMoney | null; limit?: RawMoney | null; percent?: number | null; enabled?: boolean } | null;
};

const parseTime = (value: string | null | undefined) => (value ? Date.parse(value) : undefined);

export function parseClaude(raw: RawClaudeUsage): AccountReading {
	const fromLimit = (limit: RawClaudeLimit): LimitWindow => {
		const model = limit.scope?.model?.display_name;
		const session = limit.kind === "session";
		return {
			label: session ? "5h" : model ? `7d ${model}` : "7d",
			percent: limit.percent ?? 0,
			resetsAt: parseTime(limit.resets_at),
			windowMs: session ? FIVE_HOURS_MS : SEVEN_DAYS_MS,
		};
	};
	// `limits` carries per-model weekly caps too; the older window fields are the fallback.
	const windows = raw.limits?.length
		? raw.limits.map(fromLimit)
		: (
				[
					["5h", raw.five_hour, FIVE_HOURS_MS],
					["7d", raw.seven_day, SEVEN_DAYS_MS],
				] as const
			).flatMap(([label, window, windowMs]) =>
				window ? [{ label, percent: window.utilization ?? 0, resetsAt: parseTime(window.resets_at), windowMs }] : [],
			);
	const money = (value: RawMoney) => value.amount_minor / 10 ** value.exponent;
	const spend = raw.spend;
	return {
		windows,
		spend:
			spend?.enabled && spend.used && spend.limit
				? { used: money(spend.used), limit: money(spend.limit), currency: spend.limit.currency, percent: spend.percent ?? 0 }
				: undefined,
	};
}

type RawChatgptWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
} | null;
type RawChatgptUsage = { plan_type?: string; rate_limit?: { primary_window?: RawChatgptWindow; secondary_window?: RawChatgptWindow } | null };

function windowLabel(seconds: number): string {
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return `${Math.round(seconds / 60)}m`;
}

export function parseChatgpt(raw: RawChatgptUsage, now: number): AccountReading {
	const windows = [raw.rate_limit?.primary_window, raw.rate_limit?.secondary_window].flatMap((window) => {
		if (!window || typeof window.limit_window_seconds !== "number") return [];
		const resetsAt =
			typeof window.reset_at === "number"
				? window.reset_at * 1000
				: typeof window.reset_after_seconds === "number"
					? now + window.reset_after_seconds * 1000
					: undefined;
		return [
			{
				label: windowLabel(window.limit_window_seconds),
				percent: window.used_percent ?? 0,
				resetsAt,
				windowMs: window.limit_window_seconds * 1000,
			},
		];
	});
	return { windows, plan: raw.plan_type };
}

async function fetchAccount(account: Account): Promise<AccountReading> {
	const now = Date.now();
	const headers: Record<string, string> =
		account.provider === "claude"
			? { Authorization: `Bearer ${account.access}`, "anthropic-beta": "oauth-2025-04-20" }
			: { Authorization: `Bearer ${account.access}`, "chatgpt-account-id": account.accountId ?? "", "User-Agent": "codex_cli_rs" };
	const response = await fetch(account.provider === "claude" ? CLAUDE_USAGE_URL : CHATGPT_USAGE_URL, {
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	// Only the status leaves this function: error bodies can echo request details.
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = await response.json();
	return account.provider === "claude" ? parseClaude(body as RawClaudeUsage) : parseChatgpt(body as RawChatgptUsage, now);
}

// Keyed by access token, so a rotated token re-resolves once and no process asks twice.
const claudeEmails = new Map<string, Promise<string | undefined>>();

function claudeEmail(access: string): Promise<string | undefined> {
	const known = claudeEmails.get(access);
	if (known) return known;
	const pending = fetch(CLAUDE_PROFILE_URL, {
		headers: { Authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { account?: { email?: unknown } };
			return text(body.account?.email);
		})
		.catch(() => {
			// Forget the failure so the next limits update retries; the section just omits the email.
			claudeEmails.delete(access);
			return undefined;
		});
	claudeEmails.set(access, pending);
	return pending;
}

// Signed-in accounts per provider, in discovery order. Resolved per process and never
// written to the shared cache.
export async function accountIdentities(): Promise<AccountIdentity[]> {
	const accounts = discoverAccounts();
	const live = new Set(accounts.map((account) => account.access));
	for (const access of claudeEmails.keys()) if (!live.has(access)) claudeEmails.delete(access);
	const emails = await Promise.all(
		accounts.map((account) => (account.provider === "claude" ? claudeEmail(account.access) : Promise.resolve(account.email))),
	);
	return accounts.flatMap((account, index) => {
		const email = emails[index];
		return email ? [{ provider: account.provider, email }] : [];
	});
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// Accounts of one provider share a window set, so the group shows each window's mean; a
// window only some accounts report (a per-model cap) averages over those accounts.
export function pool(readings: AccountReading[]): Pick<ProviderLimits, "windows" | "spend" | "plan"> {
	const byLabel = new Map<string, LimitWindow[]>();
	for (const reading of readings) {
		for (const window of reading.windows) byLabel.set(window.label, [...(byLabel.get(window.label) ?? []), window]);
	}
	const windows = [...byLabel.entries()].map(([label, group]) => {
		const resets = group.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]));
		return {
			label,
			percent: average(group.map((window) => window.percent)),
			resetsAt: resets.length ? average(resets) : undefined,
			windowMs: group[0]?.windowMs,
		};
	});
	const spends = readings.flatMap((reading) => (reading.spend ? [reading.spend] : []));
	const used = spends.reduce((sum, spend) => sum + spend.used, 0);
	const limit = spends.reduce((sum, spend) => sum + spend.limit, 0);
	const plans = new Set(readings.flatMap((reading) => (reading.plan ? [reading.plan] : [])));
	return {
		windows,
		spend: spends.length && limit > 0 ? { used, limit, currency: spends[0]!.currency, percent: (used / limit) * 100 } : undefined,
		plan: plans.size === 1 ? [...plans][0] : undefined,
	};
}

async function fetchProviders(previous: LimitsCache | undefined): Promise<ProviderLimits[]> {
	const accounts = discoverAccounts();
	const titles = { claude: "Claude", chatgpt: "ChatGPT" } as const;
	const results = await Promise.all(
		accounts.map((account) =>
			fetchAccount(account).then(
				(reading) => ({ provider: account.provider, reading, error: undefined }),
				(error: unknown) => ({
					provider: account.provider,
					reading: undefined,
					error: error instanceof Error ? error.message : String(error),
				}),
			),
		),
	);
	return (["claude", "chatgpt"] as const).flatMap((id): ProviderLimits[] => {
		const mine = results.filter((result) => result.provider === id);
		if (mine.length === 0) return [];
		const readings = mine.flatMap((result) => (result.reading ? [result.reading] : []));
		const base = { id, title: titles[id], accounts: mine.length, ok: readings.length };
		if (readings.length > 0) return [{ ...base, ...pool(readings) }];
		const last = previous?.providers.find((provider) => provider.id === id);
		const error = mine.find((result) => result.error)?.error ?? "failed";
		return [{ ...base, windows: last?.windows ?? [], spend: last?.spend, plan: last?.plan, error }];
	});
}

function readCache(): LimitsCache | undefined {
	const cache = readJson(CACHE_PATH) as LimitsCache | undefined;
	return cache?.version === CACHE_VERSION && Array.isArray(cache.providers) ? cache : undefined;
}

function writeCache(cache: LimitsCache): void {
	const temp = `${CACHE_PATH}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
	renameSync(temp, CACHE_PATH);
}

function tryLock(): string | undefined {
	const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(LOCK_PATH, "wx", 0o600);
			writeSync(fd, token);
			closeSync(fd);
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try {
				if (Date.now() - statSync(LOCK_PATH).mtimeMs < LOCK_STALE_MS) return undefined;
				unlinkSync(LOCK_PATH);
			} catch {
				// The holder released it between the open and the stat; the next attempt races fairly.
			}
		}
	}
	return undefined;
}

function unlock(token: string): void {
	try {
		if (readFileSync(LOCK_PATH, "utf8") === token) unlinkSync(LOCK_PATH);
	} catch {
		// Already gone, or a stale-lock takeover replaced it; either way it is not ours to remove.
	}
}

const fresh = (cache: LimitsCache | undefined, now: number): boolean => cache !== undefined && now - cache.checkedAt < LIMITS_TTL_MS;

// Every caller (interval re-read, after-turn refresh, first mount) goes through this gate,
// so nothing fetches more often than the TTL regardless of how many processes run.
export function createLimitsPoller(onUpdate: (cache: LimitsCache | undefined) => void) {
	let running = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let current: LimitsCache | undefined;

	const publish = (cache: LimitsCache | undefined) => {
		if (cache === current || (cache && current && cache.checkedAt === current.checkedAt && cache.fetches === current.fetches)) return;
		current = cache;
		onUpdate(cache);
	};

	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const cached = readCache();
			if (fresh(cached, Date.now())) return publish(cached);
			const token = tryLock();
			if (!token) {
				// Another process is fetching; pick its result up sooner than the next re-read.
				publish(cached);
				if (!retry) {
					retry = setTimeout(() => {
						retry = undefined;
						void tick();
					}, LOCK_BUSY_RETRY_MS);
					retry.unref?.();
				}
				return;
			}
			try {
				// The lock holder before us may have just written a fresh reading.
				const latest = readCache();
				if (fresh(latest, Date.now())) return publish(latest);
				const providers = await fetchProviders(latest);
				const next: LimitsCache = {
					version: CACHE_VERSION,
					checkedAt: Date.now(),
					fetches: (latest?.fetches ?? 0) + 1,
					fetchedBy: process.pid,
					providers,
				};
				writeCache(next);
				publish(next);
			} finally {
				unlock(token);
			}
		} catch {
			// A cache or lock write failure (full tmpdir) only costs this round; the next tick retries.
		} finally {
			running = false;
		}
	};

	return {
		tick,
		stop() {
			if (retry) clearTimeout(retry);
			retry = undefined;
		},
	};
}
