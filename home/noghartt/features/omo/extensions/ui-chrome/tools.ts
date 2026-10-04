// Compact tool rows for every tool (built-in, MCP, OmO plugins): one header
// line (status mark, tool, key argument, badges) and a few output lines on a
// card. The expand toggle (ctrl+o) hands each row back to the tool's own full
// renderer. Rows OmO folds into read/grep/find/ls exploration groups are drawn
// by the group, so grouping is unchanged.
import { keyText } from "@code-yeongyu/senpi";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { onToolRow, theme, type ToolRow } from "./core/host.ts";
import { card, cardInner, plural, stripAnsi, type Theme } from "./core/style.ts";

const OUTPUT_LINES = 3;
const KEY_FIELDS = ["command", "path", "file_path", "pattern", "query", "url", "summary", "task_summary", "description", "prompt", "name", "op", "action", "task"];

function relative(path: string, cwd: string): string {
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

function keyArgument(row: ToolRow): string {
	const args = row.args;
	const name = row.toolName.toLowerCase();
	const path = str(args.path) ?? str(args.file_path);
	if (name === "bash" || name === "powershell") return (str(args.command) ?? "").split("\n")[0] ?? "";
	if (name === "grep") return [str(args.pattern) && `"${args.pattern}"`, path && relative(path, row.cwd)].filter(Boolean).join(" in ");
	if (path) return relative(path, row.cwd);
	if (name === "task" && Array.isArray(args.tasks)) return plural(args.tasks.length, "task");
	for (const field of KEY_FIELDS) {
		const value = str(args[field]);
		if (value) return value.split("\n")[0] ?? "";
	}
	const first = Object.values(args).find((value) => str(value));
	return typeof first === "string" ? (first.split("\n")[0] ?? "") : "";
}

function outputText(row: ToolRow): string[] {
	const text = (row.result?.content ?? [])
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text ?? "")
		.join("\n");
	return stripAnsi(text)
		.split("\n")
		.map((line) => line.replace(/\t/g, "  ").trimEnd())
		.filter((line) => line.trim());
}

function diffStat(details: unknown): string | undefined {
	const diff = (details as { diff?: unknown } | undefined)?.diff;
	if (typeof diff !== "string") return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+(?!\+\+)/.test(line)) added++;
		else if (/^-(?!--)/.test(line)) removed++;
	}
	return `+${added} -${removed}`;
}

type Status = "pending" | "running" | "error" | "done";

function status(row: ToolRow): Status {
	if (row.result?.isError) return "error";
	if (!row.isPartial && row.result) return "done";
	return row.executionStarted ? "running" : "pending";
}

const MARKS: Record<Status, [glyph: string, token: string]> = {
	pending: ["○", "dim"],
	running: ["◐", "warning"],
	error: ["✗", "error"],
	done: ["✓", "success"],
};

// Tools whose output is the file itself or a diff: the row shows a count, not
// the content, which ctrl+o still reveals.
const QUIET = new Set(["read", "write", "edit", "apply_patch"]);

function rowLines(row: ToolRow, th: Theme, width: number): string[] {
	const state = status(row);
	const [glyph, token] = MARKS[state];
	const output = outputText(row);
	const name = row.toolName.toLowerCase();
	const badges: string[] = [];
	const stat = state === "done" && (name === "edit" || name === "write" || name === "apply_patch") ? diffStat(row.result?.details) : undefined;
	if (stat) badges.push(stat);
	if (state === "done" && name === "read") badges.push(plural(output.length, "line"));
	if (state === "error") badges.push("failed");

	const inner = cardInner(width);
	const head = `${th.fg(token, glyph)} ${th.bold(row.toolName)}`;
	const arg = keyArgument(row);
	const tail = badges.length ? ` ${th.fg("dim", badges.join(" · "))}` : "";
	const header = truncateToWidth(`${head}${arg ? ` ${th.fg("muted", arg)}` : ""}${tail}`, inner, "…");

	const shown = state === "error" || !QUIET.has(name) ? output.slice(0, OUTPUT_LINES) : [];
	const body = shown.map((line) => truncateToWidth(th.fg(state === "error" ? "error" : "toolOutput", `  ${line}`), inner, "…"));
	const hidden = (QUIET.has(name) && state !== "error" ? 0 : output.length - shown.length);
	if (hidden > 0) body.push(th.fg("dim", `  … ${plural(hidden, "more line")} (${keyText("app.tools.expand")} to expand)`));

	const style = state === "error" ? { tone: "error" as const, bg: "toolErrorBg" } : { tone: "dim" as const, bg: "toolPendingBg" };
	return ["", ...card(th, style, [header, ...body], width)];
}

export default function tools(): void {
	onToolRow((row, stock, width) => {
		const th = theme();
		if (row.expanded || !th || !row.toolName) return stock(width);
		return rowLines(row, th, width);
	});
}
