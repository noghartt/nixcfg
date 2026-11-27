import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeInfo } from "./state.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

/**
 * `git twig new` makes the same linked worktree as `git worktree add`, but clones tracked files copy-on-write (APFS,
 * reflink), so a worktree per subagent costs little disk; it falls back to plain git by itself where it cannot.
 * PI_DURABLE_TWIG=0 skips it, as does a git without the `twig` subcommand.
 */
async function addWorktree(top: string, branch: string, path: string, base: string): Promise<void> {
	if (process.env.PI_DURABLE_TWIG !== "0") {
		try {
			await git(top, "twig", "new", "-b", branch, path, base);
			return;
		} catch (error) {
			// Twig missing (git says it is not a git command) falls through; a real failure is reported as twig's.
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			if (!/is not a git command/.test(stderr)) throw error;
		}
	}
	await git(top, "worktree", "add", "-b", branch, path, base);
}

/**
 * A git worktree for one isolated subagent, on its own branch cut from the parent's HEAD. The path and branch derive from
 * `key`, so a tool rerun after a crash finds the worktree it already made. Worktrees live in the session directory, not
 * the repository, so a checkout never gains untracked directories.
 *
 * Returns the worktree and the directory the subagent works in: the same subdirectory of the worktree as `cwd` is of
 * its repository.
 */
export async function ensureWorktree(
	cwd: string,
	sessionDir: string,
	sessionId: string,
	key: string,
): Promise<{ worktree: WorktreeInfo; cwd: string }> {
	let top: string;
	try {
		top = await git(cwd, "rev-parse", "--show-toplevel");
	} catch {
		throw new Error(`Worktree isolation needs a git repository; ${cwd} is not in one. Use isolation "none".`);
	}
	const path = join(sessionDir, "worktrees", key);
	// The session's creation time and the key: unique per subagent, readable in `git branch`.
	const branch = `pi-durable/${sessionId.slice(0, 13)}-${key}`;
	// Asked of git, since `top` is a resolved path and `cwd` may not be (macOS /tmp is /private/tmp).
	const inside = await git(cwd, "rev-parse", "--show-prefix");
	if (existsSync(path)) {
		const base = await git(path, "config", "--worktree", "--get", "pi-durable.base").catch(() => "");
		return { worktree: { path, branch, base: base || (await git(top, "rev-parse", "HEAD")) }, cwd: join(path, inside) };
	}
	await mkdir(join(sessionDir, "worktrees"), { recursive: true });
	const base = await git(top, "rev-parse", "HEAD");
	await addWorktree(top, branch, path, base);
	// Remember where the branch started, for the summary; per-worktree config needs the extension.
	await git(path, "config", "extensions.worktreeConfig", "true").catch(() => {});
	await git(path, "config", "--worktree", "pi-durable.base", base).catch(() => {});
	return { worktree: { path, branch, base }, cwd: join(path, inside) };
}

/**
 * What an isolated subagent left: its commits and uncommitted files. With `cleanup`, a worktree without either is
 * removed with its branch, so finished read-only work leaves nothing behind.
 */
export async function summarizeWorktree(worktree: WorktreeInfo, cleanup: boolean): Promise<string> {
	if (!existsSync(worktree.path)) return `Worktree ${worktree.path} no longer exists (branch ${worktree.branch}).`;
	try {
		const dirty = (await git(worktree.path, "status", "--porcelain")).split("\n").filter(Boolean).length;
		const commits = Number(await git(worktree.path, "rev-list", "--count", `${worktree.base}..HEAD`));
		if (dirty === 0 && commits === 0) {
			if (!cleanup) return `No changes yet on branch ${worktree.branch} (worktree ${worktree.path}).`;
			const top = await git(worktree.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
			await git(worktree.path, "worktree", "remove", "--force", worktree.path);
			await git(join(top, ".."), "branch", "-D", worktree.branch).catch(() => {});
			return "No changes were made; its worktree was removed.";
		}
		const stat = await git(worktree.path, "diff", "--stat", worktree.base).catch(() => "");
		return [
			`Changes are on branch ${worktree.branch} (${commits} commit${commits === 1 ? "" : "s"} since ${worktree.base.slice(0, 10)}` +
				`${dirty > 0 ? `, ${dirty} uncommitted file${dirty === 1 ? "" : "s"}` : ""}) in worktree ${worktree.path}.`,
			stat,
			`Review with \`git diff ${worktree.base.slice(0, 10)}...${worktree.branch}\`, merge with \`git merge ${worktree.branch}\` ` +
				`from the main checkout, and remove it with \`git worktree remove ${worktree.path}\`.`,
		]
			.filter(Boolean)
			.join("\n");
	} catch (error) {
		return `Could not inspect worktree ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
