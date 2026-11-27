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
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parseConfig, Sbx } from "#sbx/index.ts";
import type { Sandbox } from "#sbx/provider.ts";
import { type FakeProvider, fakeProvider } from "#sbx/testing.ts";
import { ExecutionEnvs } from "./harness-setup.ts";
import type { Host } from "./host.ts";
import type { AgentProfiles } from "./profiles.ts";
import { SANDBOX_SECTION } from "./prompt.ts";
import { parseIsolation, runInSandbox, Sandboxes, sandboxName, sandboxOf } from "./sandbox.ts";
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
		assert.match(sandboxName("x", "Session-Dev_1"), /^pd-[0-9a-f]{6}-session-dev-1$/u);
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
		const { box, created } = await sandboxes.ensure({ name: "pd-test-half", repo: work, purpose: "subagent" });
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

describe("sandbox-isolated subagent through a Harness", () => {
	test("its tools run in the sandbox and its commits come back as a branch", async () => {
		const provider = await fakeProvider();
		const work = repository();
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
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(defineExtension({ name: "sandbox-prompt", sections: [SANDBOX_SECTION] }));
		const { orchestration, tasks } = createOrchestration(host);
		registry.install(tasks);
		registry.install(orchestration);
		const envs = new ExecutionEnvs(work, sandboxes);
		let childPrompt = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "add made.txt", isolation: "sandbox:dev" }), { stopReason: "toolUse" }),
			(input) => {
				childPrompt = JSON.stringify(input.messages);
				return fauxAssistantMessage(
					fauxToolCall("bash", { command: "echo made > made.txt && git add made.txt && git commit -qm made && pwd" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
			fauxAssistantMessage("ok"),
		]);
		const harness = await Harness.open(await openNodeSqliteStorage(join(host.sessionDir, "s.sqlite")), { models, registry, env: envs.env }, context);
		host.harness = harness;
		try {
			const root = await harness.root(context, { agent: { cwd: work, model: { provider: "faux", modelId: "faux-1" } } });
			harness.resume();
			const submission = await root.submit({ type: "input", content: "go" }, context);
			const settled = await submission.wait(context);
			assert.equal(settled.status, "done");
			const name = (await provider.list()).length === 0 ? undefined : "unexpected";
			assert.equal(name, undefined, "the sandbox was removed after the pull");
			const branches = git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/");
			const branch = branches.split("\n").find((b) => b.endsWith("/made") || b.includes("/pi-durable/t"));
			assert.ok(branch !== undefined, branches);
			assert.equal(git(work, "show", `${branch}:made.txt`), "made");
			assert.equal(existsSync(join(work, "made.txt")), false, "the child's bash ran in the sandbox");
			assert.match(childPrompt, /run in the sandbox/u);
			const page = await root.entries({}, 100, undefined, context);
			const results = page.items.filter((entry) => entry.kind === "pi.tool-result").map((entry) => JSON.stringify(entry.model));
			assert.ok(results.some((text) => text.includes(`local branch ${branch}`)), results.join("\n"));
		} finally {
			await harness.close(context);
			await envs.cleanup(context);
			await provider.cleanup();
		}
	});
});

describe("sandbox tools through a Harness", () => {
	test("sandbox_run, and sandbox_pull bringing the session sandbox's branch home and removing it", async () => {
		const provider = await fakeProvider();
		const work = repository();
		const sandboxes = setup(provider);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = { sessionId: "1795802865031-tools", cwd: work, sandboxes } as unknown as Host;
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(createSandboxTools(host));
		const envs = new ExecutionEnvs(work, sandboxes);
		const results: string[] = [];
		const record = (input: { messages: { role: string; content: unknown }[] }) => {
			const last = input.messages.at(-1);
			if (last?.role === "toolResult") results.push(JSON.stringify(last.content));
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("sandbox_run", { command: 'echo "ran $KIND"' }), { stopReason: "toolUse" }),
			(input) => {
				record(input);
				return fauxAssistantMessage(
					fauxToolCall("bash", { command: "git checkout -qb feature && echo x > x.txt && git add x.txt && git commit -qm x" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(fauxToolCall("sandbox_pull", { remove: true }), { stopReason: "toolUse" }),
			(input) => {
				record(input);
				return fauxAssistantMessage("ok");
			},
		]);
		const database = join(mkdtempSync(join(tmpdir(), "pi-durable-tools-")), "s.sqlite");
		const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry, env: envs.env }, context);
		try {
			const root = await harness.root(context, { agent: { cwd: work, model: { provider: "faux", modelId: "faux-1" } } });
			const { ref } = await sandboxes.ensure({ name: "pd-tools-session", repo: work, purpose: "session" });
			await harness.commit(async (tx) => {
				(await tx.doc(SessionSandbox)).ref = ref;
			}, context);
			harness.resume();
			const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			assert.equal(settled.status, "done");
			assert.match(results[0] ?? "", /ran job/u);
			assert.match(results[0] ?? "", /removed/u);
			assert.match(results[1] ?? "", /sbx\/pd-tools-session\/feature/u);
			assert.equal(git(work, "show", "sbx/pd-tools-session/feature:x.txt"), "x");
			assert.equal(await provider.get("pd-tools-session"), undefined, "removed after the pull");
			assert.equal((await harness.snapshot(SessionSandbox, context))?.ref, undefined, "the session is local again");
			assert.equal((await provider.list()).length, 0);
		} finally {
			await harness.close(context);
			await envs.cleanup(context);
			await provider.cleanup();
		}
	});
});
