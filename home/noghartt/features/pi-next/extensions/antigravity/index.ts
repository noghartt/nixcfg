/**
 * antigravity: hand a task to the Antigravity CLI (`agy`) as a sub-agent.
 *
 * Runs `agy -p` headless with stream-json output. agy keeps its own login,
 * quota, tools and conversation; Pi only sees the final answer plus a step log.
 * Headless agy auto-denies anything needing a permission prompt (file writes),
 * so the default is effectively read-and-investigate. `allowWrites` adds
 * --dangerously-skip-permissions and always asks the user first.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MODEL = "gemini-4-neon-high";

type Step = { tool: string; target?: string; state: string; error?: string };

type Details = {
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

function agyBinary(): string {
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

function stepLog(steps: Step[]): string {
	return steps
		.map((s) => {
			const mark = s.state === "DONE" ? "✓" : s.state === "ERROR" ? "✗" : "…";
			const err = s.error ? ` — ${s.error.split("\n")[0]}` : "";
			return `${mark} ${s.tool}${s.target ? ` ${s.target}` : ""}${err}`;
		})
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "antigravity",
		label: "Antigravity",
		description:
			"Delegate a self-contained task to the Antigravity CLI agent (`agy`), which runs its own agent loop " +
			"with its own tools (file reading, search, shell, web search, browser) on Google's Antigravity models. " +
			"Returns its final answer and a log of the tools it used. By default it cannot write files. " +
			`Model IDs (default ${DEFAULT_MODEL}): gemini-4-{neon,hydrogen}-{low,medium,high,xhigh}, ` +
			"gemini-4-{carbon,argon}-{low,medium,high}, gemini-3.8-flash-{low,medium,high}, " +
			"claude-opus-5-5-{low,medium,high}, claude-sonnet-5-5-{low,medium,high}, gpt-oss-120b-medium. " +
			"The agent starts with no knowledge of this conversation: give it full context in `task`. " +
			"Pass `conversationId` from a previous result to continue that agy conversation.",
		promptSnippet: "Delegate a self-contained task to an Antigravity (agy) sub-agent on Gemini/Claude models",
		promptGuidelines: [
			"Use antigravity only when the user asks for Antigravity/agy/Gemini, or wants a second opinion from another model; do not use antigravity for routine work you can do directly.",
			"Set allowWrites on antigravity only when the user explicitly wants agy to modify files.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Complete, self-contained instructions for the agy agent" }),
			model: Type.Optional(Type.String({ description: `agy model ID (default ${DEFAULT_MODEL})` })),
			cwd: Type.Optional(Type.String({ description: "Workspace directory for agy (default: current directory)" })),
			conversationId: Type.Optional(Type.String({ description: "Continue a previous agy conversation by ID" })),
			allowWrites: Type.Optional(
				Type.Boolean({ description: "Let agy write files and run any command (asks the user first)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = params.model?.trim() || DEFAULT_MODEL;
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd.replace(/^@/, "")) : ctx.cwd;
			const allowWrites = params.allowWrites === true;

			if (allowWrites) {
				if (!ctx.hasUI) throw new Error("allowWrites needs interactive approval, which is unavailable here.");
				const ok = await ctx.ui.confirm(
					"Antigravity: allow writes?",
					`agy (${model}) will run with --dangerously-skip-permissions in ${cwd}.`,
				);
				if (!ok) throw new Error("User declined to let agy write files. Retry without allowWrites or ask the user.");
			}

			const args = ["--output-format", "stream-json", "--model", model];
			if (params.conversationId) args.push("--conversation", params.conversationId);
			if (allowWrites) args.push("--dangerously-skip-permissions");
			// -p must come last: agy treats the token after it as the prompt.
			args.push("-p", params.task);

			const details: Details = { model, cwd, allowWrites, steps: [], denied: [], notes: [] };
			let response = "";
			let streamed = "";
			const stepsByIndex = new Map<number, Step>();

			const progress = () =>
				onUpdate?.({
					content: [{ type: "text", text: stepLog(details.steps) || "agy starting..." }],
					details: { ...details, steps: [...details.steps] },
				});

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
					step.state = u.state;
					step.target ??= stepTarget(u.tool_info?.parameters);
					if (u.tool_info?.error?.message) step.error = u.tool_info.error.message;
					progress();
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

			progress();
			const exit = await new Promise<{ code: number | null; error?: Error }>((done) => {
				const proc = spawn(agyBinary(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
				let buffer = "";
				let stderr = "";
				const onAbort = () => {
					proc.kill("SIGTERM");
					setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 3000).unref();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
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

			if (exit.error) throw new Error(`Failed to start agy: ${exit.error.message}`);
			if (signal?.aborted) throw new Error("Antigravity run was cancelled.");

			const answer = (response || streamed).trim();
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
				`[agy model=${model} status=${details.status ?? `exit ${exit.code}`} conversationId=${details.conversationId ?? "?"}]`,
			);

			const truncation = truncateHead(parts.join("\n\n"), {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const failed = exit.code !== 0 || (details.status !== undefined && details.status !== "SUCCESS");

			return {
				content: [{ type: "text", text: truncation.content }],
				details,
				usage: toUsage(details.tokens),
				isError: failed,
			};
		},

		renderCall(args, theme) {
			const model = args.model || DEFAULT_MODEL;
			const task = (args.task ?? "").replace(/\s+/g, " ");
			const preview = task.length > 100 ? `${task.slice(0, 97)}...` : task;
			let text =
				theme.fg("toolTitle", theme.bold("antigravity ")) +
				theme.fg("accent", model) +
				(args.allowWrites ? theme.fg("warning", " [writes]") : "") +
				(args.conversationId ? theme.fg("muted", " (continue)") : "");
			if (preview) text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as Details | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!d) return new Text(text, 0, 0);
			const steps = d.steps
				.map((s) => {
					const mark =
						s.state === "DONE"
							? theme.fg("success", "✓")
							: s.state === "ERROR"
								? theme.fg("error", "✗")
								: theme.fg("warning", "⏳");
					return `${mark} ${theme.fg("accent", s.tool)}${s.target ? theme.fg("dim", ` ${s.target}`) : ""}`;
				});
			if (isPartial) return new Text(steps.slice(-8).join("\n") || theme.fg("muted", "agy starting..."), 0, 0);
			const t = d.tokens;
			const meta = theme.fg(
				"muted",
				`${d.steps.length} steps · ${d.durationSeconds?.toFixed(1) ?? "?"}s` +
					(t ? ` · ${t.input}↑ ${t.output + t.thinking}↓` : "") +
					(d.denied.length ? ` · denied: ${d.denied.join(", ")}` : ""),
			);
			if (!expanded) {
				const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
				return new Text(`${meta}\n${theme.fg("toolOutput", firstLine)}`, 0, 0);
			}
			return new Text(`${meta}\n${steps.join("\n")}\n\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});
}
