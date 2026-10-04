import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Base64 keeps multi-line prompts intact through `herdr pane split --env` and the shell.
const PREFILL_ENV = "HERDR_FORK_PREFILL";

type Rect = { width: number; height: number };

function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// Session ids in both engines are UUIDv7, so session lists keep sorting forks by creation time.
function uuidv7(): string {
	const bytes = randomBytes(16);
	const ms = BigInt(Date.now());
	for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

// Relaunch through PATH rather than process.execPath: the Nix wrappers for `pi` and `omo`
// export the env (agent dir, PATH additions) the engine expects. Pi runs as a node script,
// OmO as a compiled binary.
function harness(): string {
	return /^(node|bun)(\.exe)?$/i.test(basename(process.execPath)) ? "pi" : "omo";
}

// Carry over only the flags that decide which code is loaded, so a fork of a session started
// with `-e ./dev-extension` keeps that extension; everything else comes from the session itself.
function forwardedArgs(): string[] {
	const argv = process.argv.slice(2);
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if ((arg === "-e" || arg === "--extension") && argv[i + 1] !== undefined) out.push(arg, argv[++i]);
		else if (arg.startsWith("--extension=")) out.push(arg);
		else if (["-ne", "--no-extensions", "-a", "--approve", "-na", "--no-approve"].includes(arg)) out.push(arg);
	}
	return out;
}

// Writes the fork as a plain JSONL file instead of going through SessionManager.open/
// createBranchedSession: those re-home a manager onto the new file and can rewrite the source
// session's sidecar state, while the live session here must stay exactly as it is.
function writeFork(ctx: ExtensionContext, entryId: string): { file: string; cwd: string; text: string } {
	const sm = ctx.sessionManager;
	const source = sm.getSessionFile();
	if (!source || !existsSync(source)) throw new Error("session is not saved yet");
	const selected = sm.getEntry(entryId);
	if (!selected || selected.type !== "message" || selected.message.role !== "user") {
		throw new Error("fork target is not a user message");
	}
	const entries = selected.parentId ? sm.getBranch(selected.parentId) : [];
	const timestamp = new Date().toISOString();
	const id = uuidv7();
	const base = sm.getHeader() ?? { type: "session", version: 3, cwd: sm.getCwd() };
	// parentSession is what session lists use to nest the fork under the original.
	const header = { ...base, id, timestamp, parentSession: source };
	const file = join(sm.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const lines = [header, ...entries].map((entry) => JSON.stringify(entry));
	writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
	return { file, cwd: header.cwd ?? ctx.cwd, text: userText(selected.message.content) };
}

export default function herdrFork(pi: ExtensionAPI) {
	const herdr = async (args: string[], cwd: string): Promise<string> => {
		const result = await pi.exec("herdr", args, { cwd });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `herdr ${args.slice(0, 2).join(" ")} failed`);
		return result.stdout;
	};
	const herdrJson = async <T>(args: string[], cwd: string): Promise<T> =>
		(JSON.parse(await herdr(args, cwd)) as { result: T }).result;

	pi.on("session_start", (_event, ctx) => {
		const encoded = process.env[PREFILL_ENV];
		if (encoded === undefined) return;
		// Consume once, so tool subprocesses and later /new or /resume never see it.
		delete process.env[PREFILL_ENV];
		if (ctx.hasUI) ctx.ui.setEditorText(Buffer.from(encoded, "base64").toString("utf8"));
	});

	pi.on("session_before_fork", async (event, ctx) => {
		// /clone ("at") keeps native behaviour; only /fork moves to a new pane.
		const pane = process.env.HERDR_PANE_ID;
		if (event.position !== "before" || process.env.HERDR_ENV !== "1" || !pane) return;

		let fork: ReturnType<typeof writeFork> | undefined;
		let launched = false;
		try {
			fork = writeFork(ctx, event.entryId);
			const layout = await herdrJson<{ layout: { panes: { pane_id: string; rect: Rect }[] } }>(
				["pane", "layout", "--pane", pane],
				fork.cwd,
			);
			const rect = layout.layout.panes.find((p) => p.pane_id === pane)?.rect;
			// Terminal cells are about twice as tall as wide; split along the longer visual side.
			const direction = rect && rect.width >= rect.height * 2.2 ? "right" : "down";
			const env = fork.text ? ["--env", `${PREFILL_ENV}=${Buffer.from(fork.text, "utf8").toString("base64")}`] : [];
			const split = await herdrJson<{ pane: { pane_id: string } }>(
				["pane", "split", "--pane", pane, "--direction", direction, "--cwd", fork.cwd, "--focus", ...env],
				fork.cwd,
			);
			const command = [harness(), ...forwardedArgs(), "--session", fork.file].map(shellQuote).join(" ");
			// No exec: the pane drops back to its shell when the forked session quits.
			launched = true;
			await herdr(["pane", "run", split.pane.pane_id, command], fork.cwd);
			ctx.ui.notify(`Forked into Herdr pane ${split.pane.pane_id}`, "info");
			return { cancel: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Once the run command may have reached the new pane, that pane can own the file: keep it,
			// and do not also fork natively, or one /fork would open two sessions.
			if (launched) {
				ctx.ui.notify(`herdr-fork: ${message}`, "warning");
				return { cancel: true };
			}
			if (fork) rmSync(fork.file, { force: true });
			ctx.ui.notify(`herdr-fork: ${message}; using native /fork`, "warning");
			return undefined;
		}
	});
}
