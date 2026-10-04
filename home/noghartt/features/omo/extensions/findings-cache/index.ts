import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const AGENTS = new Set(["explore", "librarian"]);
// Below this a result is a one-line answer, cheaper to recompute than to list in every prompt.
const MIN_BODY_CHARS = 300;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LISTED = 30;
const WAKE_TYPE = "omo-senpi:wake";
const COMPLETION_TYPE = "senpi-task.completion";

type Rec = Record<string, unknown>;
type Finding = { file: string; agent: string; title: string; created: number; sections: string; mtime: number };

const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function titleOf(input: Rec): string {
	const raw = str(input.description) ?? str(input.task_summary) ?? str(input.name) ?? str(input.prompt) ?? "untitled";
	return raw.split("\n")[0].slice(0, 100);
}

function sectionsOf(body: string): string[] {
	const headings = [...body.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) => m[1]);
	// explore answers use XML-ish blocks (<files>, <answer>) instead of markdown headings.
	const found = headings.length ? headings : [...body.matchAll(/^\s*<([a-z][\w-]*)>/gm)].map((m) => m[1]);
	return [...new Set(found)];
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "finding"
	);
}

function age(ms: number): string {
	const hours = Math.max(0, Math.floor(ms / 3_600_000));
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function frontmatter(text: string): Rec {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	const out: Rec = {};
	for (const line of match?.[1].split("\n") ?? []) {
		const at = line.indexOf(":");
		if (at < 0) continue;
		const value = line.slice(at + 1).trim();
		try {
			out[line.slice(0, at).trim()] = value.startsWith('"') ? JSON.parse(value) : value;
		} catch {
			out[line.slice(0, at).trim()] = value;
		}
	}
	return out;
}

export async function buildIndex(dir: string, now: number, prune: boolean): Promise<Finding[]> {
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
	} catch {
		return [];
	}
	const findings: Finding[] = [];
	for (const name of names) {
		const file = join(dir, name);
		try {
			const { mtimeMs } = await stat(file);
			if (now - mtimeMs > MAX_AGE_MS) {
				if (prune) await rm(file, { force: true });
				continue;
			}
			const text = await readFile(file, "utf8");
			const meta = frontmatter(text);
			const created = Date.parse(String(meta.created ?? "")) || mtimeMs;
			const sections = /^Sections: (.*)$/m.exec(text)?.[1] ?? "";
			findings.push({
				file: name,
				agent: String(meta.agent ?? "?"),
				title: String(meta.title ?? name),
				created,
				sections,
				mtime: mtimeMs,
			});
		} catch {}
	}
	return findings.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_LISTED);
}

export function renderIndex(dir: string, findings: Finding[], now: number): string {
	if (!findings.length) return "";
	const lines = findings.map((f) => {
		const sections = f.sections ? ` - sections: ${f.sections}` : "";
		return `- \`${f.file}\` - ${f.agent}, ${age(now - f.created)} old, ${JSON.stringify(f.title)}${sections}`;
	});
	return [
		"## Cached research",
		"",
		`Earlier explore/librarian results for this repository, shared by all of its worktrees, live in \`${dir}\`. Read a relevant file before delegating the same research again. Treat them as leads, not facts:`,
		"- Line numbers rot first: re-locate code by symbol name before relying on a location.",
		"- The working tree wins whenever it disagrees with a finding.",
		"- Each file records the `commit` it was written at; `git diff --stat <commit>..HEAD -- <paths>` shows how far those paths drifted since.",
		"- Delete a finding the moment it proves wrong or superseded, so later sessions do not inherit it.",
		"",
		...lines,
	].join("\n");
}

export default function findingsCache(pi: ExtensionAPI) {
	let dirPromise: Promise<string | undefined> = Promise.resolve(undefined);
	let cursor = 0;
	let snapshot: Promise<string> | undefined;
	let pruned = false;
	const handledWakes = new Set<string>();
	const titles = new Map<string, string>();

	const git = async (args: string[], cwd: string): Promise<string | undefined> => {
		const result = await pi.exec("git", args, { cwd });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const resolveDir = async (cwd: string): Promise<string | undefined> => {
		// The common dir is shared by every linked worktree, which is the whole point of the cache.
		const common = await git(["rev-parse", "--git-common-dir"], cwd);
		return common ? join(resolve(cwd, common), "omo-findings") : undefined;
	};

	const capture = async (ctx: ExtensionContext, agent: string, taskId: string, title: string, body: string) => {
		const dir = await dirPromise;
		const text = body.trim();
		if (!dir || !AGENTS.has(agent) || text.length < MIN_BODY_CHARS) return;
		const [commit, branch] = await Promise.all([
			git(["rev-parse", "HEAD"], ctx.cwd),
			git(["branch", "--show-current"], ctx.cwd),
		]);
		const sections = sectionsOf(text);
		const doc = [
			"---",
			`agent: ${agent}`,
			`created: ${new Date().toISOString()}`,
			`commit: ${commit ?? "unknown"}`,
			`branch: ${branch || "detached"}`,
			`title: ${JSON.stringify(title)}`,
			`task: ${taskId}`,
			"---",
			`Sections: ${sections.join(", ") || "none"}`,
			"",
			text,
			"",
		].join("\n");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${agent}-${slug(title)}-${taskId.replace(/[^\w-]/g, "")}.md`), doc);
	};

	// Background completions do not repeat the task title, so recover it from the spawning call.
	const titleFor = (ctx: ExtensionContext, taskId: string): string => {
		const known = titles.get(taskId);
		if (known) return known;
		const calls = new Map<string, Rec>();
		for (const entry of ctx.sessionManager.getEntries() as unknown[]) {
			if (!isRec(entry) || entry.type !== "message" || !isRec(entry.message)) continue;
			const message = entry.message;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (isRec(part) && part.type === "toolCall" && part.name === "task" && isRec(part.arguments)) {
						calls.set(String(part.id), part.arguments);
					}
				}
			} else if (message.role === "toolResult" && message.toolName === "task") {
				const input = calls.get(String(message.toolCallId));
				if (input) remember(input, message.details);
			}
		}
		return titles.get(taskId) ?? taskId;
	};

	const remember = (input: Rec, details: unknown) => {
		if (!isRec(details)) return;
		if (Array.isArray(details.items)) {
			const tasks = Array.isArray(input.tasks) ? input.tasks : [];
			details.items.forEach((item, i) => {
				if (isRec(item) && str(item.task_id)) titles.set(String(item.task_id), titleOf(isRec(tasks[i]) ? tasks[i] : item));
			});
		} else if (str(details.task_id)) {
			titles.set(String(details.task_id), titleOf(input));
		}
	};

	const scanWakes = async (ctx: ExtensionContext) => {
		const entries = ctx.sessionManager.getEntries() as unknown[];
		if (cursor > entries.length) cursor = 0;
		const fresh = entries.slice(cursor);
		cursor = entries.length;
		for (const entry of fresh) {
			if (!isRec(entry) || entry.customType !== WAKE_TYPE || handledWakes.has(String(entry.id))) continue;
			handledWakes.add(String(entry.id));
			for (const group of Array.isArray(entry.details) ? entry.details : []) {
				if (!isRec(group) || group.customType !== COMPLETION_TYPE || !Array.isArray(group.details)) continue;
				for (const done of group.details) {
					if (!isRec(done) || done.status !== "completed") continue;
					const taskId = str(done.task_id) ?? str(done.name);
					const agent = str(done.agent_type);
					const body = str(done.final_response);
					if (taskId && agent && body) await capture(ctx, agent, taskId, titleFor(ctx, taskId), body);
				}
			}
		}
	};

	// Capture and injection are conveniences: a failure must never surface in the host session.
	const quiet =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R | undefined> => {
			try {
				return await fn(...args);
			} catch {
				return undefined;
			}
		};

	pi.on(
		"session_start",
		quiet(async (_event, ctx) => {
			snapshot = undefined;
			pruned = false;
			handledWakes.clear();
			titles.clear();
			// Completions already in the session were captured (or deliberately deleted) earlier.
			cursor = ctx.sessionManager.getEntries().length;
			dirPromise = resolveDir(ctx.cwd).catch(() => undefined);
		}),
	);

	pi.on(
		"tool_result",
		quiet(async (event, ctx) => {
			const input = isRec(event.input) ? event.input : {};
			if (event.toolName === "read") {
				const dir = await dirPromise;
				const path = str(input.path) ?? str(input.file_path);
				if (!dir || !path) return;
				const file = resolve(ctx.cwd, path);
				const rel = relative(dir, file);
				// Reading a finding is what keeps it alive under the mtime-based LRU.
				if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
					const now = new Date();
					await utimes(file, now, now);
				}
				return;
			}
			if (event.toolName !== "task" || event.isError) return;
			remember(input, event.details);
			// Foreground runs finish inside the tool call; background ones arrive later as wakes.
			const details = isRec(event.details) ? event.details : {};
			const records = Array.isArray(details.items) ? details.items : [details];
			const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
			// A single foreground run carries its answer only in the content, plus a continuation footer.
			const content = Array.isArray(event.content) ? event.content : [];
			const text = content
				.map((part: unknown) => (isRec(part) && part.type === "text" ? String(part.text ?? "") : ""))
				.join("\n")
				.replace(/\n*\[task_id: [^\]]*\]\s*$/, "");
			for (const [i, record] of records.entries()) {
				if (!isRec(record) || record.status !== "completed") continue;
				const spec = isRec(tasks[i]) ? tasks[i] : input;
				const agent = str(record.subagent_type) ?? str(record.agent_type) ?? str(spec.subagent_type);
				const taskId = str(record.task_id);
				const body = str(record.final_response) ?? str(record.result) ?? (details.items ? undefined : str(text));
				if (agent && taskId && body) await capture(ctx, agent, taskId, titleOf(spec), body);
			}
		}),
	);

	const scan = quiet(async (_event: unknown, ctx: ExtensionContext) => scanWakes(ctx));
	pi.on("turn_end", scan);
	pi.on("agent_end", scan);

	pi.on(
		"before_agent_start",
		quiet(async (event, ctx) => {
			if (!event.preview) await scanWakes(ctx);
			const dir = await dirPromise;
			if (!dir) return;
			const now = Date.now();
			if (!event.preview && !pruned) {
				pruned = true;
				await buildIndex(dir, now, true);
			}
			// Frozen per session: a listing that changed every turn would bust the prompt cache, and
			// findings captured during this session are already in its own context.
			snapshot ??= buildIndex(dir, now, false).then((findings) => renderIndex(dir, findings, now));
			const section = await snapshot;
			return section ? { systemPrompt: `${event.systemPrompt}\n\n${section}` } : undefined;
		}),
		{ previewSafe: true },
	);
}
