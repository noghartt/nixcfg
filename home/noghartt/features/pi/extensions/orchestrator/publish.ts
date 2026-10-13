// Pushes a node's branch to GitHub from this machine, with the user's own keys: sandboxes hold
// no write credentials. Adapted from cloud-mode's publish tool (cloud-mode/publish.ts).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git goes over SSH, never HTTPS, even when a clone's origin is an HTTPS URL.
export const GITHUB_OVER_SSH = ["-c", "url.git@github.com:.insteadOf=https://github.com/"];

// Runs a command and returns its trimmed stdout; throws with stderr on a non-zero exit.
export type Exec = (command: string, args: string[], cwd: string) => Promise<string>;

export function defaultBranchOf(symref: string): string | undefined {
	return /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(symref)?.[1];
}

export function refuseTarget(name: string, defaultBranch: string): string | undefined {
	if (name === defaultBranch) return `refusing to push to the default branch ${defaultBranch}; publish a feature branch and open a PR.`;
	if (name.startsWith("refs/") || name.startsWith("-")) return `"${name}" is not a plain branch name.`;
	return undefined;
}

// A sandbox branch that is not in the repository yet lands at `ref` (refs/remotes/sandbox/...).
export async function fetchBundle(exec: Exec, repo: string, data: Buffer, branch: string, ref: string): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "orch-publish-"));
	try {
		const file = join(dir, "branch.bundle");
		await writeFile(file, data);
		await exec("git", ["-c", "fetch.fsckObjects=true", "fetch", "-q", file, `+refs/heads/${branch}:${ref}`], repo);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function publishRef(
	exec: Exec,
	options: { repo: string; ref: string; name: string; pr?: { title: string; body?: string; base?: string } },
): Promise<string[]> {
	const { repo, ref, name } = options;
	await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
	await exec("git", ["check-ref-format", "--branch", name], repo);
	const defaultBranch = defaultBranchOf(await exec("git", [...GITHUB_OVER_SSH, "ls-remote", "--symref", "origin", "HEAD"], repo));
	if (!defaultBranch) throw new Error("cannot resolve origin's default branch.");
	const refused = refuseTarget(name, defaultBranch);
	if (refused) throw new Error(refused);
	// No force: a diverged remote branch is rejected rather than overwritten.
	await exec("git", [...GITHUB_OVER_SSH, "push", "-q", "origin", `${ref}:refs/heads/${name}`], repo);
	const lines = [`Pushed ${ref} as origin/${name} (from ${repo}).`];
	if (options.pr) {
		const url = await exec(
			"gh",
			[
				"pr",
				"create",
				"--draft",
				"--head",
				name,
				"--base",
				options.pr.base ?? defaultBranch,
				"--title",
				options.pr.title,
				"--body",
				options.pr.body ?? "",
			],
			repo,
		);
		lines.push(`Draft PR: ${url}`);
	}
	return lines;
}
