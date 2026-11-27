// Several Claude subscription accounts behind one Models: a request that hits an account's usage limit before any
// content streamed continues on the next account, and routing returns to the first one once its window resets.
// See docs/pi-durable.md, "Accounts".

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	type Context,
	createAssistantMessageEventStream,
	type Credential,
	type CredentialInfo,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type LoginOptions,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelType,
	type ModelTypeMap,
	type Provider,
} from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, getAgentDir, ModelRuntime } from "#pi/index.js";

/** Account 0: the agent dir's own auth.json, the login pi and every other harness use. */
export const MAIN_ACCOUNT = "main";
/** Only Claude subscriptions are pooled; every other provider goes straight to the primary runtime. */
export const POOLED_PROVIDER = "anthropic";
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const DEFAULT_BLOCK_MS = 5 * 60_000;
const REJECTED_BLOCK_MS = 60 * 60_000;
/** A short retry-after would otherwise flip between accounts on every request. */
const MIN_BLOCK_MS = 30_000;
const LIMIT_ERROR = /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|usage.?limit|too many requests|quota/iu;
const AUTH_ERROR =
	/Provider is not configured|OAuth refresh|OAuth auth derivation|Credential store|API key auth failed|authentication_error|(?<![a-z0-9])401(?![a-z0-9])/iu;

export type BlockReason = "limit" | "auth";
export interface AccountBlock {
	readonly blockedUntil: number;
	readonly reason: BlockReason;
}

export function accountsDir(agentDir = getAgentDir()): string {
	return join(agentDir, "accounts");
}

export function validAccountName(name: string): boolean {
	return NAME.test(name);
}

export function authPathOf(name: string, agentDir = getAgentDir()): string {
	return name === MAIN_ACCOUNT ? join(agentDir, "auth.json") : join(accountsDir(agentDir), name, "auth.json");
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** `accounts/order.json`, which `accounts login` appends to; accounts it does not list follow, sorted by name. */
function orderPath(agentDir: string): string {
	return join(accountsDir(agentDir), "order.json");
}

/** The extra accounts (not `main`), in fallback order: those with an auth.json under `accounts/<name>/`. */
export function extraAccountNames(agentDir = getAgentDir()): string[] {
	let found: string[];
	try {
		found = readdirSync(accountsDir(agentDir), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && validAccountName(entry.name) && entry.name !== MAIN_ACCOUNT)
			.map((entry) => entry.name)
			// An auth.json with no credential is a sign-in still under way, or one Pi recreated empty for a runtime
			// still open on a removed account; neither is an account.
			.filter((name) => hasCredential(authPathOf(name, agentDir)));
	} catch {
		return [];
	}
	const listed = readJson(orderPath(agentDir));
	const order = Array.isArray(listed) ? listed.filter((name): name is string => typeof name === "string") : [];
	return [...order.filter((name) => found.includes(name)), ...found.filter((name) => !order.includes(name)).sort()];
}

export function setAccountOrder(agentDir: string, change: (order: string[]) => string[]): void {
	const listed = readJson(orderPath(agentDir));
	const order = Array.isArray(listed) ? listed.filter((name): name is string => typeof name === "string") : [];
	writeJsonAtomic(orderPath(agentDir), [...new Set(change(order))]);
}

function hasCredential(authPath: string): boolean {
	const auth = readJson(authPath);
	return typeof auth === "object" && auth !== null && Object.keys(auth).length > 0;
}

/** Whether an auth file holds a Claude login; only the key's presence is read. */
export function signedIn(name: string, agentDir = getAgentDir()): boolean {
	const auth = readJson(authPathOf(name, agentDir)) as Record<string, unknown> | undefined;
	return auth?.[POOLED_PROVIDER] !== undefined;
}

/** After a sign-in: an extra account joins the end of the fallback order, and any block it had is lifted. */
export function recordLogin(name: string, agentDir = getAgentDir()): void {
	if (name !== MAIN_ACCOUNT) setAccountOrder(agentDir, (order) => [...order, name]);
	accountState(agentDir).clear(name);
}

/** Delete an extra account: its directory (and auth.json), its place in the order and its block. */
export function removeAccount(name: string, agentDir = getAgentDir()): void {
	if (name === MAIN_ACCOUNT || !validAccountName(name)) throw new Error(`Not an extra Claude account: ${name}`);
	rmSync(join(accountsDir(agentDir), name), { recursive: true, force: true });
	setAccountOrder(agentDir, (order) => order.filter((entry) => entry !== name));
	accountState(agentDir).clear(name);
}

export interface LoginAccountOptions {
	readonly agentDir?: string;
	readonly getDeviceId?: () => string;
}

/**
 * Sign a Claude account in on its own auth.json (`main`: the agent dir's own), through pi's OAuth login with the
 * caller's prompts: the terminal for `pi-durable accounts login`, a dialog for `/accounts add`. Returns the auth path.
 */
export async function loginAccount(
	name: string,
	interaction: AuthInteraction,
	options: LoginAccountOptions = {},
): Promise<string> {
	if (!validAccountName(name)) throw new Error(`Account names are lowercase letters, digits, - and _ (up to 32): ${name}`);
	const agentDir = options.agentDir ?? getAgentDir();
	const authPath = authPathOf(name, agentDir);
	const made = name === MAIN_ACCOUNT ? undefined : mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	try {
		const runtime = await ModelRuntime.create({ authPath, refreshOnCreate: false });
		try {
			await runtime.login(POOLED_PROVIDER, "oauth", interaction, {
				...(options.getDeviceId === undefined ? {} : { getDeviceId: options.getDeviceId }),
			});
		} catch (error) {
			// The credentials are stored; only this throwaway runtime's model state lagged, which nothing reads.
			if (!(error instanceof CredentialSynchronizationError)) throw error;
		}
		await runtime.settleCredentialWrites();
	} catch (error) {
		// A cancelled first sign-in leaves no empty account directory behind.
		if (made !== undefined && !signedIn(name, agentDir)) {
			rmSync(dirname(authPath), { recursive: true, force: true });
		}
		throw error;
	}
	recordLogin(name, agentDir);
	return authPath;
}

/** One login: `main` for each provider in the agent dir's auth.json, plus the extra Claude accounts. */
export interface AccountRow {
	readonly provider: string;
	readonly name: string;
	readonly signedIn: boolean;
	/** The stored credential's type, when signed in. */
	readonly type?: CredentialInfo["type"];
	/** Whether requests fall back across this provider's accounts (only Claude, with more than one account). */
	readonly pooled: boolean;
	readonly active: boolean;
	readonly block?: AccountBlock;
	readonly authPath: string;
}

export interface ProviderAccounts {
	readonly id: string;
	readonly name: string;
	readonly accounts: readonly AccountRow[];
}

export interface OverviewInput {
	readonly agentDir?: string;
	/** What pi's credential store holds for the agent dir's own auth.json (`ModelRuntime.listCredentials()`). */
	readonly credentials: readonly CredentialInfo[];
	readonly providerName?: (id: string) => string | undefined;
	/** The pooled account requests go to. */
	readonly active?: string;
	readonly now?: number;
}

/**
 * Every login by provider: Claude first (always listed, with its extra accounts after `main`), then each other
 * provider the agent dir's auth.json holds a credential for, by id. Only Claude pools accounts today; another provider
 * that gains extra accounts would list them the same way.
 */
export function accountsOverview(input: OverviewInput): ProviderAccounts[] {
	const agentDir = input.agentDir ?? getAgentDir();
	const now = input.now ?? Date.now();
	const blocks = accountState(agentDir).read();
	const extras = extraAccountNames(agentDir);
	const pooled = extras.length > 0;
	const types = new Map(input.credentials.map((credential) => [credential.providerId, credential.type]));
	const ids = [POOLED_PROVIDER, ...[...types.keys()].filter((id) => id !== POOLED_PROVIDER).sort()];
	return ids.map((id): ProviderAccounts => {
		const row = (name: string, type: CredentialInfo["type"] | undefined): AccountRow => {
			const block = id === POOLED_PROVIDER && pooled ? blocks[name] : undefined;
			return {
				provider: id,
				name,
				signedIn: type !== undefined,
				...(type === undefined ? {} : { type }),
				pooled: id === POOLED_PROVIDER && pooled,
				active: id === POOLED_PROVIDER && pooled && name === (input.active ?? MAIN_ACCOUNT),
				...(block !== undefined && block.blockedUntil > now ? { block } : {}),
				authPath: authPathOf(name, agentDir),
			};
		};
		const accounts = [row(MAIN_ACCOUNT, types.get(id))];
		if (id === POOLED_PROVIDER) {
			for (const name of extras) accounts.push(row(name, signedIn(name, agentDir) ? "oauth" : undefined));
		}
		return { id, name: input.providerName?.(id) ?? id, accounts };
	});
}

/** A block in words, for `accounts list` and `/accounts`; undefined when the account is free. */
export function blockText(block: AccountBlock | undefined, now = Date.now()): string | undefined {
	if (block === undefined || block.blockedUntil <= now) return undefined;
	return block.reason === "auth"
		? `auth failed, skipped until ${clock(block.blockedUntil, now)}`
		: `limited until ${clock(block.blockedUntil, now)}`;
}

/**
 * Account blocks shared by every pi-durable process: `accounts/state.json`, name to `{ blockedUntil, reason }`. No
 * credentials go in it. Re-read only when its mtime or size moves, written whole through a rename.
 */
export class AccountState {
	readonly path: string;
	readonly #now: () => number;
	#stamp = "";
	#blocks: Record<string, AccountBlock> = {};

	constructor(path: string, now: () => number = Date.now) {
		this.path = path;
		this.#now = now;
	}

	read(): Readonly<Record<string, AccountBlock>> {
		const stat = statSync(this.path, { throwIfNoEntry: false });
		const stamp = stat === undefined ? "" : `${stat.mtimeMs}:${stat.size}`;
		if (stamp !== this.#stamp) {
			this.#stamp = stamp;
			this.#blocks = stat === undefined ? {} : parseBlocks(readJson(this.path));
		}
		return this.#blocks;
	}

	update(change: (blocks: Record<string, AccountBlock>) => void): void {
		const now = this.#now();
		this.#stamp = "";
		const blocks = { ...this.read() };
		change(blocks);
		for (const [name, block] of Object.entries(blocks)) if (block.blockedUntil <= now) delete blocks[name];
		writeJsonAtomic(this.path, blocks);
		this.#stamp = "";
		this.#blocks = blocks;
	}

	block(name: string, block: AccountBlock): void {
		this.update((blocks) => {
			blocks[name] = block;
		});
	}

	clear(name: string): void {
		if (this.read()[name] === undefined) return;
		this.update((blocks) => {
			delete blocks[name];
		});
	}
}

function parseBlocks(value: unknown): Record<string, AccountBlock> {
	if (value === null || typeof value !== "object") return {};
	const blocks: Record<string, AccountBlock> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		const block = raw as { blockedUntil?: unknown; reason?: unknown } | null;
		if (typeof block?.blockedUntil !== "number") continue;
		blocks[name] = { blockedUntil: block.blockedUntil, reason: block.reason === "auth" ? "auth" : "limit" };
	}
	return blocks;
}

export function accountState(agentDir = getAgentDir()): AccountState {
	return new AccountState(join(accountsDir(agentDir), "state.json"));
}

/** One account: its name and its own Models, opened on first use. */
export interface PoolAccount {
	readonly name: string;
	open(): Promise<Models>;
}

export interface AccountStatus {
	readonly name: string;
	readonly active: boolean;
	readonly blockedUntil?: number;
	readonly reason?: BlockReason;
}

interface Seen {
	status?: number;
	headers?: Record<string, string>;
}

/** When a limited account is usable again, from the last response's rate-limit headers. */
export function limitedUntil(seen: Seen, now: number): number {
	const headers = seen.headers ?? {};
	const reset = Number(headers["anthropic-ratelimit-unified-reset"]);
	let until: number;
	if (Number.isFinite(reset) && reset * 1000 > now) until = reset * 1000;
	else if (Number(headers["retry-after"]) > 0) until = now + Number(headers["retry-after"]) * 1000;
	else if (headers["anthropic-ratelimit-unified-status"] === "rejected") until = now + REJECTED_BLOCK_MS;
	else until = now + DEFAULT_BLOCK_MS;
	return Math.max(until, now + MIN_BLOCK_MS);
}

export function clock(at: number, now = Date.now()): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	return at - now > 20 * 3_600_000 ? `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}` : time;
}

type Notify = (level: "info" | "warning", message: string) => void;

export interface AccountPoolOptions {
	readonly primary: Models;
	/** Every account in fallback order; the first is `main` and opens the primary. */
	readonly accounts: readonly PoolAccount[];
	readonly state: AccountState;
	readonly now?: () => number;
}

/**
 * pi-ai `Models` over several Claude accounts. Everything but requests goes to the primary runtime (account 0); a
 * request for the pooled provider goes to the first account not blocked. An error that is a usage limit (or, on an
 * extra account, missing or broken auth) before the first content event blocks that account and sends the same
 * request to the next one; the events before content are held back, so the caller sees one response. With every
 * account blocked the last error passes through unchanged, for the Harness's own retry.
 */
export class AccountPool implements Models {
	readonly #primary: Models;
	#accounts: readonly PoolAccount[];
	readonly #state: AccountState;
	readonly #now: () => number;
	readonly #opened = new Map<string, Promise<Models>>();
	/** Deferred responses are fetched from the account that started them. */
	readonly #deferred = new Map<string, string>();
	#active: string;
	onNotice: Notify = () => {};
	onChange: () => void = () => {};

	constructor(options: AccountPoolOptions) {
		this.#primary = options.primary;
		this.#accounts = options.accounts;
		this.#state = options.state;
		this.#now = options.now ?? Date.now;
		this.#active = this.#pick(new Set())?.name ?? MAIN_ACCOUNT;
	}

	/** The account the latest Claude request went to. */
	get active(): string {
		return this.#active;
	}

	/** How many accounts requests fall back across; with one, requests go straight to the primary. */
	get size(): number {
		return this.#accounts.length;
	}

	/** The accounts in fallback order. */
	get names(): string[] {
		return this.#accounts.map((account) => account.name);
	}

	/**
	 * Replace the accounts, for one added or removed while the session is open. Accounts kept keep their opened Models,
	 * except those in `fresh` (signed in again on disk), which are reopened on their next request.
	 */
	setAccounts(accounts: readonly PoolAccount[], fresh: readonly string[] = []): void {
		const names = new Set(accounts.map((account) => account.name));
		for (const [name, opened] of this.#opened) {
			if (names.has(name) && !fresh.includes(name)) continue;
			this.#opened.delete(name);
			// A dropped runtime still finishes the token write it may have in flight.
			void opened
				.then((models) => (models !== this.#primary && models instanceof ModelRuntime ? models.settleCredentialWrites() : undefined))
				.catch(() => {});
		}
		this.#accounts = accounts;
		if (!names.has(this.#active)) this.#active = this.#pick(new Set())?.name ?? MAIN_ACCOUNT;
		this.onChange();
	}

	status(): AccountStatus[] {
		const blocks = this.#state.read();
		const now = this.#now();
		return this.#accounts.map((account) => {
			const block = blocks[account.name];
			const live = block !== undefined && block.blockedUntil > now;
			return {
				name: account.name,
				active: account.name === this.#active,
				...(live ? { blockedUntil: block.blockedUntil, reason: block.reason } : {}),
			};
		});
	}

	/** Wait for token refreshes in flight on every opened account, so a rotated token is not lost. */
	async settle(): Promise<void> {
		for (const opened of this.#opened.values()) {
			const models = await opened.catch(() => undefined);
			if (models !== this.#primary && models instanceof ModelRuntime) await models.settleCredentialWrites();
		}
	}

	#open(account: PoolAccount): Promise<Models> {
		let opened = this.#opened.get(account.name);
		if (opened === undefined) {
			opened = account.open();
			this.#opened.set(account.name, opened);
			// A failed open is retried by the next request.
			opened.catch(() => this.#opened.delete(account.name));
		}
		return opened;
	}

	#blocked(name: string): AccountBlock | undefined {
		const block = this.#state.read()[name];
		return block !== undefined && block.blockedUntil > this.#now() ? block : undefined;
	}

	/** The first untried account not blocked; with every account blocked and none tried, the one free soonest. */
	#pick(tried: ReadonlySet<string>): PoolAccount | undefined {
		const free = this.#accounts.find((account) => !tried.has(account.name) && this.#blocked(account.name) === undefined);
		if (free !== undefined || tried.size > 0) return free;
		const blocks = this.#state.read();
		return [...this.#accounts].sort(
			(left, right) => (blocks[left.name]?.blockedUntil ?? 0) - (blocks[right.name]?.blockedUntil ?? 0),
		)[0];
	}

	#block(name: string, block: AccountBlock): void {
		try {
			this.#state.block(name, block);
		} catch (error) {
			this.onNotice("warning", `Could not record the block of Claude account "${name}": ${String(error)}`);
		}
		this.onChange();
	}

	/** One request, routed across the accounts for the pooled provider. */
	#route(
		model: { provider: string },
		options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } | undefined,
		start: (models: Models, options: never) => AssistantMessageEventStream,
		pinned?: string,
	): AssistantMessageEventStream {
		if (model.provider !== POOLED_PROVIDER || this.#accounts.length < 2) return start(this.#primary, options as never);
		const out = createAssistantMessageEventStream();
		void this.#run(options, start, out, pinned).catch((error: unknown) => {
			const message = errorMessage(model as Model<Api>, error, options?.signal?.aborted === true);
			out.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
			out.end(message);
		});
		return out;
	}

	async #run(
		options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } | undefined,
		start: (models: Models, options: never) => AssistantMessageEventStream,
		out: AssistantMessageEventStream,
		pinned: string | undefined,
	): Promise<void> {
		const tried = new Set<string>();
		const previous = this.#active;
		for (;;) {
			const account =
				pinned === undefined ? this.#pick(tried) : this.#accounts.find((candidate) => candidate.name === pinned);
			if (account === undefined) throw new Error("No Claude account to send the request to");
			tried.add(account.name);
			const extra = account.name !== this.#accounts[0]?.name;
			const next = () => (pinned === undefined ? this.#pick(tried) : undefined);

			const models = await this.#open(account);
			if (extra && pinned === undefined && (await models.checkAuth(POOLED_PROVIDER).catch(() => undefined)) === undefined) {
				this.#block(account.name, { blockedUntil: this.#now() + REJECTED_BLOCK_MS, reason: "auth" });
				const following = next();
				// With no other account free the request still goes out, and its error is what the caller sees.
				if (following !== undefined) {
					this.onNotice(
						"warning",
						`Claude account "${account.name}" is not signed in (/accounts add ${account.name}); continuing on "${following.name}"`,
					);
					continue;
				}
			}

			const seen: Seen = {};
			const base = options?.fetch ?? globalThis.fetch;
			const watched: typeof globalThis.fetch = async (input, init) => {
				const response = await base(input, init);
				seen.status = response.status;
				seen.headers = Object.fromEntries(response.headers);
				return response;
			};
			const inner = start(models, { ...options, fetch: watched } as never);
			const held: AssistantMessageEvent[] = [];
			let streaming = false;
			let failedOver = false;
			for await (const event of inner) {
				if (!streaming) {
					if (event.type === "start") {
						held.push(event);
						continue;
					}
					if (event.type === "error" && event.reason === "error" && options?.signal?.aborted !== true) {
						const reason = failure(event.error, seen, extra);
						if (reason !== undefined) {
							const now = this.#now();
							const until = reason === "limit" ? limitedUntil(seen, now) : now + REJECTED_BLOCK_MS;
							this.#block(account.name, { blockedUntil: until, reason });
							const following = next();
							const what =
								reason === "limit"
									? `Claude account "${account.name}" limited until ${clock(until, now)}`
									: `Claude account "${account.name}" failed to authenticate (/accounts add ${account.name})`;
							this.onNotice("warning", following === undefined ? `${what}; no other account is free` : `${what}; continuing on "${following.name}"`);
							if (following !== undefined) {
								failedOver = true;
								break;
							}
						}
					}
					streaming = true;
					for (const kept of held) out.push(kept);
				}
				out.push(event);
			}
			if (failedOver) continue;
			for (const kept of streaming ? [] : held) out.push(kept);
			const result = await inner.result();
			if (result.deferred !== undefined) this.#deferred.set(handleKey(result.deferred), account.name);
			out.end(result);
			// An account removed while this request ran stays out of the active slot.
			if (this.#active !== account.name && this.#accounts.some((candidate) => candidate.name === account.name)) {
				this.#active = account.name;
				const order = (name: string) => this.#accounts.findIndex((candidate) => candidate.name === name);
				if (tried.size === 1 && order(account.name) < order(previous)) {
					this.onNotice("info", `Claude account "${account.name}" is free again; requests are back on it`);
				}
				this.onChange();
			}
			return;
		}
	}

	stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream {
		return this.#route(model, options as never, (models, routed: ModelsApiStreamOptions<TApi>) =>
			models.stream(model, context, routed),
		);
	}

	complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.#route(model, options, (models, routed: ModelsSimpleStreamOptions) => models.streamSimple(model, context, routed));
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions): AssistantMessageEventStream {
		const pinned = this.#deferred.get(handleKey(handle)) ?? MAIN_ACCOUNT;
		return this.#route(
			model,
			options,
			(models, routed: ModelsDeferredFetchOptions) => models.streamDeferred(model, handle, routed),
			pinned,
		);
	}

	fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredFetchOptions): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void> {
		const name = model.provider === POOLED_PROVIDER ? this.#deferred.get(handleKey(handle)) : undefined;
		const account = this.#accounts.find((candidate) => candidate.name === name);
		const models = account === undefined ? this.#primary : await this.#open(account);
		this.#deferred.delete(handleKey(handle));
		await models.cancelDeferred(model, handle, options);
	}

	getProviders(): readonly Provider[] {
		return this.#primary.getProviders();
	}
	getProvider(id: string): Provider | undefined {
		return this.#primary.getProvider(id);
	}
	getModels(provider?: string): readonly Model<Api>[] {
		return this.#primary.getModels(provider);
	}
	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.#primary.getModel(provider, id);
	}
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.#primary.getModelsOfType(type, provider);
	}
	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		return this.#primary.getModelOfType(type, provider, id);
	}
	getAllModels(provider?: string): readonly AnyModel[] {
		return this.#primary.getAllModels(provider);
	}
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.#primary.refresh(options);
	}
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.#primary.checkAuth(providerId, options);
	}
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.#primary.getAvailable(providerId, options);
	}
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.#primary.getAvailableOfType(type, providerId, options);
	}
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.#primary.getAllAvailable(providerId, options);
	}
	getAuth(providerId: string, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined>;
	getAuth(target: string | AnyModel, overrides?: Parameters<Models["getAuth"]>[1]): Promise<AuthResult | undefined> {
		return this.#primary.getAuth(target as never, overrides);
	}
	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential> {
		return this.#primary.login(providerId, type, interaction, options);
	}
	logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#primary.logout(providerId, options);
	}
	generateImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: ModelsImagesOptions): Promise<AssistantImages> {
		return this.#primary.generateImages(model, context, options);
	}
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.#primary.classify(model, context, options);
	}
}

function handleKey(handle: DeferredHandle): string {
	return JSON.stringify(handle);
}

/** Why an error before any content should move the request to another account, if it should. */
export function failure(message: AssistantMessage, seen: Seen, extra: boolean): BlockReason | undefined {
	const text = message.errorMessage ?? "";
	if (seen.status === 429 || LIMIT_ERROR.test(text)) return "limit";
	// The main login is the user's own to fix; an extra account that lost its login is skipped instead.
	if (extra && (seen.status === 401 || AUTH_ERROR.test(text))) return "auth";
	return undefined;
}

function errorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export interface Accounts {
	/** What the Harness and every request use; with one account it passes everything to the primary. */
	readonly models: Models;
	readonly pool: AccountPool;
	/** Re-read the accounts from disk (one added or removed); `fresh` names those signed in again. */
	reload(fresh?: readonly string[]): void;
	/** Reload when the accounts on disk differ from the pool's, as after `pi-durable accounts` in another shell. */
	sync(): void;
}

/**
 * The accounts of an agent dir over `primary` (its `main`). Extra accounts each get their own ModelRuntime on their own
 * auth.json, opened on first use, so each refreshes and rotates its own tokens. The pool is there even with one
 * account, so one added later (`/accounts add`) joins without reopening the session.
 */
export function openAccounts(primary: ModelRuntime, agentDir = getAgentDir()): Accounts {
	const read = (): PoolAccount[] => [
		{ name: MAIN_ACCOUNT, open: async () => primary },
		...extraAccountNames(agentDir).map(
			(name): PoolAccount => ({
				name,
				open: () => ModelRuntime.create({ authPath: authPathOf(name, agentDir), refreshOnCreate: false }),
			}),
		),
	];
	const pool = new AccountPool({ primary, accounts: read(), state: accountState(agentDir) });
	return {
		models: pool,
		pool,
		reload: (fresh) => pool.setAccounts(read(), fresh),
		sync: () => {
			const accounts = read();
			if (accounts.map((account) => account.name).join("\n") !== pool.names.join("\n")) pool.setAccounts(accounts);
		},
	};
}
