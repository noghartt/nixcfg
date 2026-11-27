// The Pi `antigravity` extension (home/noghartt/features/pi-next/extensions/antigravity) as a Durable extension:
// same tool name, parameters, agy invocation and result text. Keep the two in step; see docs/extensions.md.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { Approvals } from "./approvals.ts";

export const DEFAULT_MODEL = "gemini-4-neon-high";

type Step = { tool: string; target?: string; state: string; error?: string };

export type Details = {
	model: string;
	cwd: string;
	allowWrites: boolean;
	conversationId?: string;
	status?: string;
	steps: Step[];
	denied: string[];
	notes: string[];
	durationSeconds?: number;
	tokens?: { input: number; output: number; thinking: number; cacheRead: number };
};

/** Pi's `promptSnippet` and `promptGuidelines` for the tool, rendered by ./prompt.ts. */
export const antigravitySystemPromptContribution = {
	snippet: "Delegate a self-contained task to an Antigravity (agy) sub-agent on Gemini/Claude models",
	guidelines: [
		"Use antigravity only when the user asks for Antigravity/agy/Gemini, or wants a second opinion from another model; do not use antigravity for routine work you can do directly.",
		"Set allowWrites on antigravity only when the user explicitly wants agy to modify files.",
	],
};

function agyBinary(): string {
	// A stand-in agy for scripted tests of the tools and swarm members.
	if (process.env.PI_DURABLE_AGY) return process.env.PI_DURABLE_AGY;
	const local = join(homedir(), ".local/bin/agy");
	return existsSync(local) ? local : "agy";
}

// agy tool parameters use PascalCase keys that vary per tool; show the most telling one.
function stepTarget(params: Record<string, unknown> | undefined): string | undefined {
	if (!params) return undefined;
	for (const key of ["CommandLine", "Path", "AbsolutePath", "DirectoryPath", "SearchPath", "Query", "Url"]) {
		const value = params[key];
		if (typeof value === "string" && value) return value.length > 120 ? `${value.slice(0, 117)}...` : value;
	}
	return undefined;
}

function toUsage(tokens: Details["tokens"]): Usage | undefined {
	if (!tokens) return undefined;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return {
		input: tokens.input,
		output: tokens.output + tokens.thinking,
		cacheRead: tokens.cacheRead,
		cacheWrite: 0,
		reasoning: tokens.thinking,
		totalTokens: tokens.input + tokens.output + tokens.thinking + tokens.cacheRead,
		// Billed against the Antigravity subscription, not a Pi provider.
		cost: zero,
	};
}

function stepLine(s: Step): string {
	const mark = s.state === "DONE" ? "✓" : s.state === "ERROR" ? "✗" : "…";
	const err = s.error ? ` — ${s.error.split("\n")[0]}` : "";
	return `${mark} ${s.tool}${s.target ? ` ${s.target}` : ""}${err}`;
}

const stepLog = (steps: Step[]): string => steps.map(stepLine).join("\n");

export type AgyRun = {
	readonly task: string;
	readonly model: string;
	readonly cwd: string;
	readonly conversationId?: string;
	readonly allowWrites: boolean;
};

/** Where a run's progress goes: a tool call's output and details, or nowhere for a swarm member's run. */
export type AgySink = Pick<ToolExecutionApi, "output" | "details">;

export type AgyOutcome = {
	/** agy's final answer, empty when it gave none. */
	readonly answer: string;
	readonly details: Details;
	readonly failed: boolean;
	readonly exitCode: number | null;
};

/** One agy run, cancelled by `context.abortSignal`: streams its steps into `sink` and returns what it answered. */
export async function execAgy(run: AgyRun, sink: AgySink, context: Context): Promise<AgyOutcome> {
	const { model, cwd, allowWrites } = run;
	const args = ["--output-format", "stream-json", "--model", model];
	if (run.conversationId) args.push("--conversation", run.conversationId);
	if (allowWrites) args.push("--dangerously-skip-permissions");
	// -p must come last: agy treats the token after it as the prompt.
	args.push("-p", run.task);

	const details: Details = { model, cwd, allowWrites, steps: [], denied: [], notes: [] };
	let response = "";
	let streamed = "";
	const stepsByIndex = new Map<number, Step>();
	// Durable keeps details and output in SQLite; commits run one after another, never blocking the stream.
	let saving = Promise.resolve();
	const save = () => {
		const snapshot = JSON.parse(JSON.stringify(details)) as Details;
		saving = saving.then(() => sink.details(snapshot, context)).catch(() => {});
	};

	const handleLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let event: any;
		try {
			event = JSON.parse(trimmed);
		} catch {
			details.notes.push(trimmed);
			return;
		}
		if (event.event === "init") {
			details.conversationId = event.conversation_id;
			save();
		} else if (event.event === "step_update") {
			const u = event.step_update ?? {};
			if (u.step_type === "agent_response" && typeof u.text_delta === "string") streamed += u.text_delta;
			if (u.step_type !== "tool") return;
			let step = stepsByIndex.get(u.step_index);
			if (!step) {
				step = { tool: u.tool_name ?? "tool", state: u.state };
				stepsByIndex.set(u.step_index, step);
				details.steps.push(step);
			}
			const finished = step.state !== u.state && (u.state === "DONE" || u.state === "ERROR");
			step.state = u.state;
			step.target ??= stepTarget(u.tool_info?.parameters);
			if (u.tool_info?.error?.message) step.error = u.tool_info.error.message;
			// Running output is append-only here, so the live log gains a line per finished step.
			if (finished) sink.output(`${stepLine(step)}\n`);
		} else if (event.event === "result") {
			const r = event.result ?? {};
			details.conversationId = r.conversation_id ?? details.conversationId;
			details.status = r.status;
			details.durationSeconds = r.duration_seconds;
			response = r.response ?? "";
			details.denied = (r.denied_actions ?? []).map((d: any) => d.display_name ?? d.action);
			const u = r.usage ?? {};
			details.tokens = {
				input: u.input_tokens ?? 0,
				output: u.output_tokens ?? 0,
				thinking: u.thinking_tokens ?? 0,
				cacheRead: u.cache_read_tokens ?? 0,
			};
		}
	};

	const signal = context.abortSignal;
	const exit = await new Promise<{ code: number | null; error?: Error }>((done) => {
		const proc = spawn(agyBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		const onAbort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 3000).unref();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.on("error", (error) => done({ code: null, error }));
		proc.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (buffer) handleLine(buffer);
			if (stderr.trim()) details.notes.push(...stderr.trim().split("\n").slice(-20));
			done({ code });
		});
	});
	await saving;

	if (exit.error) throw new Error(`Failed to start agy: ${exit.error.message}`);
	if (signal?.aborted) throw new Error("Antigravity run was cancelled.");

	const failed = exit.code !== 0 || (details.status !== undefined && details.status !== "SUCCESS");
	return { answer: (response || streamed).trim(), details, failed, exitCode: exit.code };
}

/** One agy run as a tool call: streams its steps into the call's output and details, and returns the tool result. */
async function runAgy(run: AgyRun, api: ToolExecutionApi, context: Context) {
	const { model, allowWrites } = run;
	const { answer, details, failed, exitCode } = await execAgy(run, api, context);
	const parts: string[] = [];
	parts.push(answer || "(agy produced no final answer)");
	if (details.steps.length) parts.push(`--- agy steps ---\n${stepLog(details.steps)}`);
	if (details.denied.length) {
		parts.push(
			`--- denied (headless mode cannot prompt) ---\n${details.denied.join(", ")}` +
				(allowWrites ? "" : "\nRe-run with allowWrites only if the user wants agy to make changes."),
		);
	}
	if (details.notes.length) parts.push(`--- agy notes ---\n${details.notes.join("\n")}`);
	parts.push(
		`[agy model=${model} status=${details.status ?? `exit ${exitCode}`} conversationId=${details.conversationId ?? "?"}]`,
	);

	const usage = toUsage(details.tokens);
	// The Harness applies the default head limits to the output, as Pi's truncateHead did.
	return {
		output: [{ type: "text" as const, text: parts.join("\n\n") }],
		details,
		isError: failed,
		...(usage === undefined ? {} : { usage }),
	};
}

/** Name of the tools-only tool behind subagent profiles with `runner: antigravity`. */
export const AGY_SUBAGENT_TOOL = "antigravity-subagent";

/**
 * `allowWrites` asks through `approvals`, which the TUI answers; without it the call is refused. The tools-only
 * `antigravity-subagent` never asks: the subagent tool calls it for a profile the user wrote, whose `allowWrites`
 * is that consent, and the model is never offered it.
 */
export function createAntigravity(approvals: Approvals): Extension {
	return defineExtension({
		name: "antigravity",
		tools: [
			defineTool({
				name: "antigravity",
				description:
					"Delegate a self-contained task to the Antigravity CLI agent (`agy`), which runs its own agent loop " +
					"with its own tools (file reading, search, shell, web search, browser) on Google's Antigravity models. " +
					"Returns its final answer and a log of the tools it used. By default it cannot write files. " +
					`Model IDs (default ${DEFAULT_MODEL}): gemini-4-{neon,hydrogen}-{low,medium,high,xhigh}, ` +
					"gemini-4-{carbon,argon}-{low,medium,high}, gemini-3.8-flash-{low,medium,high}, " +
					"claude-opus-5-5-{low,medium,high}, claude-sonnet-5-5-{low,medium,high}, gpt-oss-120b-medium. " +
					"The agent starts with no knowledge of this conversation: give it full context in `task`. " +
					"Pass `conversationId` from a previous result to continue that agy conversation.",
				parameters: obj({
					task: str({ description: "Complete, self-contained instructions for the agy agent" }),
					model: opt(str({ description: `agy model ID (default ${DEFAULT_MODEL})` })),
					cwd: opt(str({ description: "Workspace directory for agy (default: current directory)" })),
					conversationId: opt(str({ description: "Continue a previous agy conversation by ID" })),
					allowWrites: opt(
						bool({ description: "Let agy write files and run any command (asks the user first)" }),
					),
				}),
				// Default `unsafe`: an agy run a crash cut off is reported as interrupted, not started again. Its
				// conversation ID is already in the details, so the model can continue it.

				async execute(params, api, context) {
					const baseCwd = api.env?.cwd ?? (await api.agent(context)).cwd ?? process.cwd();
					const model = params.model?.trim() || DEFAULT_MODEL;
					const cwd = params.cwd ? resolve(baseCwd, params.cwd.replace(/^@/, "")) : baseCwd;
					const allowWrites = params.allowWrites === true;

					if (allowWrites) {
						if (!approvals.available)
							throw new Error("allowWrites needs interactive approval, which is unavailable here.");
						const ok = await approvals.request(
							{
								title: "Antigravity: allow writes?",
								message: `agy (${model}) will run with --dangerously-skip-permissions in ${cwd}.`,
							},
							context,
						);
						if (!ok)
							throw new Error(
								"User declined to let agy write files. Retry without allowWrites or ask the user.",
							);
					}
					return runAgy(
						{
							task: params.task,
							model,
							cwd,
							allowWrites,
							...(params.conversationId ? { conversationId: params.conversationId } : {}),
						},
						api,
						context,
					);
				},
			}),
			defineTool({
				name: AGY_SUBAGENT_TOOL,
				description: "An Antigravity subagent run for a profile with runner antigravity; called by the subagent tool.",
				callers: ["tools"],
				parameters: obj({
					task: str(),
					model: opt(str()),
					cwd: str(),
					allowWrites: opt(bool()),
				}),
				execute: (params, api, context) =>
					runAgy(
						{
							task: params.task,
							model: params.model?.trim() || DEFAULT_MODEL,
							cwd: params.cwd,
							allowWrites: params.allowWrites === true,
						},
						api,
						context,
					),
			}),
		],
	});
}
