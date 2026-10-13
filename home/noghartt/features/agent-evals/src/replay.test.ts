import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPLAY_PREAMBLE, replay, resolveTask } from "./replay.ts";
import { fixtureDb } from "./testutil.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

// A stand-in harness: edits the checkout it runs in and records a Pi-format session,
// which is all replay relies on from a real omo/pi print run.
const FAKE_HARNESS = `#!/bin/sh
set -eu
model="" dir=""
while [ $# -gt 1 ]; do
  case "$1" in
    --model) model=$2; shift 2 ;;
    --session-dir) dir=$2; shift 2 ;;
    *) shift ;;
  esac
done
prompt=$1
echo "changed by $model" > replay-output.txt
mkdir -p "$dir"
cat > "$dir/s.jsonl" <<EOF
{"type":"session","version":3,"id":"r","timestamp":"2026-10-05T00:00:00.000Z","cwd":"$PWD"}
{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-05T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done with $model"}],"model":"$model"}}
EOF
printf '%s' "$prompt" > "$dir/prompt.txt"
echo "print output"
`;

describe("replay", () => {
	test("runs each candidate in its own remote-less clone and leaves the source repo untouched", () => {
		const { db, dir } = fixtureDb();
		const repo = join(dir, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "init");
		git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
		const before = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), worktrees: git(repo, "worktree", "list"), branches: git(repo, "branch", "-a") };

		const bin = mkdtempSync(join(tmpdir(), "aeval-bin-"));
		writeFileSync(join(bin, "omo"), FAKE_HARNESS);
		chmodSync(join(bin, "omo"), 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${bin}:${oldPath}`;
		try {
			const task = resolveTask(db, { node: "r1/fix-build" });
			expect(task.task).toContain("Acceptance criteria:\n- nix eval passes");
			const group = replay(db, task, { models: ["anthropic-subscription/claude-sonnet-5-5", "chatgpt-subscription/gpt-6-sol:high"], harness: "omo", repo });
			const rows = db.query("SELECT * FROM replays WHERE group_id = ? ORDER BY id").all(group) as Record<string, string | number>[];
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
			expect(rows[1]).toMatchObject({ model: "chatgpt-subscription/gpt-6-sol", thinking: "high", final_text: "done with chatgpt-subscription/gpt-6-sol", placement: "clone" });
			for (const r of rows) {
				const checkout = join(String(r.dir), "repo");
				expect(git(checkout, "remote")).toBe("");
				expect(existsSync(join(checkout, ".git", "hooks", "pre-push"))).toBe(true);
				expect(readFileSync(join(String(r.dir), "diff.patch"), "utf8")).toContain("+changed by");
				expect(readFileSync(join(String(r.dir), "sessions", "prompt.txt"), "utf8").startsWith(REPLAY_PREAMBLE)).toBe(true);
			}
		} finally {
			process.env.PATH = oldPath;
		}
		expect({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), worktrees: git(repo, "worktree", "list"), branches: git(repo, "branch", "-a") }).toEqual(before);
	});

	test("sandbox mode needs OmO, and a missing repository is an error", () => {
		const { db } = fixtureDb();
		const task = resolveTask(db, { session: "omo-sess-1" });
		expect(task.sourceId).toBe("omo:omo-sess-1");
		expect(() => replay(db, task, { models: ["m"], harness: "omo" })).toThrow(/repository not found/);
		expect(() => replay(db, { ...task, repo: process.cwd() }, { models: ["m"], harness: "pi", sandbox: true })).toThrow(/--harness omo/);
	});
});
