import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { createSandbox, loadConfig, pullBranches, Sbx } from "#sbx/index.ts";
import type { KindSpec, Sandbox, SandboxProvider } from "#sbx/provider.ts";
import { quote } from "#sbx/shell.ts";
import { SandboxExecutionEnv } from "./sandbox-env.ts";
import { Identity, type SandboxRef, SessionSandbox } from "./state.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

/** The local repository's top directory, or undefined outside one. */
export async function repoTop(cwd: string): Promise<string | undefined> {
	return git(cwd, "rev-parse", "--show-toplevel").catch(() => undefined);
}

/**
 * A sandbox name derived from the session and a key (`t12`, `bg12`, `run12`, `session-dev`), so a tool rerun after a
 * crash looks up the sandbox it already made instead of creating another. Provider names are DNS labels, hence the
 * hash and the lowercase.
 */
export function sandboxName(sessionId: string, key: string): string {
	const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
	return `pd-${session}-${key}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.slice(0, 40)
		.replace(/-+$/u, "");
}

/** `none`, `worktree`, `sandbox` or `sandbox:<kind>`, as profiles and the subagent tools take it. */
export type Isolation = "none" | "worktree" | "sandbox" | `sandbox:${string}`;

export function parseIsolation(value: string): { mode: "none" | "worktree" | "sandbox"; kind?: string } {
	if (value === "none" || value === "worktree" || value === "sandbox") return { mode: value };
	const kind = /^sandbox:([A-Za-z0-9._-]+)$/u.exec(value)?.[1];
	if (kind !== undefined) return { mode: "sandbox", kind };
	throw new Error(`isolation must be none, worktree, sandbox or sandbox:<kind>, not "${value}"`);
}

export function isIsolation(value: string): value is Isolation {
	try {
		parseIsolation(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * The sandbox a conversation's tools run in: its own (a sandbox-isolated subagent), none for a worktree-isolated one
 * (a worktree is a local checkout), else the session's.
 */
export async function sandboxOf(
	read: DocumentReader,
	conversationId: number,
	context: Context,
): Promise<SandboxRef | undefined> {
	const identity = await read.snapshot(Identity, conversationId as never, context);
	if (identity?.sandbox !== undefined) return identity.sandbox;
	if (identity?.worktree !== undefined) return undefined;
	return (await read.snapshot(SessionSandbox, context))?.ref;
}

export interface EnsureOptions {
	/** Deterministic: found again by a rerun. */
	readonly name: string;
	/** sbx kind; the config's default without one. */
	readonly kind?: string;
	/** A local directory whose repository seeds the checkout; none for an empty sandbox. */
	readonly repo?: string;
	/** A branch to create (from the seeded commit) and check out for the agent. */
	readonly branch?: string;
	readonly purpose: SandboxRef["purpose"];
	readonly keep?: boolean;
	/**
	 * The name is ours (derived by `sandboxName`), so a sandbox under it whose seeding a crash cut short is replaced. Off
	 * for a name the user gave, which may be a sandbox made some other way.
	 */
	readonly owned?: boolean;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
}

/** A sandbox's report after its work was brought back (or not). */
export interface SandboxSummary {
	readonly text: string;
	/** The local branch holding its work, when there is one. */
	readonly ref?: string;
	readonly removed: boolean;
	readonly failed: boolean;
}

/**
 * pi-durable's use of sbx: the library and its provider interface only, so any provider (exe.dev today, a self-hosted
 * runner later) works unchanged; capabilities, never provider ids, decide what the prompt offers. The config and kinds
 * come from `$XDG_CONFIG_HOME/sbx/config.json`, as for the `sbx` CLI, read on first use so a machine without sbx only
 * fails when a sandbox is asked for.
 */
export class Sandboxes {
	readonly #load: () => Sbx;
	#sbx: Sbx | undefined;
	readonly #boxes = new Map<string, Sandbox>();
	readonly #envs = new Map<string, SandboxExecutionEnv>();
	/** When each sandbox was last recorded as used. */
	readonly #touched = new Map<string, number>();

	constructor(load: () => Sbx = () => new Sbx(loadConfig())) {
		this.#load = load;
	}

	get sbx(): Sbx {
		if (this.#sbx === undefined) {
			try {
				this.#sbx = this.#load();
			} catch (error) {
				throw new Error(
					`sbx is not set up: ${error instanceof Error ? error.message : String(error)} (see docs/sandbox.md)`,
				);
			}
		}
		return this.#sbx;
	}

	/** Kind names for completion; empty when sbx is not configured. */
	kinds(): string[] {
		try {
			return Object.keys(this.sbx.config.kinds);
		} catch {
			return [];
		}
	}

	kind(name?: string): KindSpec {
		return this.sbx.kind(name);
	}

	/** The sandbox, if it still exists; cached by name. */
	async find(ref: Pick<SandboxRef, "name"> & { provider?: string }): Promise<Sandbox | undefined> {
		const cached = this.#boxes.get(ref.name);
		if (cached !== undefined) return cached;
		const found =
			ref.provider === undefined ? await this.sbx.find(ref.name) : await this.sbx.provider(ref.provider).get(ref.name);
		if (found !== undefined) this.#boxes.set(ref.name, found);
		return found;
	}

	async #box(ref: SandboxRef): Promise<Sandbox> {
		const box = await this.find(ref);
		if (box === undefined) {
			throw new Error(
				`Sandbox ${ref.name} no longer exists (removed, or reaped after a week unused); ` +
					`${ref.purpose === "session" ? "/sandbox off detaches the session, /sandbox <kind> makes a new one" : "nothing to reattach"}.`,
			);
		}
		return box;
	}

	providerOf(ref: Pick<SandboxRef, "provider">): SandboxProvider {
		return this.sbx.provider(ref.provider);
	}

	/**
	 * The sandbox named `options.name`, made (and seeded from the local repository) only when no sandbox has that name.
	 * A sandbox whose seeding a crash cut short is replaced. Each call checks out the agent's branch, so a rerun leaves
	 * the sandbox as the first call would have.
	 */
	async ensure(options: EnsureOptions): Promise<{ ref: SandboxRef; box: Sandbox; created: boolean }> {
		const kind = this.kind(options.kind);
		const provider = this.sbx.provider(kind.provider);
		const top = options.repo === undefined ? undefined : await repoTop(options.repo);
		let box = await provider.get(options.name);
		if (box !== undefined && options.owned !== false && top !== undefined && !(await seeded(box))) {
			options.onProgress?.(`sandbox ${box.name} was left half-seeded; making it again`);
			await provider.remove(box);
			box = undefined;
		}
		let created = false;
		if (box === undefined) {
			box = await createSandbox(
				provider,
				{ kind, name: options.name, ...(top === undefined ? {} : { repo: { source: top } }) },
				{
					...(options.signal === undefined ? {} : { signal: options.signal }),
					...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
				},
			);
			created = true;
		}
		this.#boxes.set(box.name, box);
		const ref = await this.#describeBox(box, kind.provider, {
			...(top === undefined ? {} : { localRoot: top }),
			...(options.branch === undefined ? {} : { branch: options.branch }),
			purpose: options.purpose,
			...(options.keep === true ? { keep: true } : {}),
		});
		if (ref.workdir !== undefined && top !== undefined) await this.#prepareCheckout(box, ref, top);
		return { ref, box, created };
	}

	/** Attach an existing sandbox by name (`/sandbox <name>`), with the local repository it pulls into. */
	async attach(name: string, localCwd: string): Promise<SandboxRef> {
		const box = await this.sbx.find(name);
		if (box === undefined) throw new Error(`No sandbox named ${name}, and no sbx kind ${name} (kinds: ${this.kinds().join(", ")})`);
		this.#boxes.set(box.name, box);
		const top = await repoTop(localCwd);
		return this.#describeBox(box, box.provider, {
			...(top === undefined ? {} : { localRoot: top }),
			purpose: "session",
			keep: true,
		});
	}

	async #describeBox(
		box: Sandbox,
		provider: string,
		extra: Pick<SandboxRef, "localRoot" | "branch" | "purpose" | "keep">,
	): Promise<SandboxRef> {
		const home = (await box.exec(`printf '%s' "$HOME"`)).stdout.trim();
		if (!home.startsWith("/")) throw new Error(`Sandbox ${box.name} has no usable home directory`);
		return {
			name: box.name,
			provider,
			kind: box.kind,
			home,
			...(box.info.workdir === undefined ? {} : { workdir: posix.resolve(home, box.info.workdir) }),
			...(box.info.commit === undefined ? {} : { base: box.info.commit }),
			...(box.info.branch === undefined ? {} : { branch: box.info.branch }),
			...extra,
		};
	}

	/** The agent's branch, and a commit identity (the local one) so its commits and ours never fail for want of one. */
	async #prepareCheckout(box: Sandbox, ref: SandboxRef, top: string): Promise<void> {
		const name = (await git(top, "config", "user.name").catch(() => "")) || "pi-durable";
		const email = (await git(top, "config", "user.email").catch(() => "")) || "pi-durable@sandbox.invalid";
		const lines = [
			`cd ${quote(ref.workdir!)} || exit 1`,
			`[ -n "$(git config user.email)" ] || { git config user.name ${quote(name)}; git config user.email ${quote(email)}; }`,
		];
		if (ref.branch !== undefined && ref.branch !== box.info.branch) {
			lines.push(
				`git rev-parse -q --verify ${quote(`refs/heads/${ref.branch}`)} >/dev/null || git checkout -q -b ${quote(ref.branch)}`,
			);
		}
		const result = await box.exec(lines.join("\n"));
		if (result.exitCode !== 0) throw new Error(`Preparing ${box.name}'s checkout failed: ${result.stderr.trim()}`);
	}

	/** Where a local directory is on the sandbox: the same place below the checkout, else the checkout, else home. */
	remoteCwd(ref: SandboxRef, localCwd: string): string {
		if (ref.workdir === undefined) return ref.home;
		if (ref.localRoot === undefined) return ref.workdir;
		let cwd = localCwd;
		try {
			cwd = realpathSync(localCwd);
		} catch {}
		const inside = relative(ref.localRoot, cwd);
		if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return ref.workdir;
		return posix.join(ref.workdir, ...inside.split(/[\\/]/u));
	}

	/** The execution environment for a conversation in `ref` whose local directory is `localCwd`. */
	async env(ref: SandboxRef, localCwd: string): Promise<SandboxExecutionEnv> {
		const cwd = this.remoteCwd(ref, localCwd);
		const key = `${ref.name}\0${cwd}\0${ref.purpose}`;
		let env = this.#envs.get(key);
		if (env === undefined) {
			const box = await this.#box(ref);
			env = new SandboxExecutionEnv({ box, home: ref.home, cwd, describe: () => this.describe(ref, box) });
			this.#envs.set(key, env);
		}
		// sbx counts only `touch` as use, not commands, so a sandbox a session works in would look idle to the reaper.
		const last = this.#touched.get(ref.name) ?? 0;
		if (Date.now() - last > 60 * 60 * 1000) {
			this.#touched.set(ref.name, Date.now());
			void env.box.touch().catch(() => undefined);
		}
		return env;
	}

	/** The `sandbox` system-prompt section. */
	describe(ref: SandboxRef, box: Sandbox): string {
		let provider: SandboxProvider | undefined;
		try {
			provider = this.providerOf(ref);
		} catch {}
		const egress = this.sbx.config.kinds[ref.kind]?.egress ?? box.info.egress;
		let url: string | undefined;
		if (provider?.capabilities().httpsUrl === true) {
			try {
				url = box.url(8000);
			} catch {}
		}
		const pulled = `sbx/${ref.name}/${ref.branch ?? "<branch>"}`;
		return [
			`Your tools (read, write, edit, bash) run in the sandbox "${ref.name}" (sbx kind ${ref.kind}), a separate machine, not the user's: files and commands are there, and nothing you do there changes the user's machine.`,
			egress === "all"
				? "Network: the sandbox has full internet access."
				: egress === "integrations"
					? "Network: no public internet. The sandbox reaches only its provider's own services and the integrations attached to it (such as GitHub repositories through its git remote); package registries and websites fail."
					: undefined,
			ref.workdir === undefined
				? `It has no repository checkout; work in ${ref.home}.`
				: `The repository${ref.localRoot === undefined ? "" : ` (${ref.localRoot} on the user's machine)`} is checked out at ${ref.workdir}${ref.branch === undefined ? "" : ` on branch ${ref.branch}`}${ref.base === undefined ? "" : `, seeded at commit ${ref.base.slice(0, 12)}`}; only commits travelled, not the user's uncommitted changes.`,
			url === undefined
				? "Ports are not reachable from outside the sandbox."
				: `A server listening on a port is reachable at ${url} (that one is port 8000; change the port, within the provider's allowed range). The URL is private to the user's account.`,
			ref.purpose === "subagent"
				? `Only committed work comes back: commit on ${ref.branch ?? "your branch"} before you answer. When you finish, your commits are brought back to the user's repository as branch ${pulled} (uncommitted changes are committed for you); anything outside git stays in the sandbox.`
				: `Only committed work comes back: commit your changes; sandbox_pull brings the sandbox's branches into the user's repository as sbx/${ref.name}/<branch>. Uncommitted changes and files outside git stay in the sandbox.`,
			"watch commands, antigravity and the research tools run on the user's machine, not in the sandbox.",
		]
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Commits what the agent left uncommitted, pulls its branch into the local repository as `sbx/<name>/<branch>`, and,
	 * with `remove` (and no `keep`), removes the sandbox. Replay-safe: pulling again is a no-op, and a sandbox already
	 * removed reports the branch an earlier run pulled. A failure keeps the sandbox for inspection and says so.
	 */
	async bringBack(ref: SandboxRef, options: { remove: boolean; signal?: AbortSignal }): Promise<SandboxSummary> {
		const localRef = ref.branch === undefined ? undefined : `sbx/${ref.name}/${ref.branch}`;
		const keepHint = `Inspect it with \`sbx shell ${ref.name}\`, pull again with sandbox_pull, remove it with \`sbx rm ${ref.name}\`.`;
		try {
			const box = await this.find(ref);
			if (box === undefined) {
				const have = localRef !== undefined && ref.localRoot !== undefined && (await hasBranch(ref.localRoot, localRef));
				return {
					text: have
						? `${await this.#describeBranch(ref, localRef!)}\nSandbox ${ref.name} was already removed.`
						: `Sandbox ${ref.name} no longer exists; nothing was brought back.`,
					...(have ? { ref: localRef! } : {}),
					removed: true,
					failed: !have,
				};
			}
			let text: string;
			let branch: string | undefined;
			if (ref.workdir === undefined || ref.localRoot === undefined || ref.branch === undefined) {
				text = `Sandbox ${ref.name} has no checkout to bring back.`;
			} else {
				const committed = await box.exec(commitScript(ref.workdir, `pi-durable: uncommitted work left in ${ref.name}`), {
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
				if (committed.exitCode !== 0) throw new Error(`committing leftovers failed: ${committed.stderr.trim()}`);
				const pulled = await pullBranches(box, ref.localRoot, [ref.branch], {
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
				if (pulled.fetched || (await hasBranch(ref.localRoot, localRef!))) {
					branch = localRef;
					text = await this.#describeBranch(ref, localRef!);
				} else text = `No changes were made in sandbox ${ref.name}.`;
			}
			if (options.remove && ref.keep !== true) {
				await this.providerOf(ref).remove(box);
				this.forget(ref.name);
				return { text: `${text}\nSandbox ${ref.name} was removed.`, ...(branch ? { ref: branch } : {}), removed: true, failed: false };
			}
			await box.touch().catch(() => undefined);
			return { text: `${text}\nSandbox ${ref.name} is kept. ${keepHint}`, ...(branch ? { ref: branch } : {}), removed: false, failed: false };
		} catch (error) {
			return {
				text:
					`Could not bring back the work of sandbox ${ref.name}: ${error instanceof Error ? error.message : String(error)}\n` +
					`The sandbox is kept for inspection. ${keepHint}`,
				removed: false,
				failed: true,
			};
		}
	}

	async #describeBranch(ref: SandboxRef, branch: string): Promise<string> {
		const root = ref.localRoot!;
		const base = ref.base;
		const commits = base === undefined ? undefined : await git(root, "rev-list", "--count", `${base}..${branch}`).catch(() => undefined);
		const stat = base === undefined ? "" : await git(root, "diff", "--stat", base, branch).catch(() => "");
		return [
			`Its work is on local branch ${branch}${commits === undefined ? "" : ` (${commits} commit${commits === "1" ? "" : "s"} since ${base!.slice(0, 10)})`}.`,
			stat,
			`Review with \`git diff ${base === undefined ? "" : `${base.slice(0, 10)}...`}${branch}\` and merge with \`git merge ${branch}\`.`,
		]
			.filter(Boolean)
			.join("\n");
	}

	/** Pull branches (all without any) into `localRepo` as sbx/<name>/<branch>; returns git's output and the branches. */
	async pull(
		ref: Pick<SandboxRef, "name"> & { provider?: string },
		localRepo: string,
		branches: readonly string[],
		signal?: AbortSignal,
	): Promise<{ fetched: boolean; output: string; branches: string[] }> {
		const box = await this.find(ref);
		if (box === undefined) throw new Error(`No sandbox named ${ref.name}`);
		const result = await pullBranches(box, localRepo, branches, { ...(signal === undefined ? {} : { signal }) });
		await box.touch().catch(() => undefined);
		const listed = await git(localRepo, "for-each-ref", "--format=%(refname:short)", `refs/heads/sbx/${box.name}/`).catch(
			() => "",
		);
		return { ...result, branches: listed.split("\n").filter(Boolean) };
	}

	async remove(ref: Pick<SandboxRef, "name"> & { provider?: string }): Promise<boolean> {
		const box = await this.find(ref);
		if (box === undefined) return false;
		await this.sbx.provider(box.provider).remove(box);
		this.forget(box.name);
		return true;
	}

	forget(name: string): void {
		this.#boxes.delete(name);
		for (const key of [...this.#envs.keys()]) if (key.startsWith(`${name}\0`)) this.#envs.delete(key);
	}

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		for (const env of envs) await env.cleanup(context);
	}
}

/** Whether the checkout's seed made it: the seeded commit is there (a crash mid-seed leaves it missing). */
async function seeded(box: Sandbox): Promise<boolean> {
	const dir = box.info.workdir;
	if (dir === undefined) return false;
	const what = box.info.commit === undefined ? "HEAD" : `${box.info.commit}^{commit}`;
	const r = await box.exec(`cd "$HOME"/${quote(dir)} 2>/dev/null && git cat-file -e ${quote(what)}`);
	return r.exitCode === 0;
}

/** Commits everything uncommitted in the checkout, if anything is. */
function commitScript(workdir: string, message: string): string {
	return [
		`cd ${quote(workdir)} || exit 1`,
		"git add -A || exit 1",
		`git diff --cached --quiet || git commit -q -m ${quote(message)}`,
	].join("\n");
}

async function hasBranch(repo: string, branch: string): Promise<boolean> {
	return git(repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`).then(
		() => true,
		() => false,
	);
}

/** A downloaded artifact of `sandbox_run`. */
export interface Artifact {
	readonly remote: string;
	readonly local: string;
	readonly error?: string;
}

export interface RunOptions {
	readonly name: string;
	readonly command: string;
	readonly kind?: string;
	readonly repo?: string;
	readonly timeoutMs?: number;
	readonly artifacts?: readonly string[];
	/** Local directory; artifacts land in `<out>/<sandbox>/<path>`. */
	readonly out: string;
	readonly keep?: boolean;
	readonly signal?: AbortSignal;
	readonly onOutput?: (text: string) => void;
	readonly onProgress?: (message: string) => void;
}

/**
 * `sandbox_run`: one command in a fresh sandbox, its output streamed, artifacts downloaded, the sandbox removed unless
 * kept (also when the command fails or is cancelled). The name is deterministic, so a rerun after a crash runs the
 * command again in the sandbox the first run made rather than in a second one.
 */
export async function runInSandbox(
	sandboxes: Sandboxes,
	options: RunOptions,
): Promise<{ name: string; exitCode: number; artifacts: Artifact[]; removed: boolean }> {
	const { ref, box } = await sandboxes.ensure({
		name: options.name,
		...(options.kind === undefined ? {} : { kind: options.kind }),
		...(options.repo === undefined ? {} : { repo: options.repo }),
		purpose: "session",
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
	});
	const artifacts: Artifact[] = [];
	let removed = false;
	try {
		const result = await box.exec(options.command, {
			cwd: ref.workdir ?? ref.home,
			capture: false,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			onStdout: (text) => options.onOutput?.(text),
			onStderr: (text) => options.onOutput?.(text),
		});
		for (const path of options.artifacts ?? []) {
			const remote = path.startsWith("/") ? path : posix.join(ref.workdir ?? ref.home, path);
			const local = join(options.out, box.name, path.replace(/^\/+/u, ""));
			try {
				await box.download(remote, local, { ...(options.signal === undefined ? {} : { signal: options.signal }) });
				artifacts.push({ remote, local });
			} catch (error) {
				artifacts.push({ remote, local, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { name: box.name, exitCode: result.exitCode, artifacts, removed: await finish() };
	} catch (error) {
		await finish().catch(() => undefined);
		throw error;
	}

	async function finish(): Promise<boolean> {
		if (options.keep === true || removed) return removed;
		await sandboxes.providerOf(ref).remove(box);
		sandboxes.forget(box.name);
		removed = true;
		return true;
	}
}
