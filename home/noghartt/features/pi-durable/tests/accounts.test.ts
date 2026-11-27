// Accounts: the overview /accounts shows, the shared add/remove helpers, the /accounts parser and completions, and an
// AccountPool that gains and loses accounts while open. No network and no real agent dir: package.nix runs this in
// the install check with PI_CODING_AGENT_DIR on a temp dir.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { initTheme } from "#pi/index.js";
import {
	AccountPool,
	AccountState,
	accountState,
	accountsOverview,
	authPathOf,
	blockText,
	extraAccountNames,
	type PoolAccount,
	recordLogin,
	removeAccount,
} from "./accounts.ts";
import { accountsCompletions, accountsLines, loadAccounts, parseAccountsCommand } from "./accounts-view.ts";
import { authFileEmails } from "./limits.ts";

initTheme();

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-durable-accounts-"));
}

function writeAuth(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: 0 };

test("the overview lists Claude first with its extra accounts, then every provider of the main auth.json", () => {
	const dir = agentDir();
	writeAuth(authPathOf("work", dir), { anthropic: OAUTH });
	writeAuth(authPathOf("spare", dir), { "openai-codex": OAUTH });
	recordLogin("work", dir);
	recordLogin("spare", dir);
	const now = Date.now();
	accountState(dir).block("work", { blockedUntil: now + 60_000, reason: "limit" });

	const groups = accountsOverview({
		agentDir: dir,
		credentials: [
			{ providerId: "openai-codex", type: "oauth" },
			{ providerId: "anthropic", type: "oauth" },
			{ providerId: "google-antigravity", type: "oauth" },
		],
		providerName: (id) => (id === "anthropic" ? "Anthropic" : undefined),
		active: "work",
		now,
	});
	assert.deepEqual(
		groups.map((group) => [group.id, group.name, group.accounts.map((row) => row.name)]),
		[
			["anthropic", "Anthropic", ["main", "work", "spare"]],
			["google-antigravity", "google-antigravity", ["main"]],
			["openai-codex", "openai-codex", ["main"]],
		],
	);
	const [main, work, spare] = groups[0]!.accounts;
	assert.equal(main!.signedIn, true);
	assert.equal(work!.active, true);
	assert.equal(work!.pooled, true);
	assert.deepEqual(work!.block, { blockedUntil: now + 60_000, reason: "limit" });
	assert.equal(spare!.signedIn, false);
	assert.equal(groups[2]!.accounts[0]!.pooled, false);
	assert.equal(blockText(work!.block, now)?.startsWith("limited until"), true);
	assert.equal(blockText(work!.block, now + 120_000), undefined);
});

test("an account dir whose auth.json holds no credential is not an account", () => {
	const dir = agentDir();
	writeAuth(authPathOf("work", dir), { anthropic: OAUTH });
	// A first sign-in under way, or the empty file Pi recreates for a runtime still open on a removed account.
	writeAuth(authPathOf("pending", dir), {});
	assert.deepEqual(extraAccountNames(dir), ["work"]);
});

test("Claude is listed signed out when main has no login and no extra accounts exist", () => {
	const groups = accountsOverview({ agentDir: agentDir(), credentials: [] });
	assert.equal(groups.length, 1);
	assert.deepEqual(
		groups[0]!.accounts.map((row) => [row.name, row.signedIn, row.pooled, row.active]),
		[["main", false, false, false]],
	);
});

test("recordLogin appends to the order and clears the block; removeAccount undoes it and refuses main", () => {
	const dir = agentDir();
	for (const name of ["b", "a"]) {
		writeAuth(authPathOf(name, dir), { anthropic: OAUTH });
		recordLogin(name, dir);
	}
	accountState(dir).block("a", { blockedUntil: Date.now() + 60_000, reason: "auth" });
	recordLogin("a", dir);
	assert.deepEqual(extraAccountNames(dir), ["b", "a"]);
	assert.equal(accountState(dir).read().a, undefined);
	removeAccount("b", dir);
	assert.deepEqual(extraAccountNames(dir), ["a"]);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "accounts", "order.json"), "utf8")), ["a"]);
	assert.throws(() => removeAccount("main", dir));
});

test("/accounts arguments parse into commands", () => {
	assert.deepEqual(parseAccountsCommand(""), { kind: "list" });
	assert.deepEqual(parseAccountsCommand("add work"), { kind: "add", name: "work" });
	assert.deepEqual(parseAccountsCommand("login  openai-codex"), { kind: "login", provider: "openai-codex" });
	assert.deepEqual(parseAccountsCommand("remove work"), { kind: "remove", name: "work" });
	for (const bad of ["remove main", "add main", "remove", "login", "add a b", "frobnicate"]) {
		assert.equal(parseAccountsCommand(bad).kind, "usage", bad);
	}
});

test("/accounts completes subcommands, providers and account names", () => {
	const sources = {
		accounts: () => ["work", "spare"],
		providers: () => [
			{ id: "anthropic", name: "Anthropic" },
			{ id: "openai-codex", name: "ChatGPT" },
		],
	};
	assert.deepEqual(
		accountsCompletions("", sources).map((item) => item.value),
		["add ", "login ", "remove "],
	);
	assert.deepEqual(
		accountsCompletions("re", sources).map((item) => item.value),
		["remove "],
	);
	assert.deepEqual(
		accountsCompletions("login op", sources).map((item) => item.value),
		["login openai-codex"],
	);
	assert.deepEqual(
		accountsCompletions("remove ", sources).map((item) => item.value),
		["remove work", "remove spare"],
	);
	assert.deepEqual(accountsCompletions("nope x", sources), []);
});

test("loadAccounts adds each signed-in login's email; the panel shows emails, the active account and blocks", async () => {
	const dir = agentDir();
	writeAuth(authPathOf("work", dir), { anthropic: OAUTH });
	recordLogin("work", dir);
	accountState(dir).block("main", { blockedUntil: Date.now() + 60_000, reason: "limit" });
	const asked: string[] = [];
	const groups = await loadAccounts(
		{
			agentDir: dir,
			credentials: [
				{ providerId: "anthropic", type: "oauth" },
				{ providerId: "openai-codex", type: "oauth" },
			],
			active: "work",
		},
		async (path): Promise<Record<string, string>> => {
			asked.push(path);
			return path === authPathOf("work", dir)
				? { anthropic: "work@example.com" }
				: { anthropic: "main@example.com", "openai-codex": "codex@example.com" };
		},
	);
	// One read per auth file, however many providers it holds.
	assert.equal(asked.length, 2);
	assert.deepEqual(
		groups.flatMap((group) => group.accounts.map((row) => `${row.provider}/${row.name}=${row.email}`)),
		["anthropic/main=main@example.com", "anthropic/work=work@example.com", "openai-codex/main=codex@example.com"],
	);
	const text = accountsLines(groups).join("\n");
	assert.match(text, /main@example\.com/u);
	assert.match(text, /limited until/u);
	assert.match(text, /▸.*work/u);
});

test("authFileEmails reads ChatGPT's email from its token and skips expired Claude tokens without a request", async () => {
	const dir = agentDir();
	const claims = { "https://api.openai.com/profile": { email: "codex@example.com" } };
	const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
	const path = join(dir, "auth.json");
	writeAuth(path, {
		"openai-codex": { type: "oauth", access: jwt, refresh: "r", expires: Date.now() + 60_000 },
		anthropic: { type: "oauth", access: "sk-ant-oat-expired", refresh: "r", expires: 1 },
		"google-antigravity": { type: "oauth", access: "g", refresh: "r", expires: 0, email: "g@example.com" },
	});
	assert.deepEqual(await authFileEmails(path), {
		"openai-codex": "codex@example.com",
		"google-antigravity": "g@example.com",
	});
	assert.deepEqual(await authFileEmails(join(dir, "missing.json")), {});
});

// --- AccountPool, with fake Models that answer or fail with a usage limit before any content.

const MODEL = { provider: "anthropic", id: "claude", api: "anthropic-messages" } as unknown as Model<"anthropic-messages">;

function message(text: string, error?: string): AssistantMessage {
	return {
		role: "assistant",
		content: error === undefined ? [{ type: "text", text }] : [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: error === undefined ? "stop" : "error",
		...(error === undefined ? {} : { errorMessage: error }),
		timestamp: 0,
	};
}

function fake(name: string, limited: () => boolean, calls: string[]): Models {
	const stream = (): AssistantMessageEventStream => {
		calls.push(name);
		const out = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (limited()) {
				const failed = message("", "429 rate_limit_error: usage limit reached");
				out.push({ type: "error", reason: "error", error: failed });
				out.end(failed);
			} else {
				const done = message(`from ${name}`);
				out.push({ type: "done", reason: "stop", message: done });
				out.end(done);
			}
		});
		return out;
	};
	return { streamSimple: stream, checkAuth: async () => ({ type: "oauth" }) } as unknown as Models;
}

const text = (answer: AssistantMessage) => answer.content.map((block) => (block.type === "text" ? block.text : "")).join("");

test("an AccountPool with one account passes through, and gains and loses accounts while open", async () => {
	const dir = agentDir();
	let now = 1_000_000;
	const calls: string[] = [];
	let mainLimited = true;
	const primary = fake("main", () => mainLimited, calls);
	let opens = 0;
	const work: PoolAccount = {
		name: "work",
		open: async () => {
			opens++;
			return fake("work", () => false, calls);
		},
	};
	const main: PoolAccount = { name: "main", open: async () => primary };
	const state = new AccountState(join(dir, "accounts", "state.json"), () => now);
	const pool = new AccountPool({ primary, accounts: [main], state, now: () => now });
	const notices: string[] = [];
	pool.onNotice = (_level, notice) => notices.push(notice);

	// One account: the limit error passes straight through and nothing is blocked.
	assert.equal(pool.size, 1);
	const alone = await pool.completeSimple(MODEL, { messages: [] });
	assert.equal(alone.stopReason, "error");
	assert.deepEqual(state.read(), {});

	// An account added while open takes the request that main is limited for.
	pool.setAccounts([main, work]);
	assert.equal(pool.size, 2);
	const answer = await pool.completeSimple(MODEL, { messages: [] });
	assert.equal(text(answer), "from work");
	// The answer resolves on its done event; the pool records the account it used just after.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pool.active, "work");
	assert.equal(state.read().main?.reason, "limit");
	assert.match(notices.join("\n"), /continuing on "work"/u);

	// Kept accounts keep their opened Models; a fresh one is reopened.
	pool.setAccounts([main, work]);
	await pool.completeSimple(MODEL, { messages: [] });
	assert.equal(opens, 1);
	pool.setAccounts([main, work], ["work"]);
	await pool.completeSimple(MODEL, { messages: [] });
	assert.equal(opens, 2);

	// Removing the active account moves back to main and its requests pass through again.
	mainLimited = false;
	now += 10 * 3_600_000;
	pool.setAccounts([main]);
	assert.equal(pool.active, "main");
	calls.length = 0;
	assert.equal(text(await pool.completeSimple(MODEL, { messages: [] })), "from main");
	assert.deepEqual(calls, ["main"]);
});
