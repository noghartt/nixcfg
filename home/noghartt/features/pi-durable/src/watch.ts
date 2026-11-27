import { spawn } from "node:child_process";
import { type FSWatcher, watch as watchPath } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type TaskRuntime,
	type TaskId,
} from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { oneLine } from "./host.ts";
import { localEnvCwd } from "./sandbox-env.ts";
import { Background, REPORT_KIND } from "./state.ts";

export type WatchInput = {
	name: string;
	kind: "command" | "file" | "timer";
	cwd: string;
	command?: string;
	/** Command: report output lines matching this regular expression. */
	pattern?: string;
	path?: string;
	seconds?: number;
	note?: string;
	/** Command: report only the first matching line. File: stop after the first change. */
	once: boolean;
	/** Command: run it again when the session reopens after pi-durable stopped it; otherwise report that it stopped. */
	restartOnResume: boolean;
};
type WatchState = { phase: "start" } | { phase: "run" } | { phase: "fire" };
type Runtime = TaskRuntime<WatchInput, WatchState, null, object>;

const TAIL_LINES = 40;
const MAX_LINE = 400;
/** File events closer together than this are reported as one change. */
const FILE_DEBOUNCE_MS = 500;

/** Report to the watcher's conversation as a follow-up input, so an idle agent wakes up and a busy one sees it next. */
async function report(runtime: Runtime, name: string, text: string, key: string, context: Context): Promise<void> {
	const conversation = await runtime.conversation(runtime.conversationId, context);
	const content = `[watch ${name}] ${text}`;
	await conversation?.submit(
		{
			type: "input",
			content,
			whenBusy: "followUp",
			onAbort: "keep",
			requestId: `watch:${runtime.taskId}:${key}`,
			entry: { kind: REPORT_KIND, data: { from: `watch ${name}`, text } },
		},
		context,
	);
}

const finish = (runtime: Runtime, context: Context) =>
	runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);

/** Run the command until it exits or the watcher stops, reporting matching lines and the exit. */
async function runCommand(task: { input: WatchInput; id: TaskId }, runtime: Runtime, context: Context): Promise<void> {
	const { name, command, cwd, pattern, once } = task.input;
	const regex = pattern === undefined ? undefined : new RegExp(pattern, "u");
	const tail: string[] = [];
	let matches = 0;
	// Report keys of this run; a restarted command reports again.
	const run = runtime.now();
	let pending = Promise.resolve();
	const exit = await new Promise<{ code: number | null; signal: string | null; error?: Error }>((done) => {
		// Its own process group, so stopping the watcher stops everything the command started.
		const child = spawn("bash", ["-c", command!], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			if (child.pid === undefined || child.exitCode !== null) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
				} catch {}
			}, 3000).unref();
		};
		if (runtime.signal.aborted) kill();
		runtime.signal.addEventListener("abort", kill, { once: true });
		let buffer = "";
		const onData = (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const raw of lines) onLine(raw);
		};
		const onLine = (raw: string) => {
			const line = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}…` : raw;
			tail.push(line);
			if (tail.length > TAIL_LINES) tail.shift();
			if (regex === undefined || !regex.test(raw) || (once && matches > 0)) return;
			matches++;
			const key = `match-${run}-${matches}`;
			pending = pending.then(() =>
				report(runtime, name, `output matched /${pattern}/: ${line}`, key, context).catch((error) =>
					runtime.report(error),
				),
			);
		};
		child.stdout.setEncoding("utf8").on("data", onData);
		child.stderr.setEncoding("utf8").on("data", onData);
		child.on("error", (error) => done({ code: null, signal: null, error }));
		child.on("close", (code, signal) => {
			runtime.signal.removeEventListener("abort", kill);
			if (buffer) onLine(buffer);
			done({ code, signal });
		});
	});
	await pending;
	// Stopped (agents stop, or pi-durable closing): the abort handler or the next open takes over.
	if (runtime.signal.aborted) return;
	const status = exit.error
		? `failed to start: ${exit.error.message}`
		: exit.signal !== null
			? `was killed by ${exit.signal}`
			: `exited with code ${exit.code}`;
	await report(runtime, name, `\`${command}\` ${status}. Last output:\n${tail.join("\n") || "(none)"}`, `exit-${run}`, context);
	await finish(runtime, context);
}

/** Watch a file or directory until the watcher stops (or after the first change, `once`). */
async function runFile(task: { input: WatchInput; id: TaskId }, runtime: Runtime, context: Context): Promise<void> {
	const { name, path, once } = task.input;
	const target = path!;
	const directory = (await stat(target)).isDirectory();
	await new Promise<void>((done) => {
		let watcher: FSWatcher | undefined;
		let timer: NodeJS.Timeout | undefined;
		const changed = new Set<string>();
		let reporting = Promise.resolve();
		const stop = () => {
			watcher?.close();
			if (timer !== undefined) clearTimeout(timer);
			done();
		};
		const flush = () => {
			timer = undefined;
			const files = [...changed].slice(0, 20);
			changed.clear();
			// Every change is a new event, also after a reopen: the key only guards against delivering one twice.
			const key = `change-${runtime.now()}`;
			reporting = reporting
				.then(() => report(runtime, name, `changed: ${files.join(", ") || target}`, key, context))
				.catch((error) => runtime.report(error));
			if (once) void reporting.then(stop);
		};
		if (runtime.signal.aborted) return done();
		runtime.signal.addEventListener("abort", stop, { once: true });
		watcher = watchPath(target, { recursive: directory }, (_event, file) => {
			const shown = file === null ? target : String(file);
			// Version-control internals change on every git command.
			if (/(^|\/)\.git(\/|$)/u.test(shown)) return;
			changed.add(shown);
			timer ??= setTimeout(flush, FILE_DEBOUNCE_MS);
		});
		watcher.on("error", (error) => {
			runtime.report(error);
			stop();
		});
	});
	if (runtime.signal.aborted) return;
	await finish(runtime, context);
}

/**
 * A background watcher of its conversation: a command's output and exit, a file's changes, or a timer. Reports arrive
 * as follow-up inputs. Timers sleep durably and fire even across restarts; a command pi-durable stopped by closing is
 * reported as stopped on the next open (or run again, `restartOnResume`); a file watch simply resumes.
 */
export const Watcher = defineTask<WatchInput, WatchState, null>({
	name: "pi-durable.watcher",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			if (task.input.kind === "timer") {
				return runtime.sleepUntil(runtime.now() + (task.input.seconds ?? 60) * 1000, { phase: "fire" }, context);
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run" } }), context);
		},
		run: async (task, runtime, context) => {
			if (task.input.kind === "file") return runFile(task, runtime, context);
			const resumed = (await runtime.memo<boolean>("started", context)) === true;
			if (resumed && !task.input.restartOnResume) {
				await report(
					runtime,
					task.input.name,
					`\`${task.input.command}\` was stopped when pi-durable closed and was not started again.`,
					"stopped",
					context,
				);
				return finish(runtime, context);
			}
			// Marked before it starts: a rerun knows the process was cut off.
			await runtime.memo("started", true, context);
			if (resumed) {
				const key = `restart-${runtime.now()}`;
				await report(runtime, task.input.name, `restarting \`${task.input.command}\``, key, context);
			}
			return runCommand(task, runtime, context);
		},
		fire: async (task, runtime, context) => {
			await report(runtime, task.input.name, `timer fired${task.input.note ? `: ${task.input.note}` : "."}`, "fire", context);
			await finish(runtime, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const WatchParameters = obj({
	kind: oneOf(["command", "file", "timer"], {
		description:
			"command: run a shell command in the background and report its exit (and output lines matching pattern); " +
			"file: report changes to a file or directory; timer: report after seconds",
	}),
	name: opt(str({ description: "A short name for reports and agents stop" })),
	command: opt(str({ description: "command: the shell command, run in the current directory" })),
	pattern: opt(str({ description: "command: a regular expression; matching output lines are reported" })),
	once: opt(
		bool({ description: "command: report only the first match (default true); file: stop after the first change (default true)" }),
	),
	restartOnResume: opt(
		bool({ description: "command: run it again if pi-durable closed while it ran (default false: report it stopped)" }),
	),
	path: opt(str({ description: "file: the file or directory to watch" })),
	seconds: opt(int({ description: "timer: seconds from now" })),
	note: opt(str({ description: "timer: what the reminder is for" })),
});

/** The `watch` tool: start a background watcher of this conversation. Listed and stopped through `agents`. */
export function createWatchExtension(defaultCwd: string): Extension {
	const watch = defineTool({
		name: "watch",
		description:
			"Start a background watcher that wakes you with a message: when a command exits or prints a matching line " +
			"(a test run, a build, a dev server becoming ready), when files change, or when a timer fires. Returns at once; " +
			"keep working or end your turn, and the report arrives as a new message. List and stop watchers with agents.",
		parameters: WatchParameters,
		// The keyed task makes a rerun find the watcher it started.
		replay: "safe",
		execute: async (args, api, context) => {
			const cwd = localEnvCwd(api.env) ?? (await api.agent(context)).cwd ?? defaultCwd;
			if (args.kind === "command" && !args.command) throw new Error("kind command needs command");
			if (args.kind === "file" && !args.path) throw new Error("kind file needs path");
			if (args.kind === "timer" && !(args.seconds !== undefined && args.seconds > 0)) {
				throw new Error("kind timer needs seconds > 0");
			}
			if (args.pattern !== undefined) new RegExp(args.pattern, "u");
			const path = args.path === undefined ? undefined : resolve(cwd, args.path.replace(/^@/u, ""));
			if (path !== undefined) await stat(path);
			const description =
				args.kind === "command"
					? `\`${oneLine(args.command!, 80)}\`${args.pattern === undefined ? "" : ` /${args.pattern}/`}`
					: args.kind === "file"
						? path!
						: `${args.seconds}s${args.note ? `: ${oneLine(args.note, 60)}` : ""}`;
			const name = args.name?.trim() || `${args.kind}-${api.taskId}`;
			const input: WatchInput = {
				name,
				kind: args.kind,
				cwd,
				...(args.command === undefined ? {} : { command: args.command }),
				...(args.pattern === undefined ? {} : { pattern: args.pattern }),
				...(path === undefined ? {} : { path }),
				...(args.seconds === undefined ? {} : { seconds: args.seconds }),
				...(args.note === undefined ? {} : { note: args.note }),
				once: args.once ?? true,
				restartOnResume: args.restartOnResume ?? false,
			};
			// A background task of the conversation: Esc and idle waits leave it running; agents stop ends it.
			const taskId = await api.createTask(
				Watcher,
				input,
				{ ownership: { kind: "conversation" }, background: true, abandonOnRestart: false, key: "watcher" },
				context,
			);
			await api.commit(async (tx) => {
				(await tx.doc(Background, api.conversationId)).watchers[String(taskId)] = {
					taskId,
					name,
					kind: args.kind,
					description,
				};
			}, context);
			return {
				output: [{ type: "text", text: `Watching ${description} as ${name} (task #${taskId}).` }],
				details: { watcher: taskId, name },
			};
		},
	});
	return defineExtension({ name: "pi-durable-watch", tools: [watch], tasks: [Watcher] });
}
