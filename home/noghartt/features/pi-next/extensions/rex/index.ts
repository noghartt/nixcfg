/**
 * Rex integration for `pi`, active only inside a Rex terminal (REX_SESSION set) in the TUI:
 *
 * - Program Status Protocol (OSC 7501): working (with the running tool), blocked while a dialog waits on the user,
 *   then done with the answer's first line, error, or idle after Esc. Rex shows it on the tab and in its session
 *   picker. https://www.superlogical.com/rex/docs/build/program-status
 * - Rex's session-start context (session and pane IDs, how to use `rex`), which `rex skill setup` installs as a hook
 *   for Claude Code and Codex but cannot for Pi, as a `rex` prompt section, telling the agent to name its tab rather
 *   than the Rex session (one session holds many tabs).
 *
 * pi-durable does the same in its own src/rex.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Same as pi-durable's src/rex.ts: Rex's paragraph on naming the session becomes one on naming this tab.
const SESSION_NAMING = /^Name the session\b[\s\S]*?(?=\n\s*\n|$(?![\s\S]))/m;

function nameTab(text: string, window: string | undefined): string {
	const target = window ?? "<window_id from `rex whoami --json`>";
	const paragraph = [
		"Name this tab (a Rex window) as part of handling the first request that identifies the work; never rename",
		`the Rex session, which holds other tabs. Run \`rex window rename -s "$REX_SESSION" ${target} <label>\``,
		"without waiting for the user to ask and before loading the skill. Use two to four lowercase words joined by",
		"hyphens, such as `fix-login-redirect`. Name the task. Keep the existing label if it already describes the",
		"same work. This overrides the rex skill's \"Name the session\" section.",
		"",
		"Use Rex proactively, not only when asked: background tabs for servers and long jobs, a tab for large diffs or",
		"output instead of pasting them, reading the user's panes (with scrollback) instead of asking for a paste, other",
		"agents' status, remote hosts. The rex-workflows skill says when and how; read it with the rex skill.",
	].join("\n");
	return SESSION_NAMING.test(text) ? text.replace(SESSION_NAMING, paragraph) : `${text}\n\n${paragraph}`;
}

const rex = (args: string[]): Promise<string | undefined> =>
	promisify(execFile)("rex", [...args, "--autostart=false"], { timeout: 3000 })
		.then(({ stdout }) => stdout.trim() || undefined)
		.catch(() => undefined);

async function readRexContext(): Promise<string | undefined> {
	const [text, whoami] = await Promise.all([
		rex(["__internal", "session-start", "--agent", "pi"]),
		rex(["whoami", "--json"]),
	]);
	if (text === undefined) return undefined;
	let window: string | undefined;
	try {
		const id = whoami === undefined ? undefined : (JSON.parse(whoami) as { window_id?: unknown }).window_id;
		if (typeof id === "string" && id) window = id;
	} catch {}
	return nameTab(text, window);
}

type Report = {
	state: "idle" | "working" | "done" | "blocked" | "error" | "clear";
	kind?: "permission" | "question";
	msg?: string;
};

/** Free text as the protocol carries it: one line without control characters, base64 of UTF-8. */
function encode(text: string, bytes: number): string {
	let line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
	while (Buffer.byteLength(line) > bytes) line = line.slice(0, Math.floor(line.length * 0.9));
	return Buffer.from(line).toString("base64");
}

function sequence(report: Report): string {
	const pairs = [`state=${report.state}`];
	if (report.kind !== undefined) pairs.push(`kind=${report.kind}`);
	// Every report replaces its record, so `app` goes on each one.
	if (report.state !== "clear") pairs.push("app=pi");
	if (report.msg) pairs.push(`msg=${encode(report.msg, 1500)}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/** The first line of a run's last answer, or its error. */
function outcome(messages: readonly unknown[]): Report {
	for (const message of [...messages].reverse() as Array<Record<string, unknown>>) {
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return { state: "idle" };
		if (message.stopReason === "error") return { state: "error", msg: String(message.errorMessage ?? "Failed") };
		const text = (message.content as Array<{ type: string; text?: string }>)
			.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
			.join("")
			.split("\n")
			.find((line) => line.trim());
		return { state: "done", msg: text ?? "Finished" };
	}
	return { state: "done", msg: "Finished" };
}

export default function (pi: ExtensionAPI) {
	if (!process.env.REX_SESSION) return;

	let sent = "";
	let running = false;
	let current: Report = { state: "idle" };
	let ending: Report | undefined;
	// In rpc and json modes stdout is the protocol; only the TUI may write to the terminal.
	const report = (ctx: ExtensionContext, next: Report): void => {
		current = next;
		if (ctx.mode !== "tui") return;
		const text = sequence(next);
		if (text === sent) return;
		sent = text;
		process.stdout.write(text);
	};

	pi.on("session_start", (_event, ctx) => report(ctx, { state: "idle" }));
	pi.on("agent_start", (_event, ctx) => {
		running = true;
		ending = undefined;
		report(ctx, { state: "working", msg: "Working" });
	});
	pi.on("tool_execution_start", (event, ctx) => report(ctx, { state: "working", msg: `Running ${event.toolName}` }));
	pi.on("tool_execution_end", (_event, ctx) => report(ctx, { state: "working", msg: "Working" }));
	pi.on("ui_prompt_start", (event, ctx) => {
		const kind = event.kind === "confirm" || event.kind === "select" ? "permission" : "question";
		report(ctx, { state: "blocked", kind, msg: event.title ?? "Waiting for you" });
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		if (current.state === "blocked") report(ctx, running ? { state: "working", msg: "Working" } : { state: "idle" });
	});
	// agent_end may still retry, compact or take a follow-up; agent_settled is final.
	pi.on("agent_end", (event) => {
		ending = outcome(event.messages);
	});
	pi.on("agent_settled", (event, ctx) => {
		running = false;
		report(ctx, event.aborted ? { state: "idle" } : (ending ?? { state: "done", msg: "Finished" }));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") process.stdout.write(sequence({ state: "clear" }));
		sent = "";
	});

	let context: Promise<string | undefined> | undefined;
	pi.on("before_agent_start", async (event) => {
		context ??= readRexContext();
		const text = await context;
		if (text !== undefined) event.systemPromptOptions.sections.rex = text;
	});
}
