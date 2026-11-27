import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader, Harness } from "@earendil-works/pi-durable";
import { createSandbox, loadConfig, pullBranches, Sbx } from "#sbx/index.ts";
import type { KindSpec, Sandbox, SandboxProvider } from "#sbx/provider.ts";
import { quote } from "#sbx/shell.ts";
import { SandboxExecutionEnv } from "./sandbox-env.ts";
import { Identity, type SandboxRef, SessionSandbox, type SessionSandboxState } from "./state.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

/** The local repository's top directory, or undefined outside one. */
export async function repoTop(cwd: string): Promise<string | undefined> {
	return git(cwd, "rev-parse", "--show-toplevel").catch(() => undefined);
}

/** Written once a sandbox's checkout is seeded and prepared; a sandbox without it was cut short by a crash. */
const SEEDED_MARKER = ".pi-durable/seeded";
/** Leftover files bigger than this are not committed for the agent (build outputs, datasets); the summary names them. */
const MAX_LEFTOVER_BYTES = 10 * 1024 * 1024;

function sessionHash(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

/** What every sandbox name this session makes starts with. */
export function sessionPrefix(sessionId: string): string {
	return `pd-${sessionHash(sessionId)}-`;
}

/**
 * A sandbox name derived from the session and a key (`t12`, `bg12`, `run12`, `session-dev`), so a tool rerun after a
 * crash looks up the sandbox it already made instead of creating another. Provider names are DNS labels, hence the
 * hash and the lowercase.
 */
export function sandboxName(sessionId: string, key: string): string {
	return `${sessionPrefix(sessionId)}${key}`
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

/** Why the session's sandbox cannot be used right now, or undefined when it can (or there is none). */
export function sessionSandboxProblem(state: SessionSandboxState | undefined): string | undefined {
	if (state?.failed !== undefined) {
		return `The session's sandbox failed: ${state.failed}. /sandbox <kind> tries again; /sandbox off runs tools on this machine.`;
	}
	if (state?.pending !== undefined) {
		return (
			`The session's sandbox ${state.pending.name} is not ready (being made, or its creation was cut short). ` +
			"Wait for it, or /sandbox <kind> to try again, /sandbox off to run tools on this machine."
		);
	}
	return undefined;
}

/** Where a conversation's tools run: on this machine, in a sandbox, or nowhere until the session's sandbox is ready. */
export type SandboxTarget =
	| { readonly kind: "local" }
	| { readonly kind: "sandbox"; readonly ref: SandboxRef }
	| { readonly kind: "blocked"; readonly reason: string };

/**
 * A conversation's own sandbox (a sandbox-isolated subagent) wins; a local worktree runs locally; otherwise the
 * session's sandbox, and while that one is pending or failed, nothing runs: falling back to this machine would run
 * commands meant for a VM on the user's own.
 */
export async function sandboxTarget(read: DocumentReader, conversationId: number, context: Context): Promise<SandboxTarget> {
	const identity = await read.snapshot(Identity, conversationId as never, context);
	if (identity?.sandbox !== undefined) return { kind: "sandbox", ref: identity.sandbox };
	if (identity?.worktree !== undefined) return { kind: "local" };
	const session = await read.snapshot(SessionSandbox, context);
	const problem = sessionSandboxProblem(session);
	if (problem !== undefined) return { kind: "blocked", reason: problem };
	return session?.ref === undefined ? { kind: "local" } : { kind: "sandbox", ref: session.ref };
}

/** The sandbox a conversation's tools run in, if any; throws while the session's sandbox is not ready. */
export async function sandboxOf(read: DocumentReader, conversationId: number, context: Context): Promise<SandboxRef | undefined> {
	const target = await sandboxTarget(read, conversationId, context);
	if (target.kind === "blocked") throw new Error(target.reason);
	return target.kind === "sandbox" ? target.ref : undefined;
}

export interface EnsureOptions {
	/** Deterministic: found again by a rerun. */
	readonly name: string;
	/** sbx kind; the config's default without one. */
	readonly kind?: string;
	/** A local directory whose repository seeds the checkout; none for an empty sandbox. */
	readonly repo?: string;
	/** Refuse to make a sandbox outside a git repository (its work could not come back). */
	readonly requireRepo?: boolean;
	/** A branch to create (from the seeded commit) and check out for the agent. */
	readonly branch?: string;
	readonly purpose: SandboxRef["purpose"];
	readonly keep?: boolean;
	/**
	 * The name is ours (derived by `sandboxName`) and no saved reference points at it, so a sandbox under it that a crash
	 * left half-made (no seeded marker) is replaced. Off for a name the user gave and for a sandbox a conversation or the
	 * session already refers to, which are never replaced.
	 */
	readonly owned?: boolean;
	readonly signal?: AbortSignal;
	readonly onProgress?: (message: string) => void;
}

/** A sandbox's report after its work was brought back (or not). */
export interface SandboxSummary {
	readonly text: string;
	/** The branch holding its work, when there is one. */
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
	/** By the sandbox's provider id, cwd and purpose: a sandbox replaced under the same name gets new environments. */
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
				`Sandbox ${ref.name} no longer exists (removed when its work came back or the session closed, or reaped after a week unused); ` +
					(ref.purpose === "session"
						? "/sandbox off runs tools on this machine, /sandbox <kind> makes a new one."
						: "start a new subagent for more work."),
			);
		}
		return box;
	}

	providerOf(ref: Pick<SandboxRef, "provider">): SandboxProvider {
		return this.sbx.provider(ref.provider);
	}

	/**
	 * The sandbox named `options.name`, made (and seeded from the local repository) only when no sandbox has that name.
	 * With `owned`, one a crash left half-made is replaced. Each call checks out the agent's branch, so a rerun leaves
	 * the sandbox as the first call would have. A failure after creating it removes it. Seeding warnings (uncommitted
	 * local changes that stay behind) come back in `warnings`.
	 */
	async ensure(options: EnsureOptions): Promise<{ ref: SandboxRef; box: Sandbox; created: boolean; warnings: string[] }> {
		const kind = this.kind(options.kind);
		const provider = this.sbx.provider(kind.provider);
		const top = options.repo === undefined ? undefined : await repoTop(options.repo);
		if (options.requireRepo === true && top === undefined) {
			throw new Error(`Sandbox isolation needs a git repository; ${options.repo} is not in one. Use isolation "none".`);
		}
		const warnings: string[] = [];
		const progress = (message: string) => {
			if (/warning/iu.test(message)) warnings.push(message.replace(/^warning:\s*/iu, ""));
			options.onProgress?.(message);
		};
		const signal = options.signal === undefined ? {} : { signal: options.signal };
		let box = await provider.get(options.name);
		if (box !== undefined && options.owned === true && !(await hasMarker(box))) {
			progress(`sandbox ${box.name} was left half-made; making it again`);
			await provider.remove(box);
			box = undefined;
		}
		let created = false;
		if (box === undefined) {
			box = await createSandbox(
				provider,
				{ kind, name: options.name, ...(top === undefined ? {} : { repo: { source: top } }) },
				{ ...signal, onProgress: progress },
			);
			created = true;
			// A new sandbox under an old name: environments made for the old one must not be reused.
			this.forget(box.name);
		}
		this.#boxes.set(box.name, box);
		try {
			const ref = await this.#describeBox(box, kind.provider, {
				...(top === undefined ? {} : { localRoot: top }),
				...(options.branch === undefined ? {} : { branch: options.branch }),
				purpose: options.purpose,
				...(options.keep === true ? { keep: true } : {}),
			});
			await this.#prepare(box, ref, top);
			return { ref, box, created, warnings };
		} catch (error) {
			if (created) {
				await provider.remove(box).catch(() => undefined);
				this.forget(box.name);
			}
			throw error;
		}
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

	/**
	 * The agent's branch, a commit identity (the local one) so its commits and ours never fail for want of one, and the
	 * seeded marker, all in one round trip.
	 */
	async #prepare(box: Sandbox, ref: SandboxRef, top: string | undefined): Promise<void> {
		const lines = [`mkdir -p "$HOME"/.pi-durable || exit 1`];
		if (ref.workdir !== undefined && top !== undefined) {
			const name = (await git(top, "config", "user.name").catch(() => "")) || "pi-durable";
			const email = (await git(top, "config", "user.email").catch(() => "")) || "pi-durable@sandbox.invalid";
			lines.push(
				`cd ${quote(ref.workdir)} || exit 1`,
				`[ -n "$(git config user.email)" ] || { git config user.name ${quote(name)}; git config user.email ${quote(email)}; }`,
			);
			if (ref.branch !== undefined && ref.branch !== box.info.branch) {
				lines.push(
					`git rev-parse -q --verify ${quote(`refs/heads/${ref.branch}`)} >/dev/null || git checkout -q -b ${quote(ref.branch)} || exit 1`,
				);
			}
		}
		lines.push(`: > "$HOME"/${SEEDED_MARKER}`);
		const result = await box.exec(lines.join("\n"));
		if (result.exitCode !== 0) throw new Error(`Preparing ${box.name}'s checkout failed: ${result.stderr.trim()}`);
	}

	/**
	 * A subagent's place inside its parent's sandbox: a git worktree of the parent's checkout on its own branch, made
	 * once (`key` names it, so a rerun finds it). Commits there are commits of the parent's repository in the sandbox, so
	 * nothing has to travel between VMs or through this machine.
	 */
	async worktreeIn(parent: SandboxRef, sessionId: string, key: string): Promise<SandboxRef> {
		const main = parent.worktreeOf ?? parent.workdir;
		if (main === undefined) {
			throw new Error(`The session's sandbox ${parent.name} has no repository checkout, so it cannot hold an isolated subagent.`);
		}
		const box = await this.#box(parent);
		const path = posix.join(parent.home, ".pi-durable", "worktrees", `${sessionHash(sessionId)}-${key}`);
		const branch = `pi-durable/${sessionId.slice(0, 13)}-${key}`;
		const script = [
			`cd ${quote(main)} || exit 1`,
			`if [ ! -d ${quote(path)} ]; then`,
			`  mkdir -p ${quote(posix.dirname(path))} || exit 1`,
			`  if git rev-parse -q --verify ${quote(`refs/heads/${branch}`)} >/dev/null; then git worktree add -q ${quote(path)} ${quote(branch)} || exit 1`,
			`  else git worktree add -q -b ${quote(branch)} ${quote(path)} HEAD || exit 1; fi`,
			`  git -C ${quote(path)} rev-parse HEAD > ${quote(`${path}.base`)}`,
			`fi`,
			`cat ${quote(`${path}.base`)}`,
		].join("\n");
		const result = await box.exec(script);
		if (result.exitCode !== 0) throw new Error(`Making a worktree in sandbox ${box.name} failed: ${result.stderr.trim()}`);
		const { keep: _keep, ...rest } = parent;
		return { ...rest, workdir: path, branch, base: result.stdout.trim(), purpose: "subagent", worktreeOf: main };
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
		const box = await this.#box(ref);
		const cwd = this.remoteCwd(ref, localCwd);
		const key = `${ref.name}\0${box.id}\0${cwd}\0${ref.purpose}`;
		let env = this.#envs.get(key);
		if (env === undefined) {
			env = new SandboxExecutionEnv({ box, home: ref.home, cwd, describe: () => this.describe(ref, box) });
			this.#envs.set(key, env);
		}
		// sbx counts only `touch` as use, not commands, so a sandbox a session works in would look idle to the reaper.
		const last = this.#touched.get(ref.name) ?? 0;
		if (Date.now() - last > 60 * 60 * 1000) {
			this.#touched.set(ref.name, Date.now());
			void box.touch().catch(() => undefined);
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
		const checkout =
			ref.workdir === undefined
				? `It has no repository checkout; work in ${ref.home}.`
				: ref.worktreeOf !== undefined
					? `You work in a git worktree at ${ref.workdir} of the sandbox's checkout ${ref.worktreeOf}, on branch ${ref.branch}; other agents work in that checkout and their own worktrees at the same time.`
					: `The repository${ref.localRoot === undefined ? "" : ` (${ref.localRoot} on the user's machine)`} is checked out at ${ref.workdir}${ref.branch === undefined ? "" : ` on branch ${ref.branch}`}${ref.base === undefined ? "" : `, seeded at commit ${ref.base.slice(0, 12)}`}; only commits travelled, not the user's uncommitted changes.`;
		const comesBack =
			ref.purpose === "session"
				? `Only committed work comes back: commit your changes; sandbox_pull brings the sandbox's branches into the user's repository as sbx/${ref.name}/<branch>. Uncommitted changes and files outside git stay in the sandbox.`
				: ref.worktreeOf !== undefined
					? `Commit your work on ${ref.branch} before you answer (uncommitted changes are committed for you): the branch stays in the sandbox's repository, where the agent that started you merges it.`
					: `Only committed work comes back: commit on ${ref.branch ?? "your branch"} before you answer. When you finish, your commits are brought back to the user's repository as branch ${pulled} (uncommitted changes are committed for you, except files over 10 MB); anything outside git stays in the sandbox.`;
		return [
			`Your tools (read, write, edit, bash) run in the sandbox "${ref.name}" (sbx kind ${ref.kind}), a separate machine, not the user's: files and commands are there, and nothing you do there changes the user's machine.`,
			egress === "all"
				? "Network: the sandbox has full internet access."
				: egress === "integrations"
					? "Network: no public internet. The sandbox reaches only its provider's own services and the integrations attached to it (such as GitHub repositories through its git remote); package registries and websites fail."
					: undefined,
			checkout,
			url === undefined
				? "Ports are not reachable from outside the sandbox."
				: `A server listening on a port is reachable at ${url} (that one is port 8000; change the port, within the provider's allowed range). The URL is private to the user's account.`,
			comesBack,
			"watch commands, antigravity and the research tools run on the user's machine, not in the sandbox.",
		]
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Commits what the agent left uncommitted, brings its branch back and, with `remove` (and no `keep`), removes what it
	 * worked in. For its own sandbox: the branch is pulled into the local repository as `sbx/<name>/<branch>` and the
	 * sandbox removed. For a worktree inside its parent's sandbox: the branch stays there and the worktree is removed
	 * (with the branch too when it holds nothing new). Replay-safe: pulling again is a no-op, and once removed a rerun
	 * reports what an earlier run left. A failure keeps everything for inspection and says so.
	 */
	async bringBack(ref: SandboxRef, options: { remove: boolean; signal?: AbortSignal }): Promise<SandboxSummary> {
		if (ref.worktreeOf !== undefined) return this.#bringBackWorktree(ref, options);
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
				const skipped = await commitLeftovers(box, ref, options.signal);
				const pulled = await pullBranches(box, ref.localRoot, [ref.branch], {
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
				if (pulled.fetched || (await hasBranch(ref.localRoot, localRef!))) {
					branch = localRef;
					text = await this.#describeBranch(ref, localRef!);
				} else text = `No changes were made in sandbox ${ref.name}.`;
				if (skipped.length > 0) text += `\n${skippedNote(skipped)}`;
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

	async #bringBackWorktree(ref: SandboxRef, options: { remove: boolean; signal?: AbortSignal }): Promise<SandboxSummary> {
		const where = `sandbox ${ref.name}'s checkout ${ref.worktreeOf}`;
		try {
			const box = await this.find(ref);
			if (box === undefined) return { text: `Sandbox ${ref.name} no longer exists; its branch ${ref.branch} went with it.`, removed: true, failed: true };
			const signal = options.signal === undefined ? {} : { signal: options.signal };
			const present = (await box.exec(`test -d ${quote(ref.workdir!)}`, signal)).exitCode === 0;
			const skipped = present ? await commitLeftovers(box, ref, options.signal) : [];
			const counted = await box.exec(
				`cd ${quote(ref.worktreeOf!)} && git rev-list --count ${quote(`${ref.base}..refs/heads/${ref.branch}`)} 2>/dev/null && git diff --stat ${quote(ref.base!)} ${quote(`refs/heads/${ref.branch}`)} 2>/dev/null`,
				signal,
			);
			const [count = "", ...stat] = counted.stdout.trim().split("\n");
			const commits = counted.exitCode === 0 ? Number(count) : 0;
			let text =
				commits > 0
					? [
							`Its work is on branch ${ref.branch} in ${where} (${commits} commit${commits === 1 ? "" : "s"} since ${ref.base!.slice(0, 10)}).`,
							stat.join("\n"),
							`Merge it there with \`git merge ${ref.branch}\`; sandbox_pull brings it home as sbx/${ref.name}/${ref.branch}.`,
						]
							.filter(Boolean)
							.join("\n")
					: `No changes were made in ${where}.`;
			if (skipped.length > 0) text += `\n${skippedNote(skipped)}`;
			if (options.remove && present) {
				// The branch keeps the commits; the worktree only held the files.
				const removed = await box.exec(
					[
						`cd ${quote(ref.worktreeOf!)} || exit 1`,
						`git worktree remove --force ${quote(ref.workdir!)} || exit 1`,
						`rm -f ${quote(`${ref.workdir}.base`)}`,
						...(commits > 0 ? [] : [`git branch -q -D ${quote(ref.branch!)} 2>/dev/null || true`]),
					].join("\n"),
					signal,
				);
				if (removed.exitCode !== 0) throw new Error(removed.stderr.trim());
				text += "\nIts worktree was removed.";
			} else if (!present && options.remove) text += "\nIts worktree was already removed.";
			return { text, ...(commits > 0 ? { ref: ref.branch! } : {}), removed: options.remove, failed: false };
		} catch (error) {
			return {
				text: `Could not wrap up the worktree ${ref.workdir} in ${where}: ${error instanceof Error ? error.message : String(error)}. It is kept for inspection.`,
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

	/**
	 * Pull branches (all without any) into `localRepo` as sbx/<name>/<branch>; returns git's output and the branches. A
	 * sandbox already gone (a rerun after a pull that removed it) reports the branches an earlier pull left.
	 */
	async pull(
		ref: Pick<SandboxRef, "name"> & { provider?: string },
		localRepo: string,
		branches: readonly string[],
		signal?: AbortSignal,
	): Promise<{ fetched: boolean; output: string; branches: string[]; gone: boolean }> {
		const listed = async () =>
			(await git(localRepo, "for-each-ref", "--format=%(refname:short)", `refs/heads/sbx/${ref.name}/`).catch(() => ""))
				.split("\n")
				.filter(Boolean);
		const box = await this.find(ref);
		if (box === undefined) {
			const earlier = await listed();
			if (earlier.length === 0) throw new Error(`No sandbox named ${ref.name}`);
			return { fetched: false, output: "", branches: earlier, gone: true };
		}
		const result = await pullBranches(box, localRepo, branches, { ...(signal === undefined ? {} : { signal }) });
		await box.touch().catch(() => undefined);
		return { ...result, branches: await listed(), gone: false };
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
		this.#touched.delete(name);
		for (const key of [...this.#envs.keys()]) if (key.startsWith(`${name}\0`)) this.#envs.delete(key);
	}

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		await Promise.all(envs.map((env) => env.cleanup(context)));
	}
}

/** Whether the sandbox was fully made by pi-durable: a crash mid-seed leaves no marker. */
async function hasMarker(box: Sandbox): Promise<boolean> {
	return (await box.exec(`test -f "$HOME"/${SEEDED_MARKER}`)).exitCode === 0;
}

/**
 * Commits everything uncommitted in the checkout that git does not ignore, except files over 10 MB (build outputs,
 * datasets), which stay behind and are returned so the summary can name them.
 */
async function commitLeftovers(box: Sandbox, ref: SandboxRef, signal?: AbortSignal): Promise<string[]> {
	const script = [
		`cd ${quote(ref.workdir!)} || exit 1`,
		"git add -A || exit 1",
		`git -c core.quotepath=off diff --cached --name-only --diff-filter=AM | while IFS= read -r f; do`,
		`  if [ -f "$f" ] && [ "$(wc -c < "$f" | tr -d ' ')" -gt ${MAX_LEFTOVER_BYTES} ]; then git reset -q -- "$f"; echo "skipped:$f"; fi`,
		"done",
		`git diff --cached --quiet || git commit -q -m ${quote(`pi-durable: uncommitted work left in ${ref.name}`)} || exit 1`,
	].join("\n");
	const result = await box.exec(script, { ...(signal === undefined ? {} : { signal }) });
	if (result.exitCode !== 0) throw new Error(`committing leftovers failed: ${result.stderr.trim()}`);
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("skipped:"))
		.map((line) => line.slice("skipped:".length));
}

function skippedNote(files: readonly string[]): string {
	return `Not committed (over ${MAX_LEFTOVER_BYTES / 1024 / 1024} MB, left in the sandbox): ${files.join(", ")}.`;
}

async function hasBranch(repo: string, branch: string): Promise<boolean> {
	return git(repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`).then(
		() => true,
		() => false,
	);
}

/** How `/sandbox <argument>` and `--sandbox=<argument>` read: a kind, `kind:name`, or an existing sandbox's name. */
export function parseSandboxArgument(
	argument: string,
	kinds: readonly string[],
	sessionId: string,
): { kind?: string; name: string; owned: boolean } {
	const colon = argument.indexOf(":");
	if (colon >= 0) {
		const kind = argument.slice(0, colon);
		const given = argument.slice(colon + 1);
		return given ? { kind, name: given, owned: false } : { kind, name: sandboxName(sessionId, `session-${kind}`), owned: true };
	}
	if (kinds.includes(argument)) return { kind: argument, name: sandboxName(sessionId, `session-${argument}`), owned: true };
	return { name: argument, owned: false };
}

type SessionDocs = Pick<Harness, "commit" | "snapshot">;

/** Mark the session's sandbox pending before anything can run, so nothing runs on this machine meanwhile. */
export async function markSessionSandboxPending(harness: SessionDocs, name: string, kind: string | undefined, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(SessionSandbox);
		delete doc.failed;
		doc.pending = { name, ...(kind === undefined ? {} : { kind }), since: Date.now() };
	}, context);
}

/**
 * `/sandbox` and `--sandbox`: shows, detaches, or makes/attaches the session's sandbox, kept in a session document so
 * a reopen reattaches by name. While it is being made the document is pending, and a failure is recorded, so tools
 * refuse to run (`sandboxTarget`) instead of running on this machine.
 */
export async function setSessionSandbox(
	harness: SessionDocs,
	sandboxes: Sandboxes,
	argument: string,
	options: { sessionId: string; cwd: string; notice: (level: "info" | "warning", message: string) => void },
	context: Context,
): Promise<string> {
	const state = await harness.snapshot(SessionSandbox, context);
	const current = state?.ref;
	const describe = (ref: SandboxRef) =>
		`${ref.name} (kind ${ref.kind}${ref.workdir === undefined ? "" : `, checkout ${ref.workdir}${ref.branch === undefined ? "" : ` on ${ref.branch}`}`})`;
	const kept = (ref: SandboxRef) =>
		`${ref.name} is kept: sandbox_pull (or \`sbx pull ${ref.name}\`) brings its branches back, \`sbx rm ${ref.name}\` removes it.`;
	if (argument === "" || argument === "status") {
		const problem = sessionSandboxProblem(state);
		if (problem !== undefined) return problem;
		return current === undefined
			? `No session sandbox; /sandbox <kind|name> makes or attaches one (kinds: ${sandboxes.kinds().join(", ") || "sbx is not set up"}).`
			: `This session's tools run in sandbox ${describe(current)}.`;
	}
	if (argument === "off") {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(SessionSandbox);
			delete doc.ref;
			delete doc.pending;
			delete doc.failed;
		}, context);
		return current === undefined ? "No session sandbox; tools run on this machine." : `Tools run on this machine again. ${kept(current)}`;
	}
	const target = parseSandboxArgument(argument, sandboxes.kinds(), options.sessionId);
	await markSessionSandboxPending(harness, target.name, target.kind, context);
	let ref: SandboxRef;
	try {
		if (target.kind === undefined) ref = await sandboxes.attach(target.name, options.cwd);
		else {
			if (current?.name !== target.name) {
				options.notice("info", `Getting sandbox ${target.name} (kind ${target.kind}) ready; prompts wait for it.`);
			}
			({ ref } = await sandboxes.ensure({
				name: target.name,
				kind: target.kind,
				repo: options.cwd,
				purpose: "session",
				// The session's current sandbox is never replaced, only reattached.
				owned: target.owned && current?.name !== target.name,
				onProgress: (message) => options.notice(/warning/iu.test(message) ? "warning" : "info", message),
			}));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(SessionSandbox);
			delete doc.pending;
			delete doc.ref;
			doc.failed = message;
		}, context);
		throw new Error(`${message}. Tools will not run until /sandbox <kind> succeeds or /sandbox off.`);
	}
	await harness.commit(async (tx) => {
		const doc = await tx.doc(SessionSandbox);
		delete doc.pending;
		delete doc.failed;
		doc.ref = ref;
	}, context);
	return (
		`This session's tools now run in sandbox ${describe(ref)}.` +
		(current !== undefined && current.name !== ref.name ? ` The previous one, ${kept(current)}` : "")
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

/** An artifact path inside the checkout, and where it lands locally; refuses paths that climb out of either. */
export function artifactPaths(path: string, remoteRoot: string, localRoot: string): { remote: string; local: string } {
	const parts = path.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
	if (isAbsolute(path) || path.startsWith("~") || parts.length === 0 || parts.includes("..")) {
		throw new Error(`artifact ${path} must be a relative path inside the checkout`);
	}
	const local = resolve(localRoot, ...parts);
	if (!local.startsWith(resolve(localRoot) + sep)) throw new Error(`artifact ${path} would land outside ${localRoot}`);
	return { remote: posix.join(remoteRoot, ...parts), local };
}

/** Extra time a command gets past its timeout before the local wait gives up on a sandbox that stopped answering. */
export const LOCAL_DEADLINE_GRACE_MS = 30_000;

/**
 * `sandbox_run`: one command in a fresh sandbox, its output streamed, artifacts downloaded, the sandbox removed unless
 * kept (also when the command fails or is cancelled, or anything after creating it fails). The name is deterministic,
 * so a rerun after a crash runs the command again in the sandbox the first run made rather than in a second one.
 */
export async function runInSandbox(
	sandboxes: Sandboxes,
	options: RunOptions,
): Promise<{ name: string; exitCode: number; artifacts: Artifact[]; removed: boolean; warnings: string[]; timedOut: boolean }> {
	const { ref, box, warnings } = await sandboxes.ensure({
		name: options.name,
		...(options.kind === undefined ? {} : { kind: options.kind }),
		...(options.repo === undefined ? {} : { repo: options.repo }),
		purpose: "session",
		owned: true,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
	});
	const artifacts: Artifact[] = [];
	let removed = false;
	const finish = async (): Promise<boolean> => {
		if (options.keep === true || removed) return removed;
		await sandboxes.providerOf(ref).remove(box);
		sandboxes.forget(box.name);
		removed = true;
		return true;
	};
	const local = new AbortController();
	const onAbort = () => local.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const deadline =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					local.abort(new Error("the sandbox stopped answering past the timeout"));
				}, options.timeoutMs + LOCAL_DEADLINE_GRACE_MS);
	try {
		const root = ref.workdir ?? ref.home;
		let exitCode: number;
		try {
			exitCode = (
				await box.exec(options.command, {
					cwd: root,
					capture: false,
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
					signal: local.signal,
					onStdout: (text) => options.onOutput?.(text),
					onStderr: (text) => options.onOutput?.(text),
				})
			).exitCode;
		} catch (error) {
			if (!timedOut) throw error;
			exitCode = 124;
		}
		for (const path of options.artifacts ?? []) {
			let paths: { remote: string; local: string };
			try {
				paths = artifactPaths(path, root, join(options.out, box.name));
			} catch (error) {
				artifacts.push({ remote: path, local: "", error: error instanceof Error ? error.message : String(error) });
				continue;
			}
			try {
				await box.download(paths.remote, paths.local, { ...(options.signal === undefined ? {} : { signal: options.signal }) });
				artifacts.push(paths);
			} catch (error) {
				artifacts.push({ ...paths, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { name: box.name, exitCode, artifacts, removed: await finish(), warnings, timedOut };
	} catch (error) {
		await finish().catch(() => undefined);
		throw error;
	} finally {
		if (deadline !== undefined) clearTimeout(deadline);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
