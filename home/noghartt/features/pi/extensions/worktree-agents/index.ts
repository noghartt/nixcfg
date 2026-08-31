import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_BYTES = 6 * 1024;
const MAX_OUTPUT_LINES = 200;

interface TaskResult {
	name: string;
	task: string;
	branch?: string;
	worktree?: string;
	cwd: string;
	exitCode: number;
	output: string;
	fullOutputPath?: string;
	error?: string;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "task";
}

function isWithin(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function finalAssistantText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

async function runPi(cwd: string, task: string, isolated: boolean, signal?: AbortSignal): Promise<{
	exitCode: number;
	output: string;
	error?: string;
}> {
	const isolationInstruction = isolated
		? "You are working in a dedicated Git worktree. Do not create another worktree or commit."
		: "The user explicitly opted out of worktree isolation. Work only in the current checkout and do not commit.";
	const prompt = [
		"You are a delegated implementation agent.",
		isolationInstruction,
		"Read the repository instructions, make only task-relevant changes, and run focused validation.",
		"Finish with a concise summary, changed files, validation, and any blockers.",
		"",
		`Task: ${task}`,
	].join("\n");
	const args = [
		"--mode",
		"json",
		"--no-session",
		"--approve",
		"--exclude-tools",
		"worktree_agents",
		prompt,
	];
	const invocation = getPiInvocation(args);
	const messages: Message[] = [];
	let stderr = "";
	let buffer = "";
	let aborted = false;

	const exitCode = await new Promise<number>((done) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				if (event.type === "message_end" && event.message) messages.push(event.message);
			} catch {
				// Ignore non-protocol output; stderr is retained for diagnostics.
			}
		};

		child.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (data) => {
			stderr = `${stderr}${data.toString()}`.slice(-50 * 1024);
		});
		child.on("error", (error) => {
			stderr = error.message;
			done(1);
		});
		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			done(code ?? 1);
		});

		const abort = () => {
			aborted = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});

	return {
		exitCode,
		output: finalAssistantText(messages),
		error: aborted ? "Agent was aborted" : exitCode === 0 ? undefined : stderr.trim() || "Agent failed without output",
	};
}

async function truncateOutput(output: string, name: string): Promise<{ output: string; fullOutputPath?: string }> {
	const truncated = truncateHead(output, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});
	if (!truncated.truncated) return { output: truncated.content };

	const fullOutputPath = join(tmpdir(), `pi-worktree-agent-${slugify(name)}-${randomUUID()}.txt`);
	await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
	return {
		output: `${truncated.content}\n\n[Output truncated from ${formatSize(truncated.totalBytes)}; full output: ${fullOutputPath}]`,
		fullOutputPath,
	};
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

const TaskSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Short task label used for the worktree and branch names" })),
	task: Type.String({ description: "Self-contained task for the delegated agent" }),
	cwd: Type.Optional(Type.String({ description: "Directory relative to the repository root, useful for monorepos" })),
});

const Params = Type.Object({
	tasks: Type.Array(TaskSchema, {
		minItems: 1,
		maxItems: MAX_TASKS,
		description: "Independent tasks; worktree mode runs up to four agents concurrently",
	}),
	isolation: Type.Optional(
		StringEnum(["worktree", "current"] as const, {
			description: 'Execution isolation. Defaults to "worktree"; use "current" only to opt out.',
			default: "worktree",
		}),
	),
});

export default function worktreeAgents(pi: ExtensionAPI) {
	pi.registerTool({
		name: "worktree_agents",
		label: "Worktree Agents",
		description:
			'Delegate implementation tasks to Pi agents. Each task uses a separate Git worktree by default, allowing safe parallel work in monorepos. Set isolation to "current" to explicitly opt out; current mode accepts one task.',
		promptSnippet: "Delegate implementation tasks to parallel agents isolated in Git worktrees by default",
		promptGuidelines: [
			'Use worktree_agents for independent delegated implementation tasks so each agent works in its own Git worktree; set isolation to "current" only when the user opts out or a worktree is clearly unnecessary.',
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const isolation = params.isolation ?? "worktree";
			if (isolation === "current" && params.tasks.length !== 1) {
				throw new Error('isolation "current" accepts exactly one task to prevent concurrent edits in one checkout');
			}

			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal });
			if (rootResult.code !== 0) throw new Error("worktree_agents requires a Git repository");
			const repositoryRoot = rootResult.stdout.trim();
			const callerRelativeCwd = relative(repositoryRoot, ctx.cwd);
			if (!isWithin(repositoryRoot, ctx.cwd)) throw new Error("Current directory is outside the repository root");

			const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: repositoryRoot, signal });
			const dirtyWarning = statusResult.stdout.trim()
				? "The caller checkout is dirty; new worktrees start from HEAD and do not include its uncommitted changes."
				: undefined;
			const runId = randomUUID().slice(0, 8);
			const worktreeBase = join(dirname(repositoryRoot), `.${basename(repositoryRoot)}-pi-worktrees`, runId);

			type PreparedTask = {
				name: string;
				task: string;
				cwd: string;
				branch?: string;
				worktree?: string;
				prepareError?: string;
			};
			const prepared: PreparedTask[] = [];

			if (isolation === "worktree") await mkdir(worktreeBase, { recursive: true });
			for (const [index, task] of params.tasks.entries()) {
				const name = task.name?.trim() || `task-${index + 1}`;
				const relativeCwd = task.cwd ?? callerRelativeCwd;
				const sourceCwd = resolve(repositoryRoot, relativeCwd);
				if (!isWithin(repositoryRoot, sourceCwd)) {
					prepared.push({ name, task: task.task, cwd: sourceCwd, prepareError: `cwd escapes repository: ${relativeCwd}` });
					continue;
				}

				if (isolation === "current") {
					prepared.push({ name, task: task.task, cwd: sourceCwd });
					continue;
				}

				const suffix = `${index + 1}-${slugify(name)}`;
				const branch = `pi-worktree/${runId}-${suffix}`;
				const worktree = join(worktreeBase, suffix);
				const addResult = await pi.exec(
					"git",
					["worktree", "add", "-b", branch, worktree, "HEAD"],
					{ cwd: repositoryRoot, signal },
				);
				const taskCwd = resolve(worktree, relativeCwd);
				prepared.push({
					name,
					task: task.task,
					branch,
					worktree,
					cwd: taskCwd,
					prepareError: addResult.code === 0 ? undefined : addResult.stderr.trim() || "git worktree add failed",
				});
			}

			const completed = { count: 0 };
			const results = await mapConcurrent(prepared, isolation === "worktree" ? MAX_CONCURRENCY : 1, async (task) => {
				if (task.prepareError) {
					completed.count++;
					return { ...task, exitCode: 1, output: "", error: task.prepareError } satisfies TaskResult;
				}
				if (!existsSync(task.cwd)) {
					completed.count++;
					return { ...task, exitCode: 1, output: "", error: `cwd does not exist: ${task.cwd}` } satisfies TaskResult;
				}

				const child = await runPi(task.cwd, task.task, isolation === "worktree", signal);
				const output = await truncateOutput(child.output || child.error || "(no output)", task.name);
				completed.count++;
				onUpdate?.({
					content: [{ type: "text", text: `${completed.count}/${prepared.length} worktree agents finished` }],
					details: {},
				});
				return {
					...task,
					exitCode: child.exitCode,
					output: output.output,
					fullOutputPath: output.fullOutputPath,
					error: child.error,
				} satisfies TaskResult;
			});

			const sections = results.map((result) => {
				const status = result.exitCode === 0 ? "completed" : "failed";
				const location = result.worktree
					? `\nWorktree: ${result.worktree}\nBranch: ${result.branch}`
					: `\nCheckout: ${result.cwd}`;
				return `### ${result.name} — ${status}${location}\n\n${result.output || result.error || "(no output)"}`;
			});
			const succeeded = results.filter((result) => result.exitCode === 0).length;
			const header = [
				`${succeeded}/${results.length} agents succeeded (${isolation} isolation).`,
				dirtyWarning,
				isolation === "worktree"
					? "Worktrees and branches are intentionally retained for review and integration."
					: undefined,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");

			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details: { isolation, repositoryRoot, dirtyWarning, results },
			};
		},
	});
}
