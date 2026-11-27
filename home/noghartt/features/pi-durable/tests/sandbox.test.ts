// Sandboxes, on sbx's fake provider (local directories standing in for VMs, `#sbx/testing.ts`): Durable's own
// ExecutionEnv conformance suite against the sandbox environment, its cancellation and spill, the lifecycle of a
// sandbox-isolated subagent (made once, reused by a rerun, its work pulled back, removed or kept), sandbox_run, a
// session sandbox that survives a reopen, and a whole subagent run through a Harness with a scripted faux model.
// No network: package.nix runs this in the install check.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, type FauxResponseStep, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parseConfig, Sbx } from "#sbx/index.ts";
import type { Sandbox } from "#sbx/provider.ts";
import { type FakeProvider, fakeProvider } from "#sbx/testing.ts";
import { Approvals } from "./approvals.ts";
import { ExecutionEnvs } from "./harness-setup.ts";
import type { Host } from "./host.ts";
import type { AgentProfiles } from "./profiles.ts";
import { SANDBOX_SECTION } from "./prompt.ts";
import {
	artifactPaths,
	markSessionSandboxPending,
	parseIsolation,
	runInSandbox,
	Sandboxes,
	sandboxName,
	sandboxOf,
	sandboxTarget,
	setSessionSandbox,
} from "./sandbox.ts";
import { SandboxExecutionEnv } from "./sandbox-env.ts";
import { createSandboxTools } from "./sandbox-tools.ts";
import { SessionSandbox } from "./state.ts";
import { createOrchestration } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;

Object.assign(process.env, {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const config = parseConfig({
	defaultKind: "dev",
	providers: { fake: {} },
	kinds: { dev: { provider: "fake" }, job: { provider: "fake", env: { KIND: "job" } } },
});

function setup(provider: FakeProvider): Sandboxes {
	return new Sandboxes(() => new Sbx(config, { factories: new Map([["fake", () => provider]]) }));
}

/** A repository with one commit on main, in a fresh directory. */
function repository(): string {
	const dir = join(mkdtempSync(join(tmpdir(), "pi-durable-sbx-")), "repo");
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("sh", ["-c", `mkdir -p "${dir}/sub" && echo one > "${dir}/file.txt"`]);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "first");
	return dir;
}

describe("sandbox ExecutionEnv", () => {
	let provider: FakeProvider;
	let box: Sandbox;
	let home: string;
	let count = 0;
	before(async () => {
		provider = await fakeProvider();
		box = await provider.create({ kind: config.kinds.dev!, name: "env" });
		home = (await box.exec('printf %s "$HOME"')).stdout;
	});
	after(() => provider.cleanup());
	const fresh = async () => {
		const cwd = `${home}/case-${++count}`;
		await box.exec(`mkdir -p ${cwd}`);
		return new SandboxExecutionEnv({ box, home, cwd });
	};

	// Durable's suite for every ExecutionEnv. Watch cases are left out: the sandbox environment does not watch (checked
	// below), and nothing in pi-durable watches its environment.
	const cases = createEnvConformance({
		assertions: {
			ok: (value, message) => assert.ok(value, message),
			strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
			deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
			partialDeepEqual: (actual, expected) => {
				for (const [key, value] of Object.entries(expected as object)) {
					assert.deepStrictEqual((actual as Record<string, unknown>)[key], value, key);
				}
			},
			greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
			rejects: (operation, message) => assert.rejects(operation, (error: Error) => error.message.includes(message)),
		},
		withEnv: async (use) => use(await fresh()),
	});
	for (const item of cases) {
		if (item.name.startsWith("watch")) continue;
		test(`conformance: ${item.name}`, { timeout: item.timeoutMs ?? 30_000 }, item.run);
	}

	test("watching is not supported", async () => {
		const env = await fresh();
		const watched = await env.watch([{ path: "." }], () => {}, context);
		assert.equal(watched.ok ? undefined : watched.error.code, "not_supported");
	});

	test("files are byte-exact, also past the inline size, and paths resolve on the sandbox", async () => {
		const env = await fresh();
		const all = new Uint8Array(256).map((_, i) => i);
		getOrThrow(await env.writeFile("bin/all.bin", all, context));
		assert.deepEqual(getOrThrow(await env.readBinaryFile("bin/all.bin", context)), all);
		assert.equal(getOrThrow(await env.absolutePath("~/x", context)), `${home}/x`);
		assert.equal(getOrThrow(await env.absolutePath("a/../b", context)), `${env.cwd}/b`);
		// 5 MiB: a snapshot read in two chunks, with a line across the boundary.
		const big = Buffer.alloc(5 * 1024 * 1024, "a");
		for (let i = 1000; i < big.length; i += 1000) big[i] = 0x0a;
		getOrThrow(await env.writeFile("big.txt", big, context));
		const reader = getOrThrow(await env.openBinaryReader("big.txt", undefined, context));
		try {
			assert.equal(getOrThrow(await reader.info(context)).size, big.length);
			const edge = 4 * 1024 * 1024 - 3;
			assert.deepEqual(Buffer.from(getOrThrow(await reader.read(edge, 10, context))), big.subarray(edge, edge + 10));
			const scan = getOrThrow(await reader.scanLines({ startLine: 0 }, context));
			assert.equal(scan.newlines, Math.floor((big.length - 1) / 1000));
		} finally {
			await reader.close(context);
		}
		const left = await box.exec("ls ${TMPDIR:-/tmp} | grep -c pi-durable-reader || true");
		assert.equal(left.stdout.trim(), "0", "the reader's snapshot is removed on close");
	});

	test("cancelling a command stops it on the sandbox", async () => {
		const env = await fresh();
		const controller = new AbortController();
		const running = env.exec("sleep 2; touch late", undefined, withAbortSignal(controller.signal, context));
		setTimeout(() => controller.abort(), 200);
		const result = await running;
		assert.equal(result.ok ? undefined : result.error.code, "aborted");
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert.equal(getOrThrow(await env.exists("late", context)), false);
	});

	test("long output spills to a file on the sandbox", async () => {
		const env = await fresh();
		let streamed = "";
		const result = getOrThrow(
			await env.exec(
				"i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); done",
				{ spill: { afterBytes: 100, afterLines: 10 }, onOutput: (text) => (streamed += text) },
				context,
			),
		);
		assert.equal(result.exitCode, 0);
		assert.ok(result.spillPath !== undefined);
		assert.equal(getOrThrow(await env.readTextFile(result.spillPath, context)), streamed);
		assert.equal((await box.exec(`test -f ${result.spillPath}`)).exitCode, 0, "the spill file is on the sandbox");
	});

	test("a callback error stops the command and is reported as such", async () => {
		const env = await fresh();
		const result = await env.exec(
			"echo start; sleep 2; touch late",
			{
				onOutput: () => {
					throw new Error("callback broke");
				},
			},
			context,
		);
		assert.equal(result.ok ? undefined : result.error.code, "callback_error");
	});
});

describe("sandbox lifecycle", () => {
	let provider: FakeProvider;
	let sandboxes: Sandboxes;
	let work: string;
	before(async () => {
		provider = await fakeProvider();
		sandboxes = setup(provider);
		work = repository();
	});
	after(() => provider.cleanup());

	test("names derive from the session and key", () => {
		assert.equal(sandboxName("1795802865031-abc", "t12"), sandboxName("1795802865031-abc", "t12"));
		assert.notEqual(sandboxName("1795802865031-abc", "t12"), sandboxName("1795802865031-abd", "t12"));
		assert.match(sandboxName("x", "Session-Dev_1"), /^pd-[0-9a-f]{10}-session-dev-1$/u);
		assert.deepEqual(parseIsolation("sandbox:agent"), { mode: "sandbox", kind: "agent" });
		assert.deepEqual(parseIsolation("worktree"), { mode: "worktree" });
		assert.throws(() => parseIsolation("sandbox:"), /isolation must be/u);
	});

	test("a subagent sandbox is made once, reused by a rerun, and its work pulled back before removal", async () => {
		const options = { name: "pd-test-t1", repo: work, branch: "pi-durable/t1", purpose: "subagent" as const };
		const first = await sandboxes.ensure(options);
		assert.equal(first.created, true);
		assert.equal(first.ref.base, git(work, "rev-parse", "HEAD"));
		const again = await sandboxes.ensure(options);
		assert.equal(again.created, false, "a rerun finds the sandbox the first call made");
		assert.equal(again.box.id, first.box.id);
		assert.equal((await provider.list()).length, 1);

		// The agent's tools: one commit, and a file it forgot to commit.
		const env = await sandboxes.env(first.ref, join(work, "sub"));
		assert.equal(env.cwd, `${first.ref.workdir}/sub`, "a local directory maps to the same place in the checkout");
		getOrThrow(await env.writeFile("made.txt", "made\n", context));
		assert.equal(getOrThrow(await env.exec("git add made.txt && git commit -qm made", undefined, context)).exitCode, 0);
		getOrThrow(await env.writeFile("../left.txt", "left\n", context));
		assert.equal(existsSync(join(work, "sub", "made.txt")), false, "nothing lands in the local checkout");

		const summary = await sandboxes.bringBack(first.ref, { remove: true });
		assert.equal(summary.failed, false, summary.text);
		assert.equal(summary.ref, "sbx/pd-test-t1/pi-durable/t1");
		assert.equal(git(work, "show", "sbx/pd-test-t1/pi-durable/t1:sub/made.txt"), "made");
		assert.equal(git(work, "show", "sbx/pd-test-t1/pi-durable/t1:left.txt"), "left", "leftovers are committed");
		assert.equal(summary.removed, true);
		assert.equal(await provider.get("pd-test-t1"), undefined);

		const replay = await sandboxes.bringBack(first.ref, { remove: true });
		assert.equal(replay.ref, "sbx/pd-test-t1/pi-durable/t1", "a rerun reports the branch the first run pulled");
		assert.match(replay.text, /already removed/u);
	});

	test("keep and failures leave the sandbox, and say so", async () => {
		const kept = await sandboxes.ensure({ name: "pd-test-t2", repo: work, branch: "pi-durable/t2", purpose: "subagent", keep: true });
		const summary = await sandboxes.bringBack(kept.ref, { remove: true });
		assert.match(summary.text, /No changes were made/u);
		assert.match(summary.text, /is kept/u);
		assert.notEqual(await provider.get("pd-test-t2"), undefined);

		const broken = { ...kept.ref, keep: false, localRoot: mkdtempSync(join(tmpdir(), "not-a-repo-")) };
		const failed = await sandboxes.bringBack(broken, { remove: true });
		assert.equal(failed.failed, true);
		assert.match(failed.text, /kept for inspection/u);
		assert.notEqual(await provider.get("pd-test-t2"), undefined);
		await sandboxes.remove(kept.ref);
	});

	test("a sandbox whose seeding was cut short is made again", async () => {
		const half = await provider.create({
			kind: config.kinds.dev!,
			name: "pd-test-half",
			checkout: { repo: "repo", branch: "main", commit: git(work, "rev-parse", "HEAD") },
		});
		const { box, created } = await sandboxes.ensure({ name: "pd-test-half", repo: work, purpose: "subagent", owned: true });
		assert.equal(created, true);
		assert.notEqual(box.id, half.id);
		await sandboxes.remove({ name: "pd-test-half" });
	});

	test("sandbox_run streams, downloads artifacts and removes its sandbox, reusing one a crash left", async () => {
		const out = mkdtempSync(join(tmpdir(), "artifacts-"));
		let streamed = "";
		// A first run made the sandbox and crashed; the rerun finds it.
		await sandboxes.ensure({ name: "pd-test-run1", kind: "job", repo: work, purpose: "session" });
		const result = await runInSandbox(sandboxes, {
			name: "pd-test-run1",
			kind: "job",
			repo: work,
			command: 'echo "kind=$KIND"; mkdir -p dist; echo built > dist/out.txt; exit 3',
			artifacts: ["dist/out.txt", "missing.txt"],
			out,
			onOutput: (text) => (streamed += text),
		});
		assert.equal(result.exitCode, 3);
		assert.match(streamed, /kind=job/u);
		assert.equal(readFileSync(join(out, "pd-test-run1", "dist", "out.txt"), "utf8"), "built\n");
		assert.ok(result.artifacts.find((a) => a.remote.endsWith("missing.txt"))?.error !== undefined);
		assert.equal(result.removed, true);
		assert.equal((await provider.list()).some((b) => b.name === "pd-test-run1"), false);

		const kept = await runInSandbox(sandboxes, { name: "pd-test-run2", command: "true", out, keep: true });
		assert.equal(kept.removed, false);
		await sandboxes.remove({ name: "pd-test-run2" });
	});
});

describe("session sandbox", () => {
	test("is a session document: a reopened session reattaches by name, and off goes local again", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const database = join(mkdtempSync(join(tmpdir(), "pi-durable-session-")), "session.sqlite");
		const open = async () => {
			const sandboxes = setup(provider);
			const envs = new ExecutionEnvs(work, sandboxes);
			const models = createModels();
			const harness = await Harness.open(
				await openNodeSqliteStorage(database),
				{ models, registry: createRegistry(), env: envs.env },
				context,
			);
			await harness.root(context, { agent: { cwd: work } });
			const env = () => envs.env({ conversationId: ROOT_CONVERSATION_ID, cwd: join(work, "sub"), read: harness }, context);
			return { harness, sandboxes, envs, env };
		};
		try {
			const first = await open();
			assert.equal((await first.env()).id, "node:local");
			const name = sandboxName("session-1", "session-dev");
			const { ref } = await first.sandboxes.ensure({ name, kind: "dev", repo: work, purpose: "session" });
			await first.harness.commit(async (tx) => {
				(await tx.doc(SessionSandbox)).ref = ref;
			}, context);
			const inside = await first.env();
			assert.ok(inside instanceof SandboxExecutionEnv);
			assert.equal(inside.cwd, `${ref.workdir}/sub`);
			assert.match(inside.describe() ?? "", /only commits travelled/u);
			getOrThrow(await inside.writeFile("note.txt", "kept", context));
			await first.harness.close(context);
			await first.envs.cleanup(context);

			const second = await open();
			const again = await second.env();
			assert.ok(again instanceof SandboxExecutionEnv, "the reopened session runs in the same sandbox");
			assert.equal(getOrThrow(await again.readTextFile("note.txt", context)), "kept");
			assert.equal((await sandboxOf(second.harness, ROOT_CONVERSATION_ID, context))?.name, name);
			await second.harness.commit(async (tx) => {
				delete (await tx.doc(SessionSandbox)).ref;
			}, context);
			assert.equal((await second.env()).id, "node:local");
			await second.harness.close(context);
		} finally {
			await provider.cleanup();
		}
	});
});

describe("sandbox safety", () => {
	let provider: FakeProvider;
	let sandboxes: Sandboxes;
	let work: string;
	before(async () => {
		provider = await fakeProvider();
		sandboxes = setup(provider);
		work = repository();
	});
	after(() => provider.cleanup());

	test("a failure after creating a sandbox removes it", async () => {
		const failing = {
			...provider,
			create: async (...args: Parameters<FakeProvider["create"]>) => {
				const box = await provider.create(...args);
				return new Proxy(box, {
					get(target, key) {
						if (key === "exec") {
							return async (command: string, options?: object) => {
								if (command.includes(".pi-durable/seeded")) throw new Error("connection dropped");
								return target.exec(command, options);
							};
						}
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		};
		const local = new Sandboxes(() => new Sbx(config, { factories: new Map([["fake", () => failing]]) }));
		await assert.rejects(local.ensure({ name: "pd-safe-fail", repo: work, purpose: "subagent", owned: true }), /dropped/u);
		assert.equal(await provider.get("pd-safe-fail"), undefined);
	});

	test("a sandbox not ours to replace is reused even without the seeded marker", async () => {
		const bare = await provider.create({ kind: config.kinds.dev!, name: "pd-safe-bare" });
		const { box, created } = await sandboxes.ensure({ name: "pd-safe-bare", purpose: "session", owned: false });
		assert.deepEqual([created, box.id], [false, bare.id]);
		await sandboxes.remove({ name: "pd-safe-bare" });
	});

	test("sandbox isolation needs a git repository", async () => {
		const plain = mkdtempSync(join(tmpdir(), "no-repo-"));
		await assert.rejects(
			sandboxes.ensure({ name: "pd-safe-norepo", repo: plain, requireRepo: true, purpose: "subagent", owned: true }),
			/needs a git repository/u,
		);
		assert.equal(await provider.get("pd-safe-norepo"), undefined);
	});

	test("big leftovers stay behind and are named; uncommitted-change warnings come back", async () => {
		execFileSync("sh", ["-c", `echo dirty >> "${work}/file.txt"`]);
		const made = await sandboxes.ensure({ name: "pd-safe-big", repo: work, branch: "pi-durable/big", purpose: "subagent", owned: true });
		execFileSync("git", ["-C", work, "checkout", "-q", "--", "file.txt"]);
		assert.ok(made.warnings.some((w) => /uncommitted changes/u.test(w)), made.warnings.join("\n"));
		const env = await sandboxes.env(made.ref, work);
		getOrThrow(await env.writeFile("small.txt", "small", context));
		getOrThrow(await env.exec("dd if=/dev/zero of=huge.bin bs=1048576 count=11 2>/dev/null", undefined, context));
		const summary = await sandboxes.bringBack(made.ref, { remove: true });
		assert.match(summary.text, /Not committed .*huge\.bin/u);
		assert.equal(git(work, "show", "sbx/pd-safe-big/pi-durable/big:small.txt"), "small");
		assert.throws(() => git(work, "cat-file", "-e", "sbx/pd-safe-big/pi-durable/big:huge.bin"));
		// A pull after the sandbox is gone reports what an earlier pull left.
		const again = await sandboxes.pull({ name: "pd-safe-big" }, work, []);
		assert.deepEqual([again.gone, again.branches], [true, ["sbx/pd-safe-big/pi-durable/big"]]);
	});

	test("artifacts stay inside the checkout and the output directory", () => {
		assert.deepEqual(artifactPaths("dist/a.txt", "/home/u/repo", "/tmp/out/box"), {
			remote: "/home/u/repo/dist/a.txt",
			local: "/tmp/out/box/dist/a.txt",
		});
		for (const bad of ["../x", "/etc/passwd", "a/../../b", "~/x", ""]) {
			assert.throws(() => artifactPaths(bad, "/home/u/repo", "/tmp/out/box"), /relative path/u, bad);
		}
	});

	test("a pending or failed session sandbox blocks tools instead of running them here", async () => {
		const broken = parseConfig({
			defaultKind: "dev",
			providers: { fake: {} },
			kinds: { dev: { provider: "fake" }, broken: { provider: "fake", setup: "exit 1" } },
		});
		const local = new Sandboxes(() => new Sbx(broken, { factories: new Map([["fake", () => provider]]) }));
		const database = join(mkdtempSync(join(tmpdir(), "pi-durable-blocked-")), "s.sqlite");
		const harness = await Harness.open(await openNodeSqliteStorage(database), { models: createModels(), registry: createRegistry() }, context);
		const envs = new ExecutionEnvs(work, local);
		const env = () => envs.env({ conversationId: ROOT_CONVERSATION_ID, cwd: work, read: harness }, context);
		try {
			await harness.root(context, { agent: { cwd: work } });
			await markSessionSandboxPending(harness, "pd-x-session-dev", "dev", context);
			await assert.rejects(env(), /not ready/u);
			assert.equal((await sandboxTarget(harness, ROOT_CONVERSATION_ID, context)).kind, "blocked");
			const options = { sessionId: "blocked", cwd: work, notice: () => {} };
			await assert.rejects(setSessionSandbox(harness, local, "broken", options, context), /setup failed/u);
			await assert.rejects(env(), /sandbox failed/u);
			assert.match(await setSessionSandbox(harness, local, "", options, context), /failed/u);
			await setSessionSandbox(harness, local, "off", options, context);
			assert.equal((await env()).id, "node:local");
			assert.match(await setSessionSandbox(harness, local, "dev", options, context), /now run in sandbox/u);
			assert.ok((await env()) instanceof SandboxExecutionEnv);
			await setSessionSandbox(harness, local, "off", options, context);
		} finally {
			await harness.close(context);
			await envs.cleanup(context);
		}
	});
});

type Step = FauxResponseStep;

/** A response that never comes; `reached` resolves once the request is out. Aborting the run rejects it. */
function never(): { step: Step; reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => (reach = resolve));
	const step: Step = (_input, options) =>
		new Promise((_, reject) => {
			reach();
			options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
		});
	return { step, reached };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * A Harness with the coding tools, the orchestration and sandbox tools, and a faux model scripted per conversation:
 * requests whose context names a subagent take `child` steps, the rest `main` steps.
 */
async function harnessWith(
	provider: FakeProvider,
	work: string,
	script: { main: Step[]; child: Step[] },
	approve = false,
) {
	const sandboxes = setup(provider);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const profile = { name: "general", description: "", isolation: "none", runner: "pi", instructions: "", source: "built-in" };
	const host: Host = {
		sessionId: "1795802865031-test",
		sessionDir: mkdtempSync(join(tmpdir(), "pi-durable-host-")),
		cwd: work,
		profiles: { get: () => profile, resolveModel: () => ({}), describe: () => "", all: [profile] } as unknown as AgentProfiles,
		sandboxes,
		harness: undefined,
	};
	const approvals = new Approvals();
	approvals.handle(async () => approve);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(defineExtension({ name: "sandbox-prompt", sections: [SANDBOX_SECTION] }));
	const { orchestration, tasks } = createOrchestration(host);
	registry.install(tasks);
	registry.install(orchestration);
	registry.install(createSandboxTools(host, approvals));
	const envs = new ExecutionEnvs(work, sandboxes);
	const prompts: { main: string[]; child: string[] } = { main: [], child: [] };
	const route: Step = (input, options, state, model) => {
		const text = JSON.stringify(input.messages);
		const who = text.includes("You are the subagent") ? "child" : "main";
		prompts[who].push(text);
		const step = script[who].shift() ?? fauxAssistantMessage("(nothing more)");
		return typeof step === "function" ? step(input, options, state, model) : step;
	};
	faux.setResponses(Array.from({ length: 40 }, () => route));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(host.sessionDir, "s.sqlite")),
		{ models, registry, env: envs.env },
		context,
	);
	host.harness = harness;
	const root = await harness.root(context, { agent: { cwd: work, model: { provider: "faux", modelId: "faux-1" } } });
	const results = async () =>
		(await root.entries({}, 200, undefined, context)).items
			.filter((entry) => entry.kind === "pi.tool-result")
			.map((entry) => JSON.stringify(entry.model))
			.reverse();
	const close = async () => {
		await harness.close(context);
		await envs.cleanup(context);
	};
	return { harness, root, sandboxes, host, prompts, results, close };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const commitInBash = (file: string) =>
	call("bash", { command: `echo ${file} > ${file}.txt && git add ${file}.txt && git commit -qm ${file}` });

describe("sandboxes through a Harness", () => {
	test("a sandbox:dev subagent: its tools run in the VM and its commits come back as a branch", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const h = await harnessWith(provider, work, {
			main: [call("subagent", { task: "add made.txt", isolation: "sandbox:dev" }), fauxAssistantMessage("ok")],
			child: [commitInBash("made"), fauxAssistantMessage("done")],
		});
		try {
			h.harness.resume();
			const settled = await (await h.root.submit({ type: "input", content: "go" }, context)).wait(context);
			assert.equal(settled.status, "done");
			assert.equal((await provider.list()).length, 0, "the sandbox was removed after the pull");
			const branch = git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/");
			assert.match(branch, /\/pi-durable\/t\d+$/u);
			assert.equal(git(work, "show", `${branch}:made.txt`), "made");
			assert.equal(existsSync(join(work, "made.txt")), false, "the child's bash ran in the sandbox");
			assert.match(h.prompts.child[0] ?? "", /run in the sandbox/u);
			assert.ok((await h.results()).some((text) => text.includes(`local branch ${branch}`)));
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});

	test("a subagent stopped before answering still brings its work back and loses its sandbox", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const stall = never();
		const h = await harnessWith(provider, work, {
			main: [call("subagent", { task: "work", isolation: "sandbox" }), fauxAssistantMessage("ok")],
			child: [commitInBash("partial"), stall.step],
		});
		try {
			h.harness.resume();
			const submission = await h.root.submit({ type: "input", content: "go" }, context);
			await stall.reached;
			const child = (await h.harness.commit((tx) => tx.scanConversations({}, 10), context)).items.find((c) => c.owner !== undefined)!;
			await (await h.harness.conversation(child.id, context))!.abort(context);
			assert.equal((await submission.wait(context)).status, "done");
			const results = await h.results();
			assert.ok(results.some((text) => /ended without an answer/u.test(text) && /local branch sbx\//u.test(text)), results.join("\n"));
			assert.equal((await provider.list()).length, 0);
			assert.match(git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/"), /pi-durable\/t/u);
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});

	test("aborting a parallel fan-out cancels its sandbox children, which still bring their work back", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const stall = never();
		const h = await harnessWith(provider, work, {
			main: [call("parallel", { tasks: [{ task: "work", isolation: "sandbox" }] })],
			child: [commitInBash("cut"), stall.step],
		});
		try {
			h.harness.resume();
			const submission = await h.root.submit({ type: "input", content: "go" }, context);
			await stall.reached;
			assert.equal((await provider.list()).length, 1);
			await h.root.abort(context);
			await submission.wait(context);
			await waitFor(async () => (await provider.list()).length === 0);
			assert.match(git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/"), /pi-durable\/t/u);
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});

	test("a stopped background subagent's sandbox goes, after its work comes back", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const stall = never();
		const h = await harnessWith(provider, work, {
			main: [call("subagent", { task: "work", isolation: "sandbox", background: true }), fauxAssistantMessage("started")],
			child: [commitInBash("bg"), stall.step],
		});
		try {
			h.harness.resume();
			await (await h.root.submit({ type: "input", content: "go" }, context)).wait(context);
			await stall.reached;
			const child = (await h.harness.commit((tx) => tx.scanConversations({}, 10), context)).items.find((c) => c.id !== ROOT_CONVERSATION_ID)!;
			await (await h.harness.conversation(child.id, context))!.abort(context);
			await waitFor(async () => (await provider.list()).length === 0);
			assert.match(git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/"), /pi-durable\/bg/u);
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});

	test("in a sandboxed session, an isolated subagent works in a worktree inside the session's sandbox", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const h = await harnessWith(provider, work, {
			main: [call("subagent", { task: "add wt.txt", isolation: "worktree" }), fauxAssistantMessage("ok")],
			child: [commitInBash("wt"), fauxAssistantMessage("done")],
		});
		try {
			const name = sandboxName(h.host.sessionId, "session-dev");
			const { ref, box } = await h.sandboxes.ensure({ name, repo: work, purpose: "session", owned: true });
			await h.harness.commit(async (tx) => {
				(await tx.doc(SessionSandbox)).ref = ref;
			}, context);
			h.harness.resume();
			assert.equal((await (await h.root.submit({ type: "input", content: "go" }, context)).wait(context)).status, "done");
			assert.equal((await provider.list()).length, 1, "no second VM");
			const branches = (await box.exec(`git -C ${ref.workdir} for-each-ref --format='%(refname:short)' refs/heads/pi-durable/`)).stdout.trim();
			assert.match(branches, /^pi-durable\/1795802865031-t\d+$/u);
			assert.equal((await box.exec(`git -C ${ref.workdir} show ${branches}:wt.txt`)).stdout.trim(), "wt");
			assert.equal((await box.exec(`ls ${ref.home}/.pi-durable/worktrees | wc -l`)).stdout.trim(), "0", "its worktree was removed");
			assert.equal(git(work, "for-each-ref", "refs/heads/"), git(work, "for-each-ref", "refs/heads/main"), "nothing new locally");
			assert.match(h.prompts.child[0] ?? "", /git worktree at .*inside the sandbox VM/u);
			assert.ok((await h.results()).some((text) => text.includes(`on branch ${branches} in sandbox`)));
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});

	test("sandbox_run, sandbox_pull of the session's sandbox, and no removal of another without approval", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const h = await harnessWith(provider, work, {
			main: [
				call("sandbox_run", { command: 'echo "ran $KIND"' }),
				call("bash", { command: "git checkout -qb feature && echo x > x.txt && git add x.txt && git commit -qm x" }),
				call("sandbox_pull", { sandbox: "someone-elses", remove: true }),
				call("sandbox_pull", { remove: true }),
				fauxAssistantMessage("ok"),
			],
			child: [],
		});
		try {
			const name = sandboxName(h.host.sessionId, "session-dev");
			const { ref } = await h.sandboxes.ensure({ name, repo: work, purpose: "session", owned: true });
			await h.sandboxes.ensure({ name: "someone-elses", repo: work, purpose: "session" });
			await h.harness.commit(async (tx) => {
				(await tx.doc(SessionSandbox)).ref = ref;
			}, context);
			h.harness.resume();
			assert.equal((await (await h.root.submit({ type: "input", content: "go" }, context)).wait(context)).status, "done");
			const [run, , foreign, own] = await h.results();
			assert.match(run ?? "", /ran job/u);
			assert.match(run ?? "", /removed/u);
			assert.match(foreign ?? "", /Not removed: someone-elses was not made by this session/u);
			assert.notEqual(await provider.get("someone-elses"), undefined);
			assert.match(own ?? "", new RegExp(`sbx/${name}/feature`, "u"));
			assert.equal(git(work, "show", `sbx/${name}/feature:x.txt`), "x");
			assert.equal(await provider.get(name), undefined, "removed after the pull");
			assert.equal((await h.harness.snapshot(SessionSandbox, context))?.ref, undefined, "the session is local again");
		} finally {
			await h.close();
			await provider.cleanup();
		}
	});
});
