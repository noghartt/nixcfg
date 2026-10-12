// The GitHub write path for cloud mode. Remote hosts and sandboxes hold no
// write credentials (sandboxes get at most a read-only token), so pushing runs
// here: the branch travels back as a git bundle, lands in the local clone
// as sandbox/<label>/<branch>, and is pushed over SSH with the local keys.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { q, run, type Target } from "./ssh.ts";

// Git goes over SSH, never HTTPS, even when a clone's origin is an HTTPS URL.
const GITHUB_OVER_SSH = ["-c", "url.git@github.com:.insteadOf=https://github.com/"];

export function registerPublish(pi: ExtensionAPI, target: () => Target | undefined) {
	pi.registerTool({
		name: "publish",
		label: "Publish branch",
		description:
			"Push a branch from the cloud environment (remote host or sandbox) to GitHub with the user's login, optionally opening a draft PR. Fetches it into the local clone first. Never force-pushes and refuses the default branch. Name branches by the repository's own conventions, and publish only when the task asks for a push or PR.",
		promptSnippet: "Push a cloud branch to GitHub (and open a draft PR) with the user's login",
		parameters: Type.Object({
			branch: Type.Optional(Type.String({ description: "Branch in the cloud checkout; default its current branch" })),
			as: Type.Optional(Type.String({ description: "Remote branch name; default the same name" })),
			pr: Type.Optional(
				Type.Object({
					title: Type.String(),
					body: Type.Optional(Type.String()),
					base: Type.Optional(Type.String({ description: "Default: the repository's default branch" })),
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const where = target();
			if (!where) throw new Error("publish only works in cloud mode.");
			const local = async (command: string, args: string[], cwd?: string) => {
				const result = await pi.exec(command, args, { cwd, signal });
				if (result.code !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
				return result.stdout.trim();
			};

			const repo = await local("git", ["rev-parse", "--show-toplevel"], ctx.cwd).catch(() => {
				throw new Error(`publish needs a local clone of this repository at ${ctx.cwd}; clone it there first.`);
			});
			const current = await run(where, `git -C ${q(where.cwd)} symbolic-ref --short HEAD`, { signal });
			const branch = params.branch ?? current.stdout.toString().trim();
			if (!branch) throw new Error("the cloud checkout is not on a branch; pass branch.");
			const name = params.as ?? branch;
			await local("git", ["check-ref-format", "--branch", name], repo);
			const symref = await local("git", [...GITHUB_OVER_SSH, "ls-remote", "--symref", "origin", "HEAD"], repo);
			const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(symref)?.[1];
			if (!defaultBranch) throw new Error("cannot resolve origin's default branch.");
			if (name === defaultBranch) throw new Error(`refusing to push to the default branch ${defaultBranch}; publish a feature branch and open a PR.`);

			const bundled = await run(where, `git -C ${q(where.cwd)} bundle create - ${q(`refs/heads/${branch}`)}`, { signal });
			if (bundled.code !== 0) throw new Error(`bundling ${branch}: ${bundled.stderr.trim() || `exit ${bundled.code}`}`);
			const dir = await mkdtemp(join(tmpdir(), "omo-publish-"));
			const label = where.box ?? where.dest;
			const ref = `refs/remotes/sandbox/${label}/${branch}`;
			try {
				const file = join(dir, "branch.bundle");
				await writeFile(file, bundled.stdout);
				await local("git", ["-c", "fetch.fsckObjects=true", "fetch", "-q", file, `+refs/heads/${branch}:${ref}`], repo);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
			// No force: a diverged remote branch is rejected rather than overwritten.
			await local("git", [...GITHUB_OVER_SSH, "push", "-q", "origin", `${ref}:refs/heads/${name}`], repo);

			const lines = [`Pushed ${branch} as origin/${name} (via ${repo}).`];
			if (params.pr) {
				const url = await local(
					"gh",
					["pr", "create", "--draft", "--head", name, "--base", params.pr.base ?? defaultBranch, "--title", params.pr.title, "--body", params.pr.body ?? ""],
					repo,
				);
				lines.push(`Draft PR: ${url}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	} as never);
}
