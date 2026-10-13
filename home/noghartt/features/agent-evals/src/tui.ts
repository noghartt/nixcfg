import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestSuggestion, getLabel, nodeTarget, setLabel, type TargetType, turnTarget } from "./labels.ts";
import { TASK_CLASSES } from "./types.ts";

export type View = "sessions" | "nodes" | "replays";
const VIEWS: View[] = ["sessions", "nodes", "replays"];
const CLASS_KEYS = "abcdefghijk";

export interface ListItem {
	type: TargetType;
	id: string;
	title: string;
	sub: string;
}

export interface TurnView {
	uid: string;
	role: string;
	head: string;
	text: string;
}

export interface Input {
	prompt: string;
	value: string;
	commit: (value: string) => void;
}

export interface State {
	view: View;
	items: ListItem[];
	cursor: number;
	focus: "list" | "turns";
	turns: TurnView[];
	turnCursor: number;
	detailScroll: number;
	filter: string;
	unlabeledOnly: boolean;
	mode: "normal" | "class" | "input";
	input: Input | null;
	message: string;
	quit: boolean;
	editRequest: { initial: string; commit: (v: string) => void } | null;
}

const sanitize = (s: string) => s.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]|\x1b\[[0-9;]*[A-Za-z]/g, "");
const oneLine = (s: string) => sanitize(s).replace(/\s+/g, " ").trim();
const shortTs = (ts: string | null) => (ts ? ts.slice(5, 16).replace("T", " ") : "--");

function listItems(db: Database, s: State): ListItem[] {
	const like = s.filter ? `%${s.filter}%` : null;
	if (s.view === "sessions") {
		const rows = db
			.query(
				`SELECT s.id, s.source, s.title, s.first_user, s.started_at, s.main_model, s.n_user, s.n_corrections, s.n_tool_errors, s.n_tool_calls,
           l.rating, l.task_class FROM sessions s LEFT JOIN labels l ON l.target_type = 'session' AND l.target_id = s.id
         WHERE s.n_assistant > 0 AND (?1 IS NULL OR s.title LIKE ?1 OR s.first_user LIKE ?1 OR s.cwd LIKE ?1 OR s.main_model LIKE ?1)
           AND (?2 = 0 OR (l.rating IS NULL AND l.task_class IS NULL))
         ORDER BY s.started_at DESC LIMIT 2000`,
			)
			.all(like, s.unlabeledOnly ? 1 : 0) as Record<string, string | number | null>[];
		return rows.map((r) => ({
			type: "session",
			id: String(r.id),
			title: `${mark(r.rating as string | null)} ${shortTs(r.started_at as string | null)} ${oneLine(String(r.title ?? r.first_user ?? r.id))}`,
			sub: `${r.source} ${r.main_model ?? "?"} ${r.task_class ?? ""} u${r.n_user} c${r.n_corrections} e${r.n_tool_errors}/${r.n_tool_calls}`,
		}));
	}
	if (s.view === "nodes") {
		const rows = db
			.query(
				`SELECT o.run, o.node, MAX(o.attempt) AS attempts, MAX(o.ts) AS ts, MAX(o.task) AS task,
           (SELECT verdict FROM outcomes x WHERE x.run = o.run AND x.node = o.node ORDER BY x.attempt DESC, x.ts DESC LIMIT 1) AS verdict,
           (SELECT model_key FROM outcomes x WHERE x.run = o.run AND x.node = o.node ORDER BY x.attempt DESC, x.ts DESC LIMIT 1) AS model_key,
           l.rating, l.task_class
         FROM outcomes o LEFT JOIN labels l ON l.target_type = 'node' AND l.target_id = o.run || '/' || o.node
         WHERE (?1 IS NULL OR o.task LIKE ?1 OR o.node LIKE ?1 OR o.run LIKE ?1) AND (?2 = 0 OR (l.rating IS NULL AND l.task_class IS NULL))
         GROUP BY o.run, o.node ORDER BY ts DESC LIMIT 2000`,
			)
			.all(like, s.unlabeledOnly ? 1 : 0) as Record<string, string | number | null>[];
		return rows.map((r) => ({
			type: "node",
			id: nodeTarget(String(r.run), String(r.node)),
			title: `${mark(r.rating as string | null)} ${shortTs(r.ts as string)} ${r.node}: ${oneLine(String(r.task ?? ""))}`,
			sub: `${r.verdict} x${r.attempts} ${r.model_key} ${r.task_class ?? ""}`,
		}));
	}
	const rows = db
		.query(
			`SELECT r.id, r.group_id, r.model, r.status, r.source_id, r.diff_stat, r.created_at, l.rating FROM replays r
       LEFT JOIN labels l ON l.target_type = 'replay' AND l.target_id = r.id
       WHERE (?1 IS NULL OR r.task LIKE ?1 OR r.model LIKE ?1 OR r.source_id LIKE ?1) AND (?2 = 0 OR l.rating IS NULL)
       ORDER BY r.created_at DESC, r.id LIMIT 2000`,
		)
		.all(like, s.unlabeledOnly ? 1 : 0) as Record<string, string | number | null>[];
	return rows.map((r) => ({
		type: "replay",
		id: String(r.id),
		title: `${mark(r.rating as string | null)} ${shortTs(r.created_at as string)} ${r.model} [${r.status}]`,
		sub: `${r.group_id} ${r.source_id} ${oneLine(String(r.diff_stat ?? ""))}`,
	}));
}

function mark(rating: string | null): string {
	return rating === "good" ? "+" : rating === "bad" ? "-" : rating === "neutral" ? "=" : " ";
}

function loadTurns(db: Database, sessionId: string): TurnView[] {
	const rows = db
		.query("SELECT uid, role, ts, model, thinking, text, tool_calls, tool_name, is_error, injected, is_correction, is_interruption, is_retry FROM turns WHERE session_id = ? ORDER BY seq")
		.all(sessionId) as Record<string, string | number | null>[];
	return rows.map((r) => {
		const label = getLabel(db, "turn", turnTarget(sessionId, String(r.uid)));
		const flags = [r.is_error ? "ERR" : "", r.is_correction ? "CORRECTION" : "", r.is_interruption ? "INTERRUPTED" : "", r.is_retry ? "retry" : "", r.injected ? "injected" : ""].filter(Boolean);
		let calls = "";
		if (r.tool_calls) {
			try {
				calls = (JSON.parse(String(r.tool_calls)) as { name: string; args: unknown }[]).map((c) => `> ${c.name} ${oneLine(JSON.stringify(c.args ?? "")).slice(0, 300)}`).join("\n");
			} catch {
				calls = "> (tool calls truncated)";
			}
		}
		const who = r.role === "assistant" ? `A ${r.model ?? ""}${r.thinking ? `:${r.thinking}` : ""}` : r.role === "tool" ? `T ${r.tool_name ?? ""}` : "U";
		const extra = label ? ` [${label.rating ?? ""}${label.notes ? " note" : ""}${label.preferred ? " preferred" : ""}]` : "";
		return {
			uid: String(r.uid),
			role: String(r.role),
			head: `${mark(label?.rating ?? null)} ${shortTs(r.ts as string | null)} ${who}${flags.length ? ` {${flags.join(",")}}` : ""}${extra}`,
			text: [sanitize(String(r.text ?? "")), calls].filter(Boolean).join("\n"),
		};
	});
}

export function createState(db: Database, view: View = "sessions"): State {
	const s: State = {
		view,
		items: [],
		cursor: 0,
		focus: "list",
		turns: [],
		turnCursor: 0,
		detailScroll: 0,
		filter: "",
		unlabeledOnly: false,
		mode: "normal",
		input: null,
		message: "? for keys",
		quit: false,
		editRequest: null,
	};
	refresh(db, s);
	return s;
}

export function refresh(db: Database, s: State): void {
	const keep = s.items[s.cursor]?.id;
	s.items = listItems(db, s);
	const idx = keep ? s.items.findIndex((i) => i.id === keep) : -1;
	s.cursor = idx >= 0 ? idx : Math.min(s.cursor, Math.max(0, s.items.length - 1));
	if (s.focus === "turns" && s.items[s.cursor]?.type === "session") s.turns = loadTurns(db, s.items[s.cursor].id);
}

function target(s: State): { type: TargetType; id: string } | null {
	const item = s.items[s.cursor];
	if (!item) return null;
	if (s.focus === "turns" && item.type === "session") {
		const t = s.turns[s.turnCursor];
		return t ? { type: "turn", id: turnTarget(item.id, t.uid) } : null;
	}
	return { type: item.type, id: item.id };
}

const HELP =
	"j/k move  Enter turns  h back  Tab view  g/b/n good/bad/neutral  x clear  c class  a accept suggestion  e note  p preferred (bad turn)  / filter  u unlabeled  J/K scroll  q quit";

export function handleKey(db: Database, s: State, key: string): void {
	if (s.mode === "input" && s.input) {
		if (key === "enter") {
			const inp = s.input;
			s.mode = "normal";
			s.input = null;
			inp.commit(inp.value);
		} else if (key === "esc" || key === "ctrl-c") {
			s.mode = "normal";
			s.input = null;
			s.message = "cancelled";
		} else if (key === "backspace") s.input.value = s.input.value.slice(0, -1);
		else if (key === "ctrl-u") s.input.value = "";
		else if (key.length >= 1 && !["up", "down", "pgup", "pgdn", "tab", "left", "right"].includes(key)) s.input.value += key;
		return;
	}
	if (s.mode === "class") {
		s.mode = "normal";
		const i = CLASS_KEYS.indexOf(key);
		const t = target(s);
		if (i >= 0 && i < TASK_CLASSES.length && t && t.type !== "turn") {
			setLabel(db, t.type, t.id, { task_class: TASK_CLASSES[i] });
			s.message = `class ${TASK_CLASSES[i]}`;
			refresh(db, s);
		} else s.message = t?.type === "turn" ? "classes apply to sessions and nodes" : "cancelled";
		return;
	}
	const count = s.focus === "turns" ? s.turns.length : s.items.length;
	const move = (d: number) => {
		if (s.focus === "turns") s.turnCursor = Math.max(0, Math.min(count - 1, s.turnCursor + d));
		else {
			s.cursor = Math.max(0, Math.min(count - 1, s.cursor + d));
			s.detailScroll = 0;
		}
	};
	const rate = (rating: string | null) => {
		const t = target(s);
		if (!t) return;
		if (t.type === "turn" && s.turns[s.turnCursor]?.role !== "assistant") {
			s.message = "only assistant turns are rated";
			return;
		}
		setLabel(db, t.type, t.id, { rating });
		s.message = `${t.type} ${rating ?? "cleared"}`;
		refresh(db, s);
	};
	switch (key) {
		case "q":
		case "ctrl-c":
			s.quit = true;
			break;
		case "j":
		case "down":
			move(1);
			break;
		case "k":
		case "up":
			move(-1);
			break;
		case "pgdn":
			move(10);
			break;
		case "pgup":
			move(-10);
			break;
		case "J":
			s.detailScroll += 5;
			break;
		case "K":
			s.detailScroll = Math.max(0, s.detailScroll - 5);
			break;
		case "tab":
			s.view = VIEWS[(VIEWS.indexOf(s.view) + 1) % VIEWS.length];
			s.focus = "list";
			s.cursor = 0;
			s.detailScroll = 0;
			refresh(db, s);
			s.message = `view: ${s.view}`;
			break;
		case "enter":
		case "l":
			if (s.items[s.cursor]?.type === "session") {
				s.focus = "turns";
				s.turns = loadTurns(db, s.items[s.cursor].id);
				s.turnCursor = Math.max(0, s.turns.findIndex((t) => t.role === "assistant"));
				s.detailScroll = 0;
			}
			break;
		case "h":
		case "esc":
			s.focus = "list";
			s.detailScroll = 0;
			break;
		case "g":
			rate("good");
			break;
		case "b":
			rate("bad");
			break;
		case "n":
			rate("neutral");
			break;
		case "x":
			rate(null);
			break;
		case "c":
			if (target(s)) {
				s.mode = "class";
				s.message = TASK_CLASSES.map((c, i) => `${CLASS_KEYS[i]}:${c}`).join(" ");
			}
			break;
		case "a": {
			const t = target(s);
			if (!t || t.type === "turn") break;
			const sug = bestSuggestion(db, t.type, t.id);
			if (sug) {
				setLabel(db, t.type, t.id, { task_class: sug.task_class });
				s.message = `accepted ${sug.source} class ${sug.task_class}`;
				refresh(db, s);
			} else s.message = "no suggestion; run aeval classify";
			break;
		}
		case "e": {
			const t = target(s);
			if (!t) break;
			s.mode = "input";
			s.input = {
				prompt: "note: ",
				value: getLabel(db, t.type, t.id)?.notes ?? "",
				commit: (v) => {
					setLabel(db, t.type, t.id, { notes: v.trim() || null });
					s.message = "note saved";
					refresh(db, s);
				},
			};
			break;
		}
		case "p": {
			const t = target(s);
			if (!t || t.type !== "turn" || s.turns[s.turnCursor]?.role !== "assistant") {
				s.message = "preferred alternatives attach to assistant turns (Enter a session first)";
				break;
			}
			const cur = getLabel(db, t.type, t.id);
			s.editRequest = {
				initial: cur?.preferred ?? s.turns[s.turnCursor].text,
				commit: (v) => {
					const trimmed = v.trim();
					setLabel(db, t.type, t.id, { preferred: trimmed || null, rating: trimmed ? "bad" : (cur?.rating ?? null) });
					s.message = trimmed ? "preferred alternative saved (turn marked bad)" : "preferred alternative cleared";
					refresh(db, s);
				},
			};
			break;
		}
		case "/":
			s.mode = "input";
			s.input = {
				prompt: "filter: ",
				value: s.filter,
				commit: (v) => {
					s.filter = v.trim();
					s.cursor = 0;
					refresh(db, s);
				},
			};
			break;
		case "u":
			s.unlabeledOnly = !s.unlabeledOnly;
			s.cursor = 0;
			refresh(db, s);
			s.message = s.unlabeledOnly ? "unlabeled only" : "all items";
			break;
		case "r":
			refresh(db, s);
			s.message = "refreshed";
			break;
		case "?":
			s.message = HELP;
			break;
	}
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		if (!line) out.push("");
		while (line.length > 0) {
			out.push(line.slice(0, width));
			line = line.slice(width);
		}
	}
	return out;
}

function detailLines(db: Database, s: State, width: number): string[] {
	const item = s.items[s.cursor];
	if (!item) return ["(nothing here: run aeval ingest, or press u / clear the filter)"];
	const label = getLabel(db, item.type, item.id);
	const sug = item.type === "replay" ? null : bestSuggestion(db, item.type, item.id);
	const lines: string[] = [];
	const labelLine = `label: ${label?.rating ?? "-"} class: ${label?.task_class ?? "-"}${sug ? `  suggested: ${sug.task_class} (${sug.source} ${sug.confidence ?? ""})` : ""}`;
	if (item.type === "session") {
		const r = db.query("SELECT * FROM sessions WHERE id = ?").get(item.id) as Record<string, string | number | null>;
		lines.push(
			`${r.source} ${r.id}`,
			`cwd: ${r.cwd ?? "-"}  model: ${r.main_provider ?? ""}/${r.main_model ?? "?"}:${r.thinking ?? ""}`,
			`turns: user ${r.n_user} assistant ${r.n_assistant} tools ${r.n_tool_calls} (errors ${r.n_tool_errors}) corrections ${r.n_corrections} retries ${r.n_retries} interrupts ${r.n_interruptions}`,
			`tokens in ${r.tokens_in} cache ${r.tokens_cache_read} out ${r.tokens_out}  active ${Math.round(Number(r.active_ms ?? 0) / 60000)}m`,
			labelLine,
		);
		if (label?.notes) lines.push(`note: ${label.notes}`);
		lines.push("─".repeat(width));
		if (s.focus === "turns") {
			s.turns.forEach((t, i) => {
				const sel = i === s.turnCursor;
				lines.push(`${sel ? "▶" : " "}${t.head}`);
				if (sel) {
					const tl = getLabel(db, "turn", turnTarget(item.id, t.uid));
					for (const w of wrap(t.text, width - 2)) lines.push(`  ${w}`);
					if (tl?.notes) lines.push(`  note: ${tl.notes}`);
					if (tl?.preferred) for (const w of wrap(`preferred: ${tl.preferred}`, width - 2)) lines.push(`  ${w}`);
				} else lines.push(`   ${oneLine(t.text).slice(0, width - 4)}`);
			});
		} else for (const w of wrap(`first message: ${r.first_user ?? ""}`, width)) lines.push(w);
	} else if (item.type === "node") {
		const [runId, node] = [item.id.slice(0, item.id.lastIndexOf("/")), item.id.slice(item.id.lastIndexOf("/") + 1)];
		const rows = db.query("SELECT * FROM outcomes WHERE run = ? AND node = ? ORDER BY attempt, ts").all(runId, node) as Record<string, string | number | null>[];
		lines.push(`run ${runId} node ${node} (${rows[0]?.kind ?? "work"})`, labelLine);
		if (label?.notes) lines.push(`note: ${label.notes}`);
		lines.push("─".repeat(width));
		for (const r of rows) lines.push(`#${r.attempt} ${r.verdict} ${r.model_key} ${r.model_ref ?? ""}:${r.thinking ?? ""} ${Math.round(Number(r.duration_ms) / 1000)}s ${oneLine(String(r.pick_note ?? ""))}`);
		lines.push("");
		for (const w of wrap(String(rows[0]?.task ?? ""), width)) lines.push(w);
		const criteria = JSON.parse(String(rows[0]?.criteria ?? "[]")) as string[];
		for (const c of criteria) for (const w of wrap(`- ${c}`, width)) lines.push(w);
	} else {
		const r = db.query("SELECT * FROM replays WHERE id = ?").get(item.id) as Record<string, string | number | null>;
		const peers = db.query("SELECT model, status, duration_ms, diff_stat FROM replays WHERE group_id = ? ORDER BY id").all(r.group_id) as Record<string, string | number | null>[];
		lines.push(`replay ${r.id} of ${r.source_type} ${r.source_id}`, `base ${String(r.base_rev).slice(0, 12)} ${r.placement}  dir ${r.dir}`, labelLine);
		for (const p of peers) lines.push(`  ${p.model === r.model ? "▶" : " "} ${p.model} ${p.status} ${Math.round(Number(p.duration_ms) / 1000)}s ${p.diff_stat ?? ""}`);
		lines.push("─".repeat(width), "final answer:");
		for (const w of wrap(String(r.final_text ?? ""), width)) lines.push(w);
		const diffPath = join(String(r.dir), "diff.patch");
		if (existsSync(diffPath)) {
			lines.push("─".repeat(width), "diff:");
			for (const w of wrap(readFileSync(diffPath, "utf8").slice(0, 200_000), width)) lines.push(w);
		}
	}
	return lines;
}

const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));

export function render(db: Database, s: State, width: number, height: number): string[] {
	const leftW = Math.max(24, Math.min(64, Math.floor(width * 0.38)));
	const rightW = Math.max(10, width - leftW - 1);
	const bodyH = Math.max(3, height - 3);
	const header = pad(
		` aeval label · ${s.view} (${s.items.length})${s.filter ? ` · filter "${s.filter}"` : ""}${s.unlabeledOnly ? " · unlabeled" : ""} · ${s.focus === "turns" ? "turns" : "list"}`,
		width,
	);
	const rowsPerItem = 2;
	const visibleItems = Math.floor(bodyH / rowsPerItem);
	const top = Math.max(0, Math.min(s.cursor - Math.floor(visibleItems / 2), s.items.length - visibleItems));
	const left: { text: string; sel: boolean }[] = [];
	for (let i = top; i < s.items.length && left.length < bodyH; i++) {
		const it = s.items[i];
		const sel = i === s.cursor;
		left.push({ text: pad(`${sel ? "▶" : " "}${it.title}`, leftW), sel });
		left.push({ text: pad(`   ${it.sub}`, leftW), sel });
	}
	const detail = detailLines(db, s, rightW);
	let start = s.detailScroll;
	if (s.focus === "turns") {
		const at = detail.findIndex((l) => l.startsWith("▶"));
		if (at >= 0) start = Math.max(0, at - 3) + s.detailScroll;
	}
	start = Math.min(start, Math.max(0, detail.length - 1));
	const out = [`\x1b[7m${header}\x1b[0m`];
	for (let row = 0; row < bodyH; row++) {
		const l = left[row];
		const lt = l ? (l.sel ? `\x1b[7m${l.text}\x1b[0m` : l.text) : " ".repeat(leftW);
		const dt = pad(detail[start + row] ?? "", rightW);
		out.push(`${lt}│${dt}`);
	}
	const status = s.mode === "input" && s.input ? `${s.input.prompt}${s.input.value}█` : s.message;
	out.push(pad(oneLine(status), width));
	out.push(`\x1b[2m${pad(s.mode === "class" ? "pick a class letter, Esc to cancel" : HELP, width)}\x1b[0m`);
	return out;
}

export function decodeKeys(chunk: string): string[] {
	const map: Record<string, string> = {
		"\x1b[A": "up",
		"\x1b[B": "down",
		"\x1b[C": "right",
		"\x1b[D": "left",
		"\x1b[5~": "pgup",
		"\x1b[6~": "pgdn",
		"\x1bOA": "up",
		"\x1bOB": "down",
	};
	if (map[chunk]) return [map[chunk]];
	const keys: string[] = [];
	for (const ch of chunk) {
		if (ch === "\r" || ch === "\n") keys.push("enter");
		else if (ch === "\x7f" || ch === "\b") keys.push("backspace");
		else if (ch === "\x1b") keys.push("esc");
		else if (ch === "\t") keys.push("tab");
		else if (ch === "\x03") keys.push("ctrl-c");
		else if (ch === "\x15") keys.push("ctrl-u");
		else if (ch >= " ") keys.push(ch);
	}
	return keys;
}

function editExternally(initial: string): string | null {
	const editor = process.env.VISUAL || process.env.EDITOR || "vi";
	const dir = mkdtempSync(join(tmpdir(), "aeval-"));
	const file = join(dir, "preferred.md");
	writeFileSync(file, `${initial}\n`, { mode: 0o600 });
	try {
		const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
		return r.status === 0 ? readFileSync(file, "utf8") : null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function runLabelUi(db: Database, view: View = "sessions"): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("aeval label needs an interactive terminal");
	const s = createState(db, view);
	const enter = () => {
		process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
		process.stdin.setRawMode(true);
		process.stdin.resume();
	};
	const leave = () => {
		process.stdin.setRawMode(false);
		process.stdout.write("\x1b[?25h\x1b[?1049l");
	};
	const draw = () => {
		const lines = render(db, s, process.stdout.columns || 100, process.stdout.rows || 30);
		process.stdout.write(`\x1b[H${lines.join("\r\n")}`);
	};
	enter();
	draw();
	await new Promise<void>((done) => {
		const onResize = () => {
			process.stdout.write("\x1b[2J");
			draw();
		};
		const onData = (buf: Buffer) => {
			const chunk = buf.toString("utf8");
			const keys = s.mode === "input" && !chunk.startsWith("\x1b") && chunk.length > 1 && !/[\r\n\x7f\x03\x15]/.test(chunk) ? [chunk] : decodeKeys(chunk);
			for (const k of keys) {
				handleKey(db, s, k);
				if (s.editRequest) {
					const req = s.editRequest;
					s.editRequest = null;
					leave();
					process.stdin.pause();
					const v = editExternally(req.initial);
					enter();
					if (v !== null) req.commit(v);
					else s.message = "editor exited with an error; nothing saved";
				}
				if (s.quit) break;
			}
			if (s.quit) {
				process.stdin.off("data", onData);
				process.stdout.off("resize", onResize);
				leave();
				process.stdin.pause();
				done();
				return;
			}
			draw();
		};
		process.stdin.on("data", onData);
		process.stdout.on("resize", onResize);
	});
}
