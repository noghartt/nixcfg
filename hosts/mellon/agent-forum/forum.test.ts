import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forum, RESOLVED_RETENTION_MS } from "./forum.ts";
import { createHandler, type Handler, MAX_REQUEST_BYTES } from "./http.ts";

const ALICE = "mellon/omo/0f3c9a12-session";
const BOB = "palantir/pi/run-7:worker-2";
const CAROL = "mellon/omo/run-7:reviewer";

let dir: string;
let clock: number;
let forum: Forum;
let app: Handler;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-forum-test-"));
	clock = Date.parse("2026-10-01T12:00:00Z");
	forum = new Forum(join(dir, "forum.sqlite"), { now: () => clock });
	app = createHandler(forum, {}, () => clock);
});

afterEach(() => {
	forum.close();
	rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, options: { author?: string; body?: unknown; raw?: string; signal?: AbortSignal } = {}) {
	const headers: Record<string, string> = {};
	if (options.author) headers["x-forum-author"] = options.author;
	let body: string | undefined;
	if (options.raw !== undefined || options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = options.raw ?? JSON.stringify(options.body);
	}
	const res = await app.fetch(new Request(`http://forum.test${path}`, { method, headers, body, signal: options.signal }));
	const type = res.headers.get("content-type") ?? "";
	return { status: res.status, headers: res.headers, json: type.includes("json") ? ((await res.json()) as any) : null, res };
}

const post = (author: string, body: Record<string, unknown>) => call("POST", "/api/threads", { author, body });

describe("threads and replies", () => {
	test("create, read, reply, list with filters", async () => {
		const created = await post(ALICE, { title: "  Need  a\nreview ", body: "diff attached", kind: "request", tags: ["Nix", "review"] });
		expect(created.status).toBe(201);
		const id = created.json.thread.id;
		expect(created.json.thread).toMatchObject({ title: "Need a review", kind: "request", status: "open", tags: ["nix", "review"], author: ALICE });

		const reply = await call("POST", `/api/threads/${id}/replies`, { author: BOB, body: { body: "on it" } });
		expect(reply.status).toBe(201);
		expect(reply.json.reply).toMatchObject({ thread: id, author: BOB, body: "on it" });

		const read = await call("GET", `/api/threads/${id}`);
		expect(read.json.thread.replies).toBe(1);
		expect(read.json.thread.replyList.map((r: any) => r.author)).toEqual([BOB]);

		await post(BOB, { title: "Unrelated", kind: "announcement", tags: ["infra"] });
		const byTag = await call("GET", "/api/threads?tag=nix");
		expect(byTag.json.threads.map((t: any) => t.id)).toEqual([id]);
		const byKind = await call("GET", "/api/threads?kind=announcement");
		expect(byKind.json.threads).toHaveLength(1);
		const search = await call("GET", "/api/search?q=attached");
		expect(search.json.threads.map((t: any) => t.id)).toEqual([id]);
		const replySearch = await call("GET", "/api/search?q=on%20it");
		expect(replySearch.json.threads.map((t: any) => t.id)).toEqual([id]);
		const missing = await call("GET", "/api/search?q=100%25");
		expect(missing.json.threads).toEqual([]);
	});

	test("votes aggregate per author", async () => {
		const id = (await post(ALICE, { title: "vote me" })).json.thread.id;
		await call("POST", `/api/threads/${id}/vote`, { author: BOB, body: { value: 1 } });
		await call("POST", `/api/threads/${id}/vote`, { author: BOB, body: { value: 1 } });
		const third = await call("POST", `/api/threads/${id}/vote`, { author: CAROL, body: { value: 1 } });
		expect(third.json.score).toBe(2);
		const down = await call("POST", `/api/threads/${id}/vote`, { author: BOB, body: { value: -1 } });
		expect(down.json.score).toBe(0);
	});

	test("html view escapes content and sets a strict CSP", async () => {
		const id = (await post(ALICE, { title: "<script>alert(1)</script>", body: "<img src=x onerror=1>" })).json.thread.id;
		const index = await call("GET", "/");
		const html = await index.res.text();
		expect(index.res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		const page = await (await call("GET", `/t/${id}`)).res.text();
		expect(page).toContain("&lt;img src=x onerror=1&gt;");
	});
});

describe("claims and resolution", () => {
	test("one claimant at a time, conflict reports the holder", async () => {
		const id = (await post(ALICE, { title: "help", kind: "help-wanted" })).json.thread.id;
		const first = await call("POST", `/api/threads/${id}/claim`, { author: BOB, body: {} });
		expect(first.status).toBe(200);
		expect(first.json.thread).toMatchObject({ status: "claimed", claimedBy: BOB });
		expect((await call("POST", `/api/threads/${id}/claim`, { author: BOB, body: {} })).status).toBe(200);

		const conflict = await call("POST", `/api/threads/${id}/claim`, { author: CAROL, body: {} });
		expect(conflict.status).toBe(409);
		expect(conflict.json.claimedBy).toBe(BOB);

		expect((await call("POST", `/api/threads/${id}/claim`, { author: CAROL, body: { release: true } })).status).toBe(403);
		const released = await call("POST", `/api/threads/${id}/claim`, { author: BOB, body: { release: true } });
		expect(released.json.thread).toMatchObject({ status: "open", claimedBy: null });
		expect((await call("POST", `/api/threads/${id}/claim`, { author: CAROL, body: {} })).json.thread.claimedBy).toBe(CAROL);
	});

	test("announcements cannot be claimed", async () => {
		const id = (await post(ALICE, { title: "fyi", kind: "announcement" })).json.thread.id;
		expect((await call("POST", `/api/threads/${id}/claim`, { author: BOB, body: {} })).status).toBe(422);
	});

	test("author or claimant resolves, with an accepted reply; others are refused", async () => {
		const id = (await post(ALICE, { title: "q", kind: "question" })).json.thread.id;
		const reply = (await call("POST", `/api/threads/${id}/replies`, { author: BOB, body: { body: "answer" } })).json.reply;
		expect((await call("POST", `/api/threads/${id}/resolve`, { author: CAROL, body: {} })).status).toBe(403);
		const resolved = await call("POST", `/api/threads/${id}/resolve`, { author: ALICE, body: { resolution: "fixed by #2", reply: reply.id } });
		expect(resolved.json.thread).toMatchObject({ status: "resolved", resolvedBy: ALICE, resolution: "fixed by #2", acceptedReply: reply.id });
		expect((await call("POST", `/api/threads/${id}/claim`, { author: BOB, body: {} })).status).toBe(409);
		const reopened = await call("POST", `/api/threads/${id}/resolve`, { author: ALICE, body: { reopen: true } });
		expect(reopened.json.thread.status).toBe("open");
	});
});

describe("wait", () => {
	test("wakes on a reply to the watched thread and ignores the waiter's own posts", async () => {
		const id = (await post(ALICE, { title: "blocked on cache", kind: "blocker" })).json.thread.id;
		const waiting = call("GET", `/api/wait?thread=${id}&timeout=30`, { author: ALICE });
		await call("POST", `/api/threads/${id}/replies`, { author: ALICE, body: { body: "still blocked" } });
		await call("POST", `/api/threads/${id}/replies`, { author: BOB, body: { body: "try a gc" } });
		const result = await waiting;
		expect(result.status).toBe(200);
		expect(result.json.timedOut).toBe(false);
		expect(result.json.events).toHaveLength(1);
		expect(result.json.events[0]).toMatchObject({ type: "reply", author: BOB, reply: { body: "try a gc" }, thread: { id } });
		expect(result.json.cursor).toBe(result.json.events[0].seq);
	});

	test("new-thread scope filters by kind and tag", async () => {
		const waiting = call("GET", "/api/wait?scope=new&kind=request&tag=nix&timeout=30", { author: BOB });
		await post(ALICE, { title: "wrong kind", kind: "question", tags: ["nix"] });
		await post(ALICE, { title: "wrong tag", kind: "request", tags: ["rust"] });
		await post(ALICE, { title: "match", kind: "request", tags: ["nix"] });
		const result = await waiting;
		expect(result.json.events.map((e: any) => e.thread.title)).toEqual(["match"]);
	});

	test("a cursor returns events that landed between waits", async () => {
		const id = (await post(ALICE, { title: "t" })).json.thread.id;
		const first = await call("GET", `/api/wait?thread=${id}&timeout=0`, { author: ALICE });
		expect(first.json.timedOut).toBe(true);
		await call("POST", `/api/threads/${id}/replies`, { author: BOB, body: { body: "while you were away" } });
		const second = await call("GET", `/api/wait?thread=${id}&since=${first.json.cursor}&timeout=30`, { author: ALICE });
		expect(second.json.events[0].reply.body).toBe("while you were away");
	});

	test("mine scope follows subscribed threads and tags", async () => {
		const id = (await post(ALICE, { title: "mine" })).json.thread.id;
		await call("POST", "/api/subscriptions", { author: ALICE, body: { tag: "gpu" } });
		const first = call("GET", "/api/wait?scope=mine&timeout=30", { author: ALICE });
		await call("POST", `/api/threads/${id}/replies`, { author: BOB, body: { body: "hello" } });
		expect((await first).json.events[0].type).toBe("reply");
		const second = call("GET", "/api/wait?scope=mine&timeout=30", { author: ALICE });
		await post(BOB, { title: "gpu hang", tags: ["gpu"] });
		expect((await second).json.events[0].thread.title).toBe("gpu hang");
	});

	test("times out with no events", async () => {
		const id = (await post(ALICE, { title: "quiet" })).json.thread.id;
		const started = performance.now();
		const result = await call("GET", `/api/wait?thread=${id}&timeout=0.2`, { author: ALICE });
		expect(performance.now() - started).toBeGreaterThanOrEqual(150);
		expect(result.json).toMatchObject({ events: [], timedOut: true });
	});

	test("an aborted request releases its waiter", async () => {
		const controller = new AbortController();
		const waiting = call("GET", "/api/wait?scope=new&timeout=30", { author: BOB, signal: controller.signal });
		controller.abort();
		const result = await waiting.catch((error) => error);
		expect(result instanceof Error || result.json.timedOut === true).toBe(true);
	});

	test("caps concurrent waits per author", async () => {
		const controllers = Array.from({ length: 8 }, () => new AbortController());
		const pending = controllers.map((c) => call("GET", "/api/wait?scope=new&timeout=30", { author: BOB, signal: c.signal }));
		const ninth = await call("GET", "/api/wait?scope=new&timeout=30", { author: BOB });
		expect(ninth.status).toBe(429);
		for (const c of controllers) c.abort();
		await Promise.allSettled(pending);
	});

	test("requires an author and a known thread", async () => {
		expect((await call("GET", "/api/wait?scope=new&timeout=0")).status).toBe(401);
		expect((await call("GET", "/api/wait?thread=999&timeout=0", { author: ALICE })).status).toBe(404);
	});
});

describe("validation and limits", () => {
	test("rejects malformed authors, kinds, tags, and sizes", async () => {
		expect((await post("Mellon/omo/x", { title: "t" })).status).toBe(400);
		expect((await post("mellon/omo", { title: "t" })).status).toBe(400);
		expect((await call("POST", "/api/threads", { body: { title: "t" } })).status).toBe(401);
		expect((await post(ALICE, { title: "t", kind: "rant" })).status).toBe(400);
		expect((await post(ALICE, { title: "   " })).status).toBe(400);
		expect((await post(ALICE, { title: "x".repeat(201) })).status).toBe(413);
		expect((await post(ALICE, { title: "t", body: "x".repeat(16_001) })).status).toBe(413);
		expect((await post(ALICE, { title: "t", tags: ["has space"] })).status).toBe(400);
		expect((await post(ALICE, { title: "t", tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).status).toBe(413);
		expect((await post(ALICE, { title: 42 })).status).toBe(400);
		expect((await call("POST", "/api/threads", { author: ALICE, raw: "{nope" })).status).toBe(400);
		expect((await call("POST", "/api/threads", { author: ALICE, raw: "[]" })).status).toBe(400);
		expect((await call("POST", "/api/threads", { author: ALICE, raw: JSON.stringify({ title: "t", body: "x".repeat(MAX_REQUEST_BYTES) }) })).status).toBe(413);
		expect((await call("GET", "/api/threads?limit=abc")).status).toBe(400);
		expect((await call("GET", "/api/threads/0")).status).toBe(400);
		expect((await call("GET", "/api/threads/77")).status).toBe(404);
		expect((await call("DELETE", "/api/threads")).status).toBe(401);
	});

	test("requires a JSON content type on writes", async () => {
		const res = await app.fetch(
			new Request("http://forum.test/api/threads", {
				method: "POST",
				headers: { "x-forum-author": ALICE, "content-type": "text/plain" },
				body: JSON.stringify({ title: "t" }),
			}),
		);
		expect(res.status).toBe(415);
	});

	test("strips control characters", async () => {
		const thread = (await post(ALICE, { title: "a\u0007b\u001b[31mc", body: "line\r\nnext\u0000" })).json.thread;
		expect(thread.title).toBe("ab[31mc");
		expect(thread.body).toBe("line\nnext");
	});

	test("rate limits writes per author", async () => {
		app = createHandler(forum, { writeBurst: 3, writePerSecond: 0.5 }, () => clock);
		for (let i = 0; i < 3; i++) expect((await post(ALICE, { title: `t${i}` })).status).toBe(201);
		const limited = await post(ALICE, { title: "t3" });
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await post(BOB, { title: "other author" })).status).toBe(201);
		clock += 2_000;
		expect((await post(ALICE, { title: "t4" })).status).toBe(201);
	});
});

describe("pruning", () => {
	test("drops resolved threads older than 60 days with their replies and events", async () => {
		const old = (await post(ALICE, { title: "old" })).json.thread.id;
		await call("POST", `/api/threads/${old}/replies`, { author: BOB, body: { body: "r" } });
		await call("POST", `/api/threads/${old}/resolve`, { author: ALICE, body: {} });
		const openOld = (await post(ALICE, { title: "old but open" })).json.thread.id;
		clock += RESOLVED_RETENTION_MS - 1_000;
		const recent = (await post(ALICE, { title: "recent" })).json.thread.id;
		await call("POST", `/api/threads/${recent}/resolve`, { author: ALICE, body: {} });

		expect(forum.prune().threads).toBe(0);
		clock += 2_000;
		expect(forum.prune().threads).toBe(1);
		expect((await call("GET", `/api/threads/${old}`)).status).toBe(404);
		expect((await call("GET", `/api/threads/${openOld}`)).status).toBe(200);
		expect((await call("GET", `/api/threads/${recent}`)).status).toBe(200);
		const orphans = forum.db.query("SELECT COUNT(*) AS n FROM replies WHERE thread_id = ?").get(old) as { n: number };
		expect(orphans.n).toBe(0);
		const events = forum.db.query("SELECT COUNT(*) AS n FROM events WHERE thread_id = ?").get(old) as { n: number };
		expect(events.n).toBe(0);
	});
});
