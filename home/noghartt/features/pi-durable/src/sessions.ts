import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "#pi/index.js";

/** Which session to open: a new one, the newest for the directory, or a given session directory. */
export type SessionTarget =
	| { readonly kind: "new" }
	| { readonly kind: "continue" }
	| { readonly kind: "open"; readonly directory: string };

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/**
 * What the session picker shows without opening the database, which another process may hold. Kept next to it in
 * `meta.json` and rewritten as the session changes; sessions without one show their directory's dates.
 */
export interface SessionMeta {
	cwd?: string;
	name?: string;
	firstMessage?: string;
	messageCount?: number;
	/** The conversation shown when the session was last left, reopened with it. */
	current?: number;
	modified?: string;
	/** Written by the process holding the session, for the dashboard; stale once the session is closed. */
	live?: LiveStatus;
}

/** What a session is doing, as its process last wrote it. */
export interface LiveStatus {
	pid: number;
	/** Some conversation has a run going. */
	busy: boolean;
	/** Conversations with a run going. */
	running: number;
	conversations: number;
	watchers: number;
	model?: string;
	cost: number;
	/** One line about the newest work: the running tool or the last answer. */
	activity?: string;
	updated: string;
}

/** A session as pi's session selector lists it; `path` is the session directory. */
export interface SessionListing {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	/** What its process last reported; meaningful only while the session is open. */
	live?: LiveStatus;
}

const SESSION_NAME = /^\d{13}-[0-9a-f-]{36}$/u;

function sessionsRoot(): string {
	return join(getAgentDir(), "experimental", "durable-sessions");
}

function cwdRoot(cwd: string): string {
	return join(sessionsRoot(), createHash("sha256").update(cwd).digest("hex").slice(0, 24));
}

export async function resolveCwd(cwd: string): Promise<string> {
	return realpath(resolve(cwd));
}

async function sessionDirs(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isDirectory() && SESSION_NAME.test(entry.name))
		.map((entry) => join(root, entry.name))
		.sort();
}

export async function readMeta(directory: string): Promise<SessionMeta> {
	try {
		return JSON.parse(await readFile(join(directory, "meta.json"), "utf-8")) as SessionMeta;
	} catch {
		return {};
	}
}

// Overlapping writers in one process (live status, current conversation, rename) would otherwise race on the
// read-merge-write, losing a patch or renaming a temp file another write already moved (ENOENT).
const metaWrites = new Map<string, Promise<void>>();

/** Merge `patch` into the session's `meta.json`, written atomically. */
export function writeMeta(directory: string, patch: SessionMeta): Promise<void> {
	const write = async (): Promise<void> => {
		const next = { ...(await readMeta(directory)), ...patch, modified: new Date().toISOString() };
		const temporary = join(directory, `meta.json.${process.pid}.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(next, null, "\t")}\n`);
		await rename(temporary, join(directory, "meta.json")).catch(async (error: unknown) => {
			await rm(temporary, { force: true });
			throw error;
		});
	};
	const queued = (metaWrites.get(directory) ?? Promise.resolve()).then(write, write);
	const tail = queued.catch(() => {});
	metaWrites.set(directory, tail);
	void tail.then(() => {
		if (metaWrites.get(directory) === tail) metaWrites.delete(directory);
	});
	return queued;
}

async function listing(directory: string, fallbackCwd: string): Promise<SessionListing> {
	const meta = await readMeta(directory);
	const info = await stat(directory);
	const created = new Date(Number(basename(directory).slice(0, 13)));
	return {
		path: directory,
		id: basename(directory),
		cwd: meta.cwd ?? fallbackCwd,
		...(meta.name === undefined ? {} : { name: meta.name }),
		created,
		modified: meta.modified === undefined ? info.mtime : new Date(meta.modified),
		messageCount: meta.messageCount ?? 0,
		// Sessions from before meta.json was written have no summary without opening their database.
		firstMessage: meta.firstMessage ?? (meta.cwd === undefined ? "(older session)" : "(no messages)"),
		allMessagesText: [meta.name, meta.firstMessage].filter(Boolean).join(" "),
		...(meta.live === undefined ? {} : { live: meta.live }),
	};
}

/** Whether a process holds the session (a crashed one's lock goes stale after 10 s). */
export async function isSessionOpen(directory: string): Promise<boolean> {
	return lockfile.check(directory, { realpath: false, stale: 10_000 }).catch(() => false);
}

/** Delete a session directory; only for one this process created and never wrote to. */
export async function removeSession(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

/** The sessions of one directory, newest first. */
export async function listSessions(cwd: string): Promise<SessionListing[]> {
	const dirs = await sessionDirs(cwdRoot(cwd));
	return (await Promise.all(dirs.map((dir) => listing(dir, cwd)))).reverse();
}

/** Every directory's sessions, newest first; a session without metadata shows no directory. */
export async function listAllSessions(): Promise<SessionListing[]> {
	const roots = await readdir(sessionsRoot(), { withFileTypes: true }).catch(() => []);
	const all: SessionListing[] = [];
	for (const root of roots) {
		if (!root.isDirectory()) continue;
		for (const dir of await sessionDirs(join(sessionsRoot(), root.name))) all.push(await listing(dir, ""));
	}
	return all.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

/** Open and lock the session `target` names for `cwdInput`. */
export async function selectSession(cwdInput: string, target: SessionTarget): Promise<SessionLocation> {
	let cwd = await resolveCwd(cwdInput);
	let directory: string;
	let created = false;
	if (target.kind === "open") {
		directory = target.directory;
		// A session from another directory runs there, as pi's /resume does.
		cwd = (await readMeta(directory)).cwd ?? cwd;
		if (dirname(directory) !== cwdRoot(cwd)) throw new Error(`Not a session of ${cwd}: ${directory}`);
	} else {
		const root = cwdRoot(cwd);
		await mkdir(root, { recursive: true });
		const newest = target.kind === "continue" ? (await sessionDirs(root)).at(-1) : undefined;
		if (target.kind === "continue" && newest === undefined) throw new Error(`No durable session exists for ${cwd}`);
		if (newest !== undefined) directory = newest;
		else {
			directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
			await mkdir(directory);
			created = true;
		}
	}

	let release: () => Promise<void>;
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	if (created) await writeMeta(directory, { cwd });
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
