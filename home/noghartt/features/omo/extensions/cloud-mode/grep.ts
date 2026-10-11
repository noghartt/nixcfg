// The engine's grep searches the local disk through a native addon and takes
// no operations, so cloud mode runs ripgrep on the target with the same
// parameters and result shape.
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { q, run, type Target, toRemote } from "./ssh.ts";

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_LINE = 500;

const list = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

function rgArgs(target: Target, params: GrepToolInput): string[] {
	const mode = params.mode ?? "content";
	const args = ["rg", "--color=never"];
	if (mode === "files") args.push("--files-with-matches");
	else if (mode === "count") args.push("--count", "--with-filename");
	else args.push("--json");
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.multiline) args.push("--multiline", "--multiline-dotall");
	if (params.hidden) args.push("--hidden");
	if (params.gitignore === false) args.push("--no-ignore");
	if (params.type) args.push("--type", params.type);
	if (params.context) args.push("--context", String(params.context));
	if (params.before) args.push("--before-context", String(params.before));
	if (params.after) args.push("--after-context", String(params.after));
	for (const glob of list(params.glob)) args.push("--glob", glob);
	const paths = list(params.path).map((path) => toRemote(target, path));
	args.push("--regexp", params.pattern, "--", ...(paths.length ? paths : ["."]));
	return args;
}

// An explicit "." makes rg print "./file"; the engine's grep prints "file".
const displayPath = (path: string): string => (path.startsWith("./") ? path.slice(2) : path);

type Line = { kind: "match" | "context"; path: string; line: number; text: string };

function parseJson(raw: string): Line | undefined {
	const event = JSON.parse(raw) as { type: string; data?: Record<string, any> };
	if (event.type !== "match" && event.type !== "context") return undefined;
	const text = event.data?.lines?.text;
	if (typeof text !== "string") return undefined;
	return { kind: event.type, path: displayPath(event.data?.path?.text ?? ""), line: event.data?.line_number ?? 0, text: text.replace(/\r?\n$/, "") };
}

export async function remoteGrep(target: Target, params: GrepToolInput, signal?: AbortSignal) {
	const mode = params.mode ?? "content";
	const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const skip = Math.max(0, params.skip ?? 0);
	const results: string[] = [];
	const details: GrepToolDetails = {};
	let seen = 0;
	let limitReached = false;
	let linesTruncated = false;
	let pending = "";
	let lastPath = "";
	let lastLine = 0;

	const take = (raw: string, kill: () => void) => {
		if (!raw || limitReached) return;
		if (mode !== "content") {
			if (seen++ >= skip) results.push(displayPath(raw));
		} else {
			const line = parseJson(raw);
			if (!line) return;
			if (line.kind === "match") seen++;
			if (seen <= skip) return;
			let text = line.text;
			if (text.length > MAX_LINE) {
				text = `${text.slice(0, MAX_LINE)}... [truncated]`;
				linesTruncated = true;
			}
			if (results.length && (line.path !== lastPath || line.line > lastLine + 1)) results.push("--");
			results.push(`${line.path}${line.kind === "match" ? ":" : "-"}${line.line}${line.kind === "match" ? ":" : "-"} ${text}`);
			lastPath = line.path;
			lastLine = line.line;
		}
		if (seen - skip >= limit) {
			limitReached = true;
			kill();
		}
	};

	// The search shares the multiplexed connection, where killing the client
	// does not stop rg, so the deadline is enforced on the remote side too.
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const rg = rgArgs(target, params).map(q).join(" ");
	const command = `cd ${q(target.cwd)} && exec timeout ${Math.ceil(timeoutMs / 1000)} ${rg}`;
	const result = await run(target.dest, command, {
		signal,
		timeoutMs,
		onStdout: (chunk, kill) => {
			const lines = (pending + chunk.toString("utf8")).split("\n");
			pending = lines.pop() ?? "";
			for (const raw of lines) take(raw, kill);
		},
	});
	take(pending, () => {});

	// rg exits 1 for "no matches" and 2 for errors; a kill after the limit is not an error.
	if (!limitReached && result.code === 124) throw new Error(`grep timed out after ${Math.ceil(timeoutMs / 1000)}s on ${target.dest}`);
	if (!limitReached && result.code !== 0 && result.code !== 1) {
		throw new Error(result.stderr.trim() || `rg failed on ${target.dest} (exit ${result.code})`);
	}
	if (!results.length) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

	const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;
	if (limitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} results limit reached; use skip to page`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text" as const, text: output }], details: Object.keys(details).length ? details : undefined };
}
