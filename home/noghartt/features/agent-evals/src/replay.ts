import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nowIso } from "./db.ts";
import { parsePiSession } from "./parsers/pi.ts";
import { stateDir } from "./paths.ts";
import { redact } from "./redact.ts";

export interface ReplayTask {
	sourceType: "node" | "session";
	sourceId: string;
	task: string;
	repo: string;
	before: string | null;
}

export interface ReplayOptions {
	models: string[];
	harness: "omo" | "pi";
	base?: string;
	repo?: string;
	sandbox?: boolean;
	net?: string;
	size?: string;
	timeoutMs?: number;
	dryRun?: boolean;
	log?: (line: string) => void;
}

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Run {
	const r = spawnSync(cmd, args, {
		cwd: opts.cwd,
		encoding: "utf8",
		timeout: opts.timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ...opts.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
}

function must(cmd: string, args: string[], cwd?: string): string {
	const r = run(cmd, args, { cwd });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.status}`}`);
	return r.stdout.trim();
}

export function resolveTask(db: Database, ref: { node?: string; session?: string }): ReplayTask {
	if (ref.node) {
		const slash = ref.node.lastIndexOf("/");
		if (slash <= 0) throw new Error("--node expects RUN/NODE");
		const runId = ref.node.slice(0, slash);
		const node = ref.node.slice(slash + 1);
		const rows = db.query("SELECT task, criteria, repo, ts, duration_ms FROM outcomes WHERE run = ? AND node = ? ORDER BY attempt, ts").all(runId, node) as {
			task: string;
			criteria: string;
			repo: string | null;
			ts: string;
			duration_ms: number;
		}[];
		if (!rows.length) throw new Error(`no outcome for ${ref.node}`);
		const criteria = JSON.parse(rows[0].criteria || "[]") as string[];
		const task = criteria.length ? `${rows[0].task}\n\nAcceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}` : rows[0].task;
		const started = Date.parse(rows[0].ts) - (rows[0].duration_ms || 0);
		return { sourceType: "node", sourceId: ref.node, task, repo: rows[0].repo ?? "", before: Number.isFinite(started) ? new Date(started).toISOString() : null };
	}
	if (ref.session) {
		const s = db.query("SELECT id, cwd, first_user, started_at FROM sessions WHERE id = ? OR id LIKE ? LIMIT 2").all(ref.session, `%${ref.session}%`) as {
			id: string;
			cwd: string | null;
			first_user: string | null;
			started_at: string | null;
		}[];
		if (s.length !== 1) throw new Error(s.length ? `session ${ref.session} is ambiguous` : `no session ${ref.session}`);
		if (!s[0].first_user) throw new Error(`session ${s[0].id} has no user message`);
		return { sourceType: "session", sourceId: s[0].id, task: s[0].first_user.replace(/^\[orchestrator\] /, ""), repo: s[0].cwd ?? "", before: s[0].started_at };
	}
	throw new Error("replay needs --node RUN/NODE or --session ID");
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

function lastAssistantText(sessionsDir: string): { text: string | null; path: string | null } {
	if (!existsSync(sessionsDir)) return { text: null, path: null };
	const files: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) files.push(p);
		}
	};
	walk(sessionsDir);
	const path = files.sort().at(-1) ?? null;
	if (!path) return { text: null, path: null };
	const parsed = parsePiSession(readFileSync(path, "utf8"), path, "omo");
	if ("skip" in parsed) return { text: null, path };
	const last = parsed.session.turns.findLast((t) => t.role === "assistant" && t.text.trim());
	return { text: last ? redact(last.text).slice(0, 20_000) : null, path };
}

const NO_PUSH_HOOK = "#!/bin/sh\necho 'aeval replay: pushing from a replay checkout is disabled' >&2\nexit 1\n";

export const REPLAY_PREAMBLE =
	"[aeval replay] You are re-running a recorded task in a disposable checkout to compare models. Work only inside this checkout; do not push, publish, or open pull requests.\n\n";

/**
 * Each candidate gets its own clone of the task's repository at the task's base commit,
 * with no remotes and a refusing pre-push hook: the user's checkout is only read, and
 * nothing a candidate does can reach a remote. Sandbox mode seeds an agentbox sandbox
 * from that clone instead and runs the harness's tools inside it (OmO cloud mode).
 */
export function replay(db: Database, task: ReplayTask, opts: ReplayOptions): string {
	const log = opts.log ?? (() => {});
	if (opts.sandbox && opts.harness !== "omo") throw new Error("--sandbox runs tools through OmO cloud mode; use --harness omo");
	const recorded = opts.repo ?? task.repo;
	if (!recorded) throw new Error("repository not found: none recorded for this task; pass --repo");
	const repoPath = resolve(recorded);
	if (!existsSync(repoPath)) throw new Error(`repository not found: ${repoPath}`);
	const top = must("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
	const base =
		opts.base ??
		((task.before ? run("git", ["-C", top, "rev-list", "-1", `--before=${task.before}`, "HEAD"]).stdout.trim() : "") || must("git", ["-C", top, "rev-parse", "HEAD"]));
	if (opts.sandbox && run("agentbox", ["ls"]).status !== 0) throw new Error("--sandbox needs a working agentbox on this host");

	const group = `rp-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
	const groupDir = join(stateDir(), "replays", group);
	log(`replay ${group}: ${task.sourceType} ${task.sourceId} at ${base.slice(0, 12)} in ${top}`);
	if (opts.dryRun) {
		for (const m of opts.models) log(`  would run ${opts.harness} -p --model ${m}${opts.sandbox ? " (sandbox)" : ""}`);
		return group;
	}
	mkdirSync(groupDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(groupDir, "task.md"), `${task.task}\n`, { mode: 0o600 });

	opts.models.forEach((spec, i) => {
		const [model, thinking] = spec.includes(":") ? [spec.slice(0, spec.lastIndexOf(":")), spec.slice(spec.lastIndexOf(":") + 1)] : [spec, undefined];
		const id = `${group}-${i}`;
		const dir = join(groupDir, `${i}-${slug(spec)}`);
		const checkout = join(dir, "repo");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		must("git", ["clone", "--quiet", "--shared", "--no-checkout", top, checkout]);
		must("git", ["-C", checkout, "checkout", "--quiet", "-b", "aeval-replay", base]);
		must("git", ["-C", checkout, "remote", "remove", "origin"]);
		writeFileSync(join(checkout, ".git", "hooks", "pre-push"), NO_PUSH_HOOK, { mode: 0o755 });

		const args = ["-p", "--model", model, ...(thinking ? ["--thinking", thinking] : []), "--session-dir", join(dir, "sessions")];
		let box: string | null = null;
		let boxDir: string | null = null;
		if (opts.sandbox) {
			box = `aeval-${group.slice(-6)}-${i}`;
			const ensureArgs = ["ensure", box, "--seed", checkout, ...(opts.net ? ["--net", opts.net] : []), ...(opts.size ? ["--size", opts.size] : [])];
			boxDir = must("agentbox", ensureArgs).split("\n").at(-1) ?? null;
			args.push("--cloud", "local", `--sandbox=${box}`);
		}
		args.push(REPLAY_PREAMBLE + task.task);
		log(`  [${i}] ${spec}: running${box ? ` in sandbox ${box}` : ""}`);
		const started = Date.now();
		const out = openSync(join(dir, "transcript.txt"), "w", 0o600);
		const err = openSync(join(dir, "stderr.txt"), "w", 0o600);
		const r = spawnSync(opts.harness, args, {
			cwd: checkout,
			stdio: ["ignore", out, err],
			timeout: opts.timeoutMs ?? 30 * 60 * 1000,
			env: { ...process.env, OMO_UNSUPERVISED: "1" },
		});
		closeSync(out);
		closeSync(err);
		const duration = Date.now() - started;
		const status = r.error && /ETIMEDOUT/.test(String(r.error)) ? "timeout" : r.status === 0 ? "done" : "failed";

		let diff = "";
		let stat = "";
		if (box && boxDir) {
			const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
			const sh = (c: string) => run("agentbox", ["exec", box!, "--", "bash", "-c", `cd ${q(boxDir!)} && git add -A && ${c}`]).stdout;
			diff = sh(`git diff --cached ${q(base)}`);
			stat = sh(`git diff --cached --stat ${q(base)}`).trim();
		} else {
			run("git", ["-C", checkout, "add", "-A"]);
			diff = run("git", ["-C", checkout, "diff", "--cached", base]).stdout;
			stat = run("git", ["-C", checkout, "diff", "--cached", "--stat", base]).stdout.trim();
		}
		writeFileSync(join(dir, "diff.patch"), redact(diff), { mode: 0o600 });
		const last = lastAssistantText(join(dir, "sessions"));
		db.query(
			`INSERT INTO replays (id, group_id, source_type, source_id, task, harness, model, thinking, placement, base_rev, dir, status, exit_code,
         duration_ms, diff_stat, final_text, session_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		).run(
			id,
			group,
			task.sourceType,
			task.sourceId,
			redact(task.task),
			opts.harness,
			model,
			thinking ?? null,
			box ? `sandbox:${box}` : "clone",
			base,
			dir,
			status,
			r.status,
			duration,
			stat.split("\n").at(-1) ?? "",
			last.text ?? redact(readFileSync(join(dir, "transcript.txt"), "utf8")).slice(-20_000),
			last.path,
			nowIso(),
		);
		log(`  [${i}] ${spec}: ${status} in ${(duration / 1000).toFixed(0)}s, ${stat.split("\n").at(-1) || "no changes"}`);
	});
	return group;
}
