import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Invocation, operands, type Segment, type Word } from "./shell.ts";

export type Verdict =
	| { kind: "allow"; why: string }
	| { kind: "self"; why: string }
	| { kind: "unresolved"; why: string; confirmOnly?: boolean; facts?: Record<string, unknown> };

export interface Process {
	pid: number;
	ppid: number;
	startedAt: number;
	command: string;
}

export interface ProcessView {
	self: Set<number>;
	descendants: Set<number>;
	table: Map<number, Process>;
}

export interface Facts {
	home: string;
	tmpRoots: string[];
	protectedRoots: string[];
	sessionFiles: ReadonlySet<string>;
	sessionStartedAt: number;
}

// Harness and terminal state that lives under the temp roots; deleting it can
// break the running session, so it is never auto-approved.
const HARNESS_TMP_PREFIXES = /^(?:senpi|omo|pi-orch|herdr|tmux|nix-|com\.apple|launchd|ssh-|\.X)/i;

export function isWithin(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export async function canonicalize(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return resolve(path);
		return join(await canonicalize(parent), basename(path));
	}
}

export async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		return (error as { code?: string }).code !== "ENOENT";
	}
}

export async function buildFacts(sessionFiles: ReadonlySet<string>, sessionStartedAt: number, guardDir: string): Promise<Facts> {
	const home = homedir();
	const tmpRoots = [...new Set(await Promise.all([tmpdir(), process.env.TMPDIR ?? tmpdir(), "/tmp", "/var/tmp"].map(canonicalize)))];
	// Both spellings: Home Manager links some of these files into /nix/store, so a
	// canonical path alone would miss `~/.pi/agent/settings.json`.
	const lexicalRoots = [".pi", ".omo", ".claude", ".codex", ".config/opnix", ".ssh", ".gnupg"].map((dir) => join(home, dir));
	lexicalRoots.push(guardDir);
	const protectedRoots = [...new Set([...lexicalRoots, ...(await Promise.all(lexicalRoots.map(canonicalize)))])];
	return { home: await canonicalize(home), tmpRoots, protectedRoots, sessionFiles, sessionStartedAt };
}

function expandHome(text: string, home: string): string {
	return text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
}

export function isProtected(path: string, facts: Facts): boolean {
	return facts.protectedRoots.some((root) => isWithin(root, path)) && !path.split(sep).includes("sessions");
}

function tmpChild(path: string, facts: Facts): string | undefined {
	for (const root of facts.tmpRoots) {
		if (path !== root && isWithin(root, path)) return relative(root, path).split(sep)[0];
	}
	return undefined;
}

// The operand itself is what rm removes, so a symlink operand is resolved only
// through its parent; a trailing slash makes rm follow the link.
async function operandPath(text: string, cwd: string, home: string): Promise<string> {
	const absolute = resolve(cwd, expandHome(text, home));
	return text.endsWith("/") ? canonicalize(absolute) : join(await canonicalize(dirname(absolute)), basename(absolute));
}

export async function resolvePath(text: string, cwd: string, home: string): Promise<string> {
	return canonicalize(resolve(cwd, expandHome(text, home)));
}

async function protectedTarget(text: string, cwd: string, facts: Facts, operand: boolean): Promise<boolean> {
	const lexical = resolve(cwd, expandHome(text, facts.home));
	const canonical = operand ? await operandPath(text, cwd, facts.home) : await canonicalize(lexical);
	return isProtected(lexical, facts) || isProtected(canonical, facts);
}

const DELETE_LIKE = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "mv", "chmod", "chown", "chgrp"]);
const COPY_LIKE = new Set(["cp", "install", "rsync", "ln"]);

export async function selfHarm(segment: Segment, invocation: Invocation | undefined, cwd: string, facts: Facts): Promise<string | undefined> {
	for (const target of segment.redirects) {
		if (await protectedTarget(target, cwd, facts, false)) return `redirects output into ${target}`;
	}
	if (!invocation) return undefined;
	const { name, args } = invocation;
	if ((name === "pi" || name === "omo") && /^(?:install|remove|uninstall|config|update)$/.test(args[0]?.text ?? "")) {
		return `changes the agent harness's own extensions or settings (${name} ${args[0].text})`;
	}
	const inPlace = (name === "sed" || name === "perl") && args.some((arg) => /^-[a-zA-Z]*i/.test(arg.text));
	const targets = DELETE_LIKE.has(name) || inPlace || name === "tee"
		? operands(args)
		: COPY_LIKE.has(name)
			? operands(args).slice(-1)
			: [];
	for (const target of targets) {
		const path = await operandPath(target.text, cwd, facts.home);
		if (await protectedTarget(target.text, cwd, facts, true)) return `${name} would modify the agent's own configuration or credentials (${target.text})`;
		if (DELETE_LIKE.has(name) && (path === facts.home || path === "/")) return `${name} targets ${path}`;
	}
	return undefined;
}

async function globVerdict(word: Word, cwd: string, facts: Facts): Promise<Verdict> {
	const text = expandHome(word.text, facts.home);
	if (text.split("/").includes("..") || text.endsWith("/")) return { kind: "unresolved", why: `glob ${word.text} is not confined` };
	const literal = text.slice(0, text.search(/[*?[{]/));
	const directory = literal.endsWith("/") ? literal : dirname(literal) + "/";
	const partial = literal.endsWith("/") ? "" : basename(literal);
	const base = await canonicalize(resolve(cwd, directory || "."));
	const child = tmpChild(join(base, "x"), facts);
	if (child === undefined) return { kind: "unresolved", why: `glob ${word.text} is outside the temp directories` };
	const atRoot = facts.tmpRoots.includes(base);
	if (atRoot && (!partial || HARNESS_TMP_PREFIXES.test(partial))) {
		return { kind: "unresolved", why: `glob ${word.text} could match shared or harness temp state` };
	}
	if (!atRoot && HARNESS_TMP_PREFIXES.test(child)) return { kind: "unresolved", why: `${word.text} is harness temp state` };
	return { kind: "allow", why: `glob confined to a temp directory (${word.text})` };
}

export async function deletionVerdict(invocation: Invocation, cwd: string, facts: Facts, repoRoot?: string): Promise<Verdict> {
	if (invocation.stdinArgs) return { kind: "unresolved", why: "deletion targets come from stdin" };
	if (invocation.name === "shred") return { kind: "unresolved", why: "shred overwrites data irrecoverably", confirmOnly: true };
	const targets = operands(invocation.args);
	const reasons: string[] = [];
	const unresolved: string[] = [];
	let confirmOnly = false;
	for (const target of targets) {
		if (target.glob) {
			const verdict = await globVerdict(target, cwd, facts);
			if (verdict.kind === "allow") reasons.push(verdict.why);
			else unresolved.push(verdict.why);
			continue;
		}
		const path = await operandPath(target.text, cwd, facts.home);
		if (repoRoot && (path === repoRoot || path === join(repoRoot, ".git") || isWithin(join(repoRoot, ".git"), path))) {
			unresolved.push(`${target.text} is the repository root or its .git`);
			confirmOnly = true;
			continue;
		}
		const child = tmpChild(path, facts);
		if (child !== undefined && !HARNESS_TMP_PREFIXES.test(child)) reasons.push(`${target.text} is inside a temp directory`);
		else if (facts.sessionFiles.has(path)) reasons.push(`${target.text} was created by this session`);
		else unresolved.push(`${target.text} is neither temporary nor created by this session`);
	}
	if (unresolved.length) {
		return { kind: "unresolved", why: unresolved.join("; "), confirmOnly, facts: { targets: targets.map((t) => t.text) } };
	}
	return { kind: "allow", why: reasons.join("; ") || "no operands" };
}

const SIGNAL_OPTIONS = new Set(["-s", "-n", "--signal"]);

async function pidsFor(invocation: Invocation, exec: Exec): Promise<number[] | undefined> {
	const { name, args } = invocation;
	if (name === "kill") {
		const pids: number[] = [];
		for (const target of operands(args, SIGNAL_OPTIONS)) {
			if (/^%\d*$/.test(target.text)) continue;
			if (!/^\d+$/.test(target.text)) return undefined;
			pids.push(Number(target.text));
		}
		if (args.some((arg) => arg.text === "-l" || arg.text === "-L")) return [];
		return pids;
	}
	const pgrepArgs: string[] = [];
	let pattern: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const text = args[index].text;
		if (text === "-f") pgrepArgs.push("-f");
		else if (text === "-x") pgrepArgs.push("-x");
		else if (text === "-s" || text === "--signal" || text === "-signal") index++;
		else if (/^-(?:\d+|[A-Z][A-Z0-9]*)$/.test(text)) continue;
		else if (text.startsWith("-")) return undefined;
		else if (pattern === undefined) pattern = text;
		else return undefined;
	}
	if (pattern === undefined) return undefined;
	if (name === "killall" && !pgrepArgs.includes("-x")) pgrepArgs.push("-x");
	const result = await exec("pgrep", [...pgrepArgs, pattern]);
	if (result.code > 1) return undefined;
	return result.stdout.split("\n").filter(Boolean).map(Number);
}

export type Exec = (command: string, args: string[]) => Promise<{ stdout: string; code: number }>;

function parseElapsed(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	const parts = clock.split(":").map(Number);
	while (parts.length < 3) parts.unshift(0);
	return ((Number(days) * 24 + parts[0]) * 60 + parts[1]) * 60 + parts[2];
}

export async function processView(exec: Exec): Promise<ProcessView | undefined> {
	const result = await exec("ps", ["-A", "-o", "pid=,ppid=,etime=,command="]);
	if (result.code !== 0) return undefined;
	const now = Date.now();
	const table = new Map<number, Process>();
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		table.set(pid, { pid, ppid: Number(match[2]), startedAt: now - parseElapsed(match[3]) * 1000, command: match[4] });
	}
	const self = new Set<number>();
	for (let pid: number | undefined = process.pid; pid && !self.has(pid); pid = table.get(pid)?.ppid) self.add(pid);
	self.add(0);
	self.add(1);
	const children = new Map<number, number[]>();
	for (const entry of table.values()) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
	const descendants = new Set<number>();
	const queue = [...(children.get(process.pid) ?? [])];
	while (queue.length) {
		const pid = queue.pop()!;
		if (descendants.has(pid)) continue;
		descendants.add(pid);
		queue.push(...(children.get(pid) ?? []));
	}
	return { self, descendants, table };
}

export async function terminationVerdict(invocation: Invocation, exec: Exec, facts: Facts): Promise<Verdict> {
	if (invocation.stdinArgs) return { kind: "unresolved", why: "process targets come from stdin" };
	if (invocation.name === "kill" && operands(invocation.args, SIGNAL_OPTIONS).some((arg) => /^-\d+$/.test(arg.text))) {
		return { kind: "self", why: "kill of a whole process group" };
	}
	const [pids, view] = await Promise.all([pidsFor(invocation, exec), processView(exec)]);
	if (!pids || !view) return { kind: "unresolved", why: "could not resolve which processes this targets" };
	const own = pids.filter((pid) => view.self.has(pid));
	if (own.length) {
		const names = own.map((pid) => `${pid} ${view.table.get(pid)?.command.slice(0, 60) ?? ""}`.trim());
		return { kind: "self", why: `would stop the agent itself or its parents (${names.join(", ")})` };
	}
	const foreign = pids.filter((pid) => !view.descendants.has(pid));
	if (!foreign.length) return { kind: "allow", why: pids.length ? `only processes this session started (${pids.join(", ")})` : "matches no process" };
	return {
		kind: "unresolved",
		why: `targets processes this session did not start (${foreign.join(", ")})`,
		facts: {
			processes: foreign.map((pid) => {
				const entry = view.table.get(pid);
				return {
					pid,
					command: entry?.command.slice(0, 200) ?? "(gone)",
					started_during_session: entry ? entry.startedAt >= facts.sessionStartedAt : false,
				};
			}),
		},
	};
}
