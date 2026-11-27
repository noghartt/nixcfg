import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { LiveState, PromptInput } from "@earendil-works/pi-durable";
import { lastAnswer, type DurableView } from "./runtime.ts";
import { Identity } from "./state.ts";

/**
 * Rex integration: pi-durable inside a Rex terminal (REX_SESSION set) reports what it is doing with the Program Status
 * Protocol (OSC 7501), and its prompt carries Rex's own session-start context. Outside Rex both stay off.
 * https://www.superlogical.com/rex/docs/build/program-status
 */
export function inRex(): boolean {
	return Boolean(process.env.REX_SESSION);
}

const APP = "pi-durable";

/** Free text as the protocol carries it: one line without control characters, base64 of UTF-8 within `bytes`. */
function encode(text: string, bytes: number): string {
	let line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
	while (Buffer.byteLength(line) > bytes) line = line.slice(0, Math.floor(line.length * 0.9));
	return Buffer.from(line).toString("base64");
}

type Report = {
	state: "idle" | "working" | "done" | "blocked" | "error" | "clear";
	id?: string;
	kind?: "permission" | "question" | "auth";
	title?: string;
	msg?: string;
};

function sequence(report: Report): string {
	const pairs = [`state=${report.state}`];
	if (report.id !== undefined) pairs.push(`id=${report.id}`);
	if (report.kind !== undefined) pairs.push(`kind=${report.kind}`);
	// Every report replaces its record, so `app` goes on each root report; children inherit it.
	if (report.id === undefined && report.state !== "clear") pairs.push(`app=${APP}`);
	if (report.title) pairs.push(`title=${encode(report.title, 160)}`);
	if (report.msg) pairs.push(`msg=${encode(report.msg, 1500)}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/** What the shown conversation's run is doing, in a few words. */
function working(live: LiveState): string {
	const tool = live.tools?.find((slot) => slot.status === "running");
	if (tool !== undefined) return `Running ${tool.name}`;
	const parked = live.tools?.find((slot) => slot.status === "sleeping" || slot.status === "waiting");
	if (parked !== undefined) return `Waiting on ${parked.name}`;
	if (live.generation?.retry !== undefined) return `Retrying: ${live.generation.retry.error}`;
	if (live.compactions?.[0] !== undefined) return "Compacting";
	return "Working";
}

/**
 * Turns views into status reports: the root record follows the shown conversation (working, blocked on an approval,
 * then done or error with the answer's first line, idle after Esc), and each other conversation at work (subagents,
 * branches) gets a child record under `agents/`. Only changes are written.
 */
export class RexStatus {
	readonly #write: (data: string) => void;
	#view: DurableView | undefined;
	#approval: string | undefined;
	#root: Report = { state: "idle" };
	#rootSent = "";
	readonly #children = new Map<string, string>();

	constructor(write: (data: string) => void) {
		this.#write = write;
		this.#send(this.#root);
	}

	update(view: DurableView): void {
		this.#view = view;
		this.#flush();
	}

	/** An approval is shown (its title) or answered (`undefined`). */
	approval(title: string | undefined): void {
		this.#approval = title;
		this.#flush();
	}

	/** Leaving: no record should outlive the program the user just closed. */
	close(): void {
		this.#write(sequence({ state: "clear" }));
	}

	#flush(): void {
		const view = this.#view;
		if (view === undefined) return;
		const live = (view.conversation.docs["pi.live"] ?? {}) as LiveState;
		const others = view.activity.filter((item) => item.kind === "conversation");
		const before = this.#root.state;
		if (this.#approval !== undefined) {
			this.#root = { state: "blocked", kind: "permission", msg: this.#approval };
		} else if (live.run !== undefined) {
			this.#root = { state: "working", msg: working(live) };
		} else if (others.length > 0) {
			this.#root = { state: "working", msg: `${others.length} agent${others.length === 1 ? "" : "s"} at work` };
		} else if (before === "working" || before === "blocked") {
			// Done and error stay until a run starts again: Rex clears them once the user has looked.
			const failure = live.runFailure;
			if (failure?.reason === "aborted") this.#root = { state: "idle" };
			else if (failure !== undefined) {
				this.#root = { state: "error", msg: failure.detail ?? failure.reason.replaceAll("_", " ") };
			} else {
				const answer = lastAnswer(view.conversation)?.split("\n").find((line) => line.trim());
				this.#root = { state: "done", msg: answer ?? "Finished" };
			}
		}
		this.#send(this.#root);

		const seen = new Set<string>();
		for (const item of others) {
			const id = `agents/${String(item.conversationId ?? item.key).replace(/[^A-Za-z0-9_.+-]/gu, "_").slice(0, 32)}`;
			seen.add(id);
			const text = sequence({ state: "working", id, title: item.label, msg: item.status });
			if (this.#children.get(id) === text) continue;
			this.#children.set(id, text);
			this.#write(text);
		}
		for (const id of this.#children.keys()) {
			if (seen.has(id)) continue;
			this.#children.delete(id);
			this.#write(sequence({ state: "clear", id }));
		}
	}

	#send(report: Report): void {
		const text = sequence(report);
		if (text === this.#rootSent) return;
		this.#rootSent = text;
		this.#write(text);
	}
}

// Rex's context tells the agent to rename the Rex session, but one session holds many tabs (one agent each), so the
// agent names its own tab instead. Matches Rex's paragraph by its opening; if Rex rewords it, ours is appended.
const SESSION_NAMING = /^Name the session\b[\s\S]*?(?=\n\s*\n|$(?![\s\S]))/m;

export function nameTab(text: string, window: string | undefined): string {
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

/** Rex's session-start context with tab naming in place of session naming. */
export async function readRexContext(): Promise<string | undefined> {
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

/**
 * Rex's session-start context, as its hook gives Claude Code and Codex: the session and pane IDs and how to use the
 * `rex` CLI. Read once per process from the installed `rex`, so a Rex upgrade updates it. Subagents go without: it
 * tells the agent to name its Rex tab, which belongs to the conversation the user talks to, and they still have
 * the rex skill and the REX_* variables.
 */
export function createRexContext(): ((input: PromptInput, context: Context) => Promise<string | undefined>) | undefined {
	if (!inRex()) return undefined;
	// Read once; a missing or broken `rex` leaves the section out rather than running again for every request.
	let text: Promise<string | undefined> | undefined;
	return async (input, context) => {
		const identity = await input.read.snapshot(Identity, input.conversationId, context);
		if (identity?.parent !== undefined) return undefined;
		return (text ??= readRexContext());
	};
}
