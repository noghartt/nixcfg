// HTTP surface of the forum. The tailnet is the trust boundary, so identity is
// the client's X-Forum-Author header; everything else is validated, bounded,
// and rate limited per author (per address for anonymous reads).
import {
	checkAuthor,
	checkId,
	checkTag,
	Forum,
	HttpError,
	KINDS,
	LIMITS,
	type ListFilter,
	oneOf,
	STATUSES,
	type WaitFilter,
} from "./forum.ts";
import { renderIndex, renderThread } from "./html.ts";

export const MAX_REQUEST_BYTES = 64 * 1024;

export interface RateOptions {
	writeBurst: number;
	writePerSecond: number;
	readBurst: number;
	readPerSecond: number;
}

const DEFAULT_RATES: RateOptions = { writeBurst: 30, writePerSecond: 0.5, readBurst: 240, readPerSecond: 4 };

class Buckets {
	private readonly buckets = new Map<string, { tokens: number; at: number }>();

	constructor(
		private readonly burst: number,
		private readonly perSecond: number,
		private readonly now: () => number,
	) {}

	// Seconds until a token is available; 0 means the call may proceed.
	take(key: string): number {
		const now = this.now();
		if (this.buckets.size > 10_000) {
			for (const [k, b] of this.buckets) if (now - b.at > (this.burst / this.perSecond) * 1000) this.buckets.delete(k);
		}
		const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
		bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
		bucket.at = now;
		this.buckets.set(key, bucket);
		if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / this.perSecond);
		bucket.tokens -= 1;
		return 0;
	}
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
// Inline styles only; no scripts, frames, or remote loads.
const HTML_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

async function readJson(req: Request): Promise<unknown> {
	// A browser cannot send application/json cross-origin without a CORS
	// preflight this server never answers, so pages on the tailnet cannot post.
	if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "content-type must be application/json");
	}
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_REQUEST_BYTES) throw new HttpError(413, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (req.body) {
		for await (const chunk of req.body) {
			size += chunk.byteLength;
			if (size > MAX_REQUEST_BYTES) throw new HttpError(413, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
			chunks.push(chunk);
		}
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "body is not valid JSON");
	}
}

function intParam(params: URLSearchParams, name: string): number | undefined {
	const value = params.get(name);
	if (value === null || value === "") return undefined;
	if (!/^\d{1,6}$/.test(value)) throw new HttpError(400, `${name} must be a non-negative integer`);
	return Number(value);
}

export function listFilter(params: URLSearchParams): ListFilter {
	const filter: ListFilter = {};
	const status = params.get("status");
	if (status) filter.status = oneOf("status", status, [...STATUSES, "unresolved"] as const);
	const kind = params.get("kind");
	if (kind) filter.kind = oneOf("kind", kind, KINDS);
	const tag = params.get("tag");
	if (tag) filter.tag = checkTag(tag);
	const author = params.get("author");
	if (author) filter.author = checkAuthor(author);
	const claimedBy = params.get("claimed_by");
	if (claimedBy) filter.claimedBy = checkAuthor(claimedBy);
	const sort = params.get("sort");
	if (sort) filter.sort = oneOf("sort", sort, ["active", "new", "top", "hot"] as const);
	const q = params.get("q");
	if (q !== null) filter.q = q;
	filter.limit = intParam(params, "limit");
	filter.offset = intParam(params, "offset");
	return filter;
}

function waitFilter(params: URLSearchParams): WaitFilter {
	const thread = params.get("thread");
	const scope = oneOf("scope", params.get("scope") ?? (thread ? "thread" : "new"), ["thread", "new", "mine"] as const);
	const filter: WaitFilter = { scope };
	if (scope === "thread") filter.thread = checkId("thread", thread);
	const kind = params.get("kind");
	if (kind) filter.kind = oneOf("kind", kind, KINDS);
	const tag = params.get("tag");
	if (tag) filter.tag = checkTag(tag);
	const since = params.get("since");
	if (since !== null && since !== "") {
		if (!/^\d{1,15}$/.test(since)) throw new HttpError(400, "since must be a non-negative integer cursor");
		filter.since = Number(since);
	}
	return filter;
}

function waitTimeoutMs(params: URLSearchParams): number {
	const raw = params.get("timeout") ?? "60";
	const seconds = Number(raw);
	if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(seconds)) throw new HttpError(400, "timeout must be seconds");
	return Math.min(seconds, LIMITS.waitMaxSeconds) * 1000;
}

export interface Handler {
	fetch(req: Request, server?: { requestIP(req: Request): { address: string } | null }): Promise<Response>;
}

export function createHandler(forum: Forum, rates: Partial<RateOptions> = {}, now: () => number = Date.now): Handler {
	const r = { ...DEFAULT_RATES, ...rates };
	const writes = new Buckets(r.writeBurst, r.writePerSecond, now);
	const reads = new Buckets(r.readBurst, r.readPerSecond, now);

	const limit = (buckets: Buckets, key: string) => {
		const retryAfter = buckets.take(key);
		if (retryAfter) throw new HttpError(429, "rate limit exceeded", { retryAfter });
	};

	async function route(req: Request, url: URL, client: string): Promise<Response> {
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const method = req.method;
		const header = req.headers.get("x-forum-author");
		const author = header === null ? null : checkAuthor(header);
		const requireAuthor = () => {
			if (!author) throw new HttpError(401, "X-Forum-Author header is required (<host>/<harness>/<session-or-run:node>)");
			return author;
		};
		const reading = method === "GET" || method === "HEAD";
		if (reading) limit(reads, author ?? `ip:${client}`);
		else limit(writes, requireAuthor());

		if (path === "/" && reading) {
			return new Response(renderIndex(forum.list(listFilter(url.searchParams)), url.searchParams), { headers: HTML_HEADERS });
		}
		const page = path.match(/^\/t\/(\d+)$/);
		if (page && reading) return new Response(renderThread(forum.thread(checkId("thread", page[1]))), { headers: HTML_HEADERS });
		if (path === "/api/health" && reading) return json(200, { ok: true, cursor: forum.cursor() });

		if (path === "/api/threads") {
			if (reading) return json(200, { threads: forum.list(listFilter(url.searchParams)) });
			if (method === "POST") return json(201, { thread: forum.createThread(requireAuthor(), await readJson(req)) });
		}
		if (path === "/api/search" && reading) {
			const filter = listFilter(url.searchParams);
			if (!filter.q) throw new HttpError(400, "q is required");
			return json(200, { threads: forum.list(filter) });
		}
		if (path === "/api/wait" && reading) {
			const result = await forum.wait(requireAuthor(), waitFilter(url.searchParams), waitTimeoutMs(url.searchParams), req.signal);
			return json(200, result);
		}
		if (path === "/api/subscriptions") {
			if (reading) return json(200, forum.subscriptions(requireAuthor()));
			if (method === "POST") return json(200, forum.setSubscription(requireAuthor(), await readJson(req), true));
			if (method === "DELETE") return json(200, forum.setSubscription(requireAuthor(), await readJson(req), false));
		}

		const thread = path.match(/^\/api\/threads\/(\d+)(?:\/(replies|claim|resolve|vote))?$/);
		if (thread) {
			const id = checkId("thread", thread[1]);
			const action = thread[2];
			if (!action && reading) return json(200, { thread: forum.thread(id) });
			if (method === "POST") {
				const who = requireAuthor();
				const body = await readJson(req);
				if (action === "replies") return json(201, { reply: forum.addReply(who, id, body) });
				if (action === "claim") return json(200, { thread: forum.claim(who, id, body) });
				if (action === "resolve") return json(200, { thread: forum.resolve(who, id, body) });
				if (action === "vote") return json(200, forum.vote(who, "thread", id, body));
			}
		}
		const replyVote = path.match(/^\/api\/replies\/(\d+)\/vote$/);
		if (replyVote && method === "POST") {
			return json(200, forum.vote(requireAuthor(), "reply", checkId("reply", replyVote[1]), await readJson(req)));
		}
		if (path.startsWith("/api/") || path === "/" || page) throw new HttpError(405, `${method} not allowed on ${path}`);
		throw new HttpError(404, "not found");
	}

	return {
		async fetch(req, server) {
			const url = new URL(req.url);
			const client = server?.requestIP(req)?.address ?? "unknown";
			try {
				return await route(req, url, client);
			} catch (error) {
				if (error instanceof HttpError) {
					const headers: Record<string, string> = {};
					if (typeof error.extra.retryAfter === "number") headers["retry-after"] = String(error.extra.retryAfter);
					return json(error.status, { error: error.message, ...error.extra }, headers);
				}
				console.error(`agent-forum: ${req.method} ${url.pathname}:`, error);
				return json(500, { error: "internal error" });
			}
		},
	};
}
