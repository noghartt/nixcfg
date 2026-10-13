// Agent forum store and domain rules: threads, replies, votes, claims,
// subscriptions, and an event log whose sequence numbers are the long-poll
// cursor (a waiter never misses an event that lands between two waits).
import { Database } from "bun:sqlite";

export const KINDS = ["question", "help-wanted", "blocker", "announcement", "request", "discussion"] as const;
export const STATUSES = ["open", "claimed", "resolved"] as const;
export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
// Announcements and discussions have nothing to take on.
const CLAIMABLE = new Set<string>(["question", "help-wanted", "blocker", "request"]);

export const LIMITS = {
	title: 200,
	body: 16_000,
	resolution: 2_000,
	tags: 8,
	query: 200,
	listMax: 100,
	offsetMax: 10_000,
	waitMaxSeconds: 120,
	waitersPerAuthor: 8,
	waitersTotal: 256,
	eventsPerWait: 50,
};

const DAY_MS = 86_400_000;
export const RESOLVED_RETENTION_MS = 60 * DAY_MS;
// Cursors older than this just skip ahead; long-polls are minutes, not days.
const EVENT_RETENTION_MS = 7 * DAY_MS;

// <host>/<harness>/<session-or-run:node>
export const AUTHOR_RE = /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const TAG_RE = /^[a-z0-9][a-z0-9.+_-]{0,31}$/;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export function checkAuthor(value: unknown): string {
	if (typeof value !== "string" || !AUTHOR_RE.test(value)) {
		throw new HttpError(400, "author must look like <host>/<harness>/<session-or-run:node> (lowercase host and harness)");
	}
	return value;
}

// Keep newlines and tabs; every other C0/C1 control and lone surrogate goes.
function clean(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.toWellFormed()
		.trim();
}

function text(field: string, value: unknown, max: number, min = 1): string {
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const result = clean(value);
	if (result.length < min) throw new HttpError(400, `${field} is required`);
	if (result.length > max) throw new HttpError(413, `${field} exceeds ${max} characters`);
	return result;
}

function optionalText(field: string, value: unknown, max: number): string | null {
	if (value === undefined || value === null) return null;
	return text(field, value, max, 0) || null;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

export function checkTag(value: unknown): string {
	const tag = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (!TAG_RE.test(tag)) throw new HttpError(400, "tags are 1-32 chars of a-z, 0-9, '.', '+', '_', '-'");
	return tag;
}

function tags(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new HttpError(400, "tags must be an array of strings");
	const unique = [...new Set(value.map(checkTag))];
	if (unique.length > LIMITS.tags) throw new HttpError(413, `at most ${LIMITS.tags} tags`);
	return unique;
}

export function checkId(field: string, value: unknown): number {
	const id = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new HttpError(400, `${field} must be a positive integer`);
	return id;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "body must be a JSON object");
	return value as Record<string, unknown>;
}

interface ThreadRow {
	id: number;
	title: string;
	body: string;
	kind: Kind;
	status: Status;
	author: string;
	created_at: number;
	activity_at: number;
	claimed_by: string | null;
	claimed_at: number | null;
	resolved_by: string | null;
	resolved_at: number | null;
	resolution: string | null;
	accepted_reply: number | null;
	score: number;
	replies: number;
	tags: string | null;
}

interface ReplyRow {
	id: number;
	thread_id: number;
	author: string;
	body: string;
	created_at: number;
	score: number;
}

interface EventRow {
	seq: number;
	type: string;
	thread_id: number;
	reply_id: number | null;
	author: string;
	at: number;
}

export interface ThreadSummary {
	id: number;
	title: string;
	kind: Kind;
	status: Status;
	tags: string[];
	author: string;
	createdAt: string;
	activityAt: string;
	claimedBy: string | null;
	resolvedBy: string | null;
	score: number;
	replies: number;
	excerpt: string;
}

export interface Reply {
	id: number;
	thread: number;
	author: string;
	body: string;
	createdAt: string;
	score: number;
}

export interface ThreadDetail extends Omit<ThreadSummary, "excerpt"> {
	body: string;
	claimedAt: string | null;
	resolvedAt: string | null;
	resolution: string | null;
	acceptedReply: number | null;
	replyList: Reply[];
}

export interface ForumEvent {
	seq: number;
	type: string;
	at: string;
	author: string;
	thread: ThreadSummary;
	reply?: Reply;
}

export interface ListFilter {
	status?: Status | "unresolved";
	kind?: Kind;
	tag?: string;
	author?: string;
	claimedBy?: string;
	q?: string;
	sort?: "active" | "new" | "top" | "hot";
	limit?: number;
	offset?: number;
}

export type WaitScope = "thread" | "new" | "mine";
export interface WaitFilter {
	scope: WaitScope;
	thread?: number;
	kind?: Kind;
	tag?: string;
	since?: number;
}

export interface WaitResult {
	events: ForumEvent[];
	cursor: number;
	timedOut: boolean;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
	id INTEGER PRIMARY KEY,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	kind TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	author TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	activity_at INTEGER NOT NULL,
	claimed_by TEXT,
	claimed_at INTEGER,
	resolved_by TEXT,
	resolved_at INTEGER,
	resolution TEXT,
	accepted_reply INTEGER,
	score INTEGER NOT NULL DEFAULT 0,
	replies INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_activity ON threads (activity_at DESC);
CREATE INDEX IF NOT EXISTS threads_status ON threads (status, resolved_at);
CREATE TABLE IF NOT EXISTS thread_tags (
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	tag TEXT NOT NULL,
	PRIMARY KEY (thread_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_tags_tag ON thread_tags (tag);
CREATE TABLE IF NOT EXISTS replies (
	id INTEGER PRIMARY KEY,
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	score INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS replies_thread ON replies (thread_id, id);
CREATE TABLE IF NOT EXISTS thread_votes (
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	value INTEGER NOT NULL,
	PRIMARY KEY (thread_id, author)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS reply_votes (
	reply_id INTEGER NOT NULL REFERENCES replies (id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	value INTEGER NOT NULL,
	PRIMARY KEY (reply_id, author)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS subscriptions (
	author TEXT NOT NULL,
	thread_id INTEGER REFERENCES threads (id) ON DELETE CASCADE,
	tag TEXT,
	created_at INTEGER NOT NULL,
	CHECK ((thread_id IS NULL) <> (tag IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_thread ON subscriptions (author, thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_tag ON subscriptions (author, tag) WHERE tag IS NOT NULL;
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	type TEXT NOT NULL,
	thread_id INTEGER NOT NULL,
	reply_id INTEGER,
	author TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, seq);
`;

const THREAD_SELECT = `SELECT t.*, (SELECT group_concat(tag, ',') FROM thread_tags WHERE thread_id = t.id) AS tags FROM threads t`;

interface Waiter {
	author: string;
	check: () => void;
	cancel: () => void;
}

export interface ForumOptions {
	now?: () => number;
}

export class Forum {
	readonly db: Database;
	private readonly now: () => number;
	private readonly waiters = new Set<Waiter>();

	constructor(path: string, options: ForumOptions = {}) {
		this.now = options.now ?? Date.now;
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec(SCHEMA);
		this.db.exec("PRAGMA user_version = 1");
	}

	close(): void {
		for (const waiter of [...this.waiters]) waiter.cancel();
		this.db.close();
	}

	cursor(): number {
		return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
	}

	private event(type: string, thread: number, author: string, reply: number | null = null): void {
		this.db
			.query("INSERT INTO events (type, thread_id, reply_id, author, at) VALUES (?, ?, ?, ?, ?)")
			.run(type, thread, reply, author, this.now());
	}

	// Waiters re-query after the write transaction commits.
	private notify(): void {
		queueMicrotask(() => {
			for (const waiter of [...this.waiters]) waiter.check();
		});
	}

	private subscribe(author: string, thread: number): void {
		this.db
			.query("INSERT OR IGNORE INTO subscriptions (author, thread_id, created_at) VALUES (?, ?, ?)")
			.run(author, thread, this.now());
	}

	private row(id: number): ThreadRow {
		const row = this.db.query(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as ThreadRow | null;
		if (!row) throw new HttpError(404, `thread ${id} not found`);
		return row;
	}

	private summary(row: ThreadRow): ThreadSummary {
		return {
			id: row.id,
			title: row.title,
			kind: row.kind,
			status: row.status,
			tags: row.tags ? row.tags.split(",").sort() : [],
			author: row.author,
			createdAt: iso(row.created_at)!,
			activityAt: iso(row.activity_at)!,
			claimedBy: row.claimed_by,
			resolvedBy: row.resolved_by,
			score: row.score,
			replies: row.replies,
			excerpt: row.body.length > 280 ? `${row.body.slice(0, 279)}…` : row.body,
		};
	}

	private reply(row: ReplyRow): Reply {
		return { id: row.id, thread: row.thread_id, author: row.author, body: row.body, createdAt: iso(row.created_at)!, score: row.score };
	}

	thread(id: number): ThreadDetail {
		const row = this.row(id);
		const { excerpt: _excerpt, ...summary } = this.summary(row);
		const replies = this.db.query("SELECT * FROM replies WHERE thread_id = ? ORDER BY id").all(id) as ReplyRow[];
		return {
			...summary,
			body: row.body,
			claimedAt: iso(row.claimed_at),
			resolvedAt: iso(row.resolved_at),
			resolution: row.resolution,
			acceptedReply: row.accepted_reply,
			replyList: replies.map((reply) => this.reply(reply)),
		};
	}

	createThread(author: string, input: unknown): ThreadDetail {
		const body = object(input);
		const title = text("title", body.title, LIMITS.title).replace(/\s+/g, " ");
		const content = text("body", body.body ?? "", LIMITS.body, 0);
		const kind = oneOf("kind", body.kind ?? "question", KINDS);
		const tagList = tags(body.tags);
		const now = this.now();
		const id = this.db.transaction(() => {
			const { lastInsertRowid } = this.db
				.query("INSERT INTO threads (title, body, kind, author, created_at, activity_at) VALUES (?, ?, ?, ?, ?, ?)")
				.run(title, content, kind, author, now, now);
			const thread = Number(lastInsertRowid);
			const insertTag = this.db.query("INSERT INTO thread_tags (thread_id, tag) VALUES (?, ?)");
			for (const tag of tagList) insertTag.run(thread, tag);
			this.subscribe(author, thread);
			this.event("thread", thread, author);
			return thread;
		})();
		this.notify();
		return this.thread(id);
	}

	addReply(author: string, threadId: number, input: unknown): Reply {
		const content = text("body", object(input).body, LIMITS.body);
		this.row(threadId);
		const now = this.now();
		const id = this.db.transaction(() => {
			const { lastInsertRowid } = this.db
				.query("INSERT INTO replies (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)")
				.run(threadId, author, content, now);
			const reply = Number(lastInsertRowid);
			this.db.query("UPDATE threads SET replies = replies + 1, activity_at = ? WHERE id = ?").run(now, threadId);
			this.subscribe(author, threadId);
			this.event("reply", threadId, author, reply);
			return reply;
		})();
		this.notify();
		return this.reply(this.db.query("SELECT * FROM replies WHERE id = ?").get(id) as ReplyRow);
	}

	claim(author: string, threadId: number, input: unknown): ThreadDetail {
		const release = object(input ?? {}).release === true;
		const now = this.now();
		this.db.transaction(() => {
			const row = this.row(threadId);
			if (release) {
				if (row.claimed_by === null) return;
				if (row.claimed_by !== author && row.author !== author) {
					throw new HttpError(403, "only the claimant or the thread author can release a claim", { claimedBy: row.claimed_by });
				}
				this.db
					.query(
						"UPDATE threads SET claimed_by = NULL, claimed_at = NULL, status = CASE status WHEN 'claimed' THEN 'open' ELSE status END, activity_at = ? WHERE id = ?",
					)
					.run(now, threadId);
				this.event("release", threadId, author);
				return;
			}
			if (!CLAIMABLE.has(row.kind)) throw new HttpError(422, `${row.kind} threads cannot be claimed`);
			if (row.status === "resolved") throw new HttpError(409, "thread is already resolved");
			if (row.claimed_by === author) return;
			if (row.claimed_by !== null) {
				throw new HttpError(409, `already claimed by ${row.claimed_by}`, { claimedBy: row.claimed_by });
			}
			this.db
				.query("UPDATE threads SET claimed_by = ?, claimed_at = ?, status = 'claimed', activity_at = ? WHERE id = ?")
				.run(author, now, now, threadId);
			this.subscribe(author, threadId);
			this.event("claim", threadId, author);
		})();
		this.notify();
		return this.thread(threadId);
	}

	resolve(author: string, threadId: number, input: unknown): ThreadDetail {
		const body = object(input ?? {});
		const reopen = body.reopen === true;
		const resolution = optionalText("resolution", body.resolution, LIMITS.resolution);
		const accepted = body.reply === undefined || body.reply === null ? null : checkId("reply", body.reply);
		const now = this.now();
		this.db.transaction(() => {
			const row = this.row(threadId);
			if (row.author !== author && row.claimed_by !== author) {
				throw new HttpError(403, "only the thread author or the claimant can resolve or reopen it");
			}
			if (reopen) {
				if (row.status !== "resolved") return;
				this.db
					.query(
						"UPDATE threads SET status = CASE WHEN claimed_by IS NULL THEN 'open' ELSE 'claimed' END, resolved_by = NULL, resolved_at = NULL, activity_at = ? WHERE id = ?",
					)
					.run(now, threadId);
				this.event("reopen", threadId, author);
				return;
			}
			if (accepted !== null) {
				const owner = this.db.query("SELECT thread_id FROM replies WHERE id = ?").get(accepted) as { thread_id: number } | null;
				if (owner?.thread_id !== threadId) throw new HttpError(400, `reply ${accepted} is not on thread ${threadId}`);
			}
			this.db
				.query(
					"UPDATE threads SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = COALESCE(?, resolution), accepted_reply = COALESCE(?, accepted_reply), activity_at = ? WHERE id = ?",
				)
				.run(author, now, resolution, accepted, now, threadId);
			this.event("resolve", threadId, author);
		})();
		this.notify();
		return this.thread(threadId);
	}

	vote(author: string, target: "thread" | "reply", id: number, input: unknown): { score: number } {
		const value = object(input).value;
		if (value !== 1 && value !== -1 && value !== 0) throw new HttpError(400, "value must be 1, -1, or 0");
		const table = target === "thread" ? "thread_votes" : "reply_votes";
		const column = target === "thread" ? "thread_id" : "reply_id";
		const parent = target === "thread" ? "threads" : "replies";
		if (!this.db.query(`SELECT 1 FROM ${parent} WHERE id = ?`).get(id)) throw new HttpError(404, `${target} ${id} not found`);
		return this.db.transaction(() => {
			if (value === 0) this.db.query(`DELETE FROM ${table} WHERE ${column} = ? AND author = ?`).run(id, author);
			else {
				this.db
					.query(`INSERT INTO ${table} (${column}, author, value) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value`)
					.run(id, author, value);
			}
			this.db
				.query(`UPDATE ${parent} SET score = (SELECT COALESCE(SUM(value), 0) FROM ${table} WHERE ${column} = ?1) WHERE id = ?1`)
				.run(id);
			return this.db.query(`SELECT score FROM ${parent} WHERE id = ?`).get(id) as { score: number };
		})();
	}

	subscriptions(author: string): { threads: number[]; tags: string[] } {
		const rows = this.db
			.query("SELECT thread_id, tag FROM subscriptions WHERE author = ? ORDER BY created_at")
			.all(author) as { thread_id: number | null; tag: string | null }[];
		return {
			threads: rows.flatMap((row) => (row.thread_id === null ? [] : [row.thread_id])),
			tags: rows.flatMap((row) => (row.tag === null ? [] : [row.tag])),
		};
	}

	setSubscription(author: string, input: unknown, on: boolean): { threads: number[]; tags: string[] } {
		const body = object(input);
		const thread = body.thread === undefined ? null : checkId("thread", body.thread);
		const tag = body.tag === undefined ? null : checkTag(body.tag);
		if ((thread === null) === (tag === null)) throw new HttpError(400, "give exactly one of thread or tag");
		if (thread !== null) this.row(thread);
		if (on) {
			const count = (this.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE author = ?").get(author) as { n: number }).n;
			if (count >= 500) throw new HttpError(429, "subscription limit reached");
			this.db
				.query("INSERT OR IGNORE INTO subscriptions (author, thread_id, tag, created_at) VALUES (?, ?, ?, ?)")
				.run(author, thread, tag, this.now());
		} else if (thread !== null) {
			this.db.query("DELETE FROM subscriptions WHERE author = ? AND thread_id = ?").run(author, thread);
		} else {
			this.db.query("DELETE FROM subscriptions WHERE author = ? AND tag = ?").run(author, tag);
		}
		return this.subscriptions(author);
	}

	list(filter: ListFilter = {}): ThreadSummary[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.status === "unresolved") where.push("t.status <> 'resolved'");
		else if (filter.status) where.push("t.status = ?"), params.push(filter.status);
		if (filter.kind) where.push("t.kind = ?"), params.push(filter.kind);
		if (filter.author) where.push("t.author = ?"), params.push(filter.author);
		if (filter.claimedBy) where.push("t.claimed_by = ?"), params.push(filter.claimedBy);
		if (filter.tag) where.push("EXISTS (SELECT 1 FROM thread_tags x WHERE x.thread_id = t.id AND x.tag = ?)"), params.push(filter.tag);
		const terms = filter.q ? searchTerms(filter.q) : [];
		for (const term of terms) {
			where.push(
				"(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM replies r WHERE r.thread_id = t.id AND r.body LIKE ? ESCAPE '\\'))",
			);
			const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
			params.push(pattern, pattern, pattern);
		}
		const limit = Math.min(Math.max(filter.limit ?? 30, 1), LIMITS.listMax);
		const offset = Math.min(Math.max(filter.offset ?? 0, 0), LIMITS.offsetMax);
		const sort = filter.sort ?? (terms.length ? "hot" : "active");
		const order = { active: "t.activity_at DESC", new: "t.id DESC", top: "t.score DESC, t.activity_at DESC", hot: "t.activity_at DESC" }[sort];
		const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
		// Ranked sorts look at a bounded window of recent candidates.
		const ranked = sort === "hot";
		const rows = this.db
			.query(`${THREAD_SELECT}${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
			.all(...params, ranked ? 500 : limit, ranked ? 0 : offset) as ThreadRow[];
		if (!ranked) return rows.map((row) => this.summary(row));
		const now = this.now();
		const rank = (row: ThreadRow) => {
			const titleHits = terms.filter((term) => row.title.toLowerCase().includes(term.toLowerCase())).length;
			const hours = (now - row.activity_at) / 3_600_000;
			return titleHits * 10 + (1 + Math.max(row.score, 0) + row.replies) / (hours + 2) ** 1.5;
		};
		return rows
			.map((row) => ({ row, rank: rank(row) }))
			.sort((a, b) => b.rank - a.rank)
			.slice(offset, offset + limit)
			.map(({ row }) => this.summary(row));
	}

	events(author: string, filter: WaitFilter, since: number): EventRow[] {
		const where = ["e.seq > ?", "e.author <> ?"];
		const params: (string | number)[] = [since, author];
		if (filter.scope === "thread") {
			where.push("e.thread_id = ?");
			params.push(filter.thread!);
		} else if (filter.scope === "new") {
			where.push("e.type = 'thread'");
			if (filter.kind) where.push("t.kind = ?"), params.push(filter.kind);
			if (filter.tag) where.push("EXISTS (SELECT 1 FROM thread_tags x WHERE x.thread_id = t.id AND x.tag = ?)"), params.push(filter.tag);
		} else {
			where.push(`((e.type <> 'thread' AND e.thread_id IN (SELECT thread_id FROM subscriptions WHERE author = ? AND thread_id IS NOT NULL))
				OR (e.type = 'thread' AND EXISTS (SELECT 1 FROM thread_tags x JOIN subscriptions s ON s.tag = x.tag WHERE x.thread_id = t.id AND s.author = ?)))`);
			params.push(author, author);
		}
		return this.db
			.query(`SELECT e.* FROM events e JOIN threads t ON t.id = e.thread_id WHERE ${where.join(" AND ")} ORDER BY e.seq LIMIT ?`)
			.all(...params, LIMITS.eventsPerWait) as EventRow[];
	}

	private present(rows: EventRow[]): ForumEvent[] {
		return rows.map((row) => {
			const reply = row.reply_id === null ? null : (this.db.query("SELECT * FROM replies WHERE id = ?").get(row.reply_id) as ReplyRow | null);
			return {
				seq: row.seq,
				type: row.type,
				at: iso(row.at)!,
				author: row.author,
				thread: this.summary(this.row(row.thread_id)),
				...(reply ? { reply: this.reply(reply) } : {}),
			};
		});
	}

	// Resolves on the first matching event after `since`, or empty on timeout or abort.
	wait(author: string, filter: WaitFilter, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
		if (filter.scope === "thread") this.row(filter.thread!);
		const since = filter.since ?? this.cursor();
		const ready = this.events(author, filter, since);
		if (ready.length || timeoutMs <= 0 || signal?.aborted) {
			return Promise.resolve({ events: this.present(ready), cursor: ready.at(-1)?.seq ?? since, timedOut: !ready.length });
		}
		if (this.waiters.size >= LIMITS.waitersTotal) throw new HttpError(429, "too many waiters", { retryAfter: 5 });
		if ([...this.waiters].filter((w) => w.author === author).length >= LIMITS.waitersPerAuthor) {
			throw new HttpError(429, `at most ${LIMITS.waitersPerAuthor} concurrent waits per author`, { retryAfter: 5 });
		}
		return new Promise((resolve) => {
			let done = false;
			const finish = (rows: EventRow[]) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiters.delete(waiter);
				const events = this.present(rows);
				resolve({ events, cursor: events.at(-1)?.seq ?? since, timedOut: !events.length });
			};
			const waiter: Waiter = {
				author,
				check: () => {
					const rows = this.events(author, filter, since);
					if (rows.length) finish(rows);
				},
				cancel: () => finish([]),
			};
			const onAbort = () => finish([]);
			const timer = setTimeout(onAbort, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.add(waiter);
		});
	}

	prune(): { threads: number; events: number } {
		const now = this.now();
		return this.db.transaction(() => {
			const cutoff = now - RESOLVED_RETENTION_MS;
			// Counted up front: the statement's change count includes cascaded rows.
			const { threads } = this.db
				.query("SELECT COUNT(*) AS threads FROM threads WHERE status = 'resolved' AND resolved_at < ?")
				.get(cutoff) as { threads: number };
			this.db.query("DELETE FROM threads WHERE status = 'resolved' AND resolved_at < ?").run(cutoff);
			const events = this.db
				.query("DELETE FROM events WHERE at < ? OR thread_id NOT IN (SELECT id FROM threads)")
				.run(now - EVENT_RETENTION_MS).changes;
			return { threads, events };
		})();
	}
}

export function searchTerms(query: string): string[] {
	const q = clean(query);
	if (!q) throw new HttpError(400, "q is required");
	if (q.length > LIMITS.query) throw new HttpError(413, `q exceeds ${LIMITS.query} characters`);
	return [...new Set(q.split(/\s+/))].slice(0, 8);
}

export { oneOf };
