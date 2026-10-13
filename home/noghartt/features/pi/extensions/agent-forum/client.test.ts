import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHOR_RE, Forum } from "../../../../../../hosts/mellon/agent-forum/forum.ts";
import { createHandler } from "../../../../../../hosts/mellon/agent-forum/http.ts";
import { ForumClient, ForumError, formatEvents, formatThread, forumIdentity, forumUrl, harnessName } from "./client.ts";

describe("endpoint and identity", () => {
	test("AGENT_FORUM_URL wins, otherwise loopback on mellon and the tailnet name elsewhere", () => {
		expect(forumUrl({ AGENT_FORUM_URL: "http://x:1/" }, "palantir")).toBe("http://x:1");
		expect(forumUrl({}, "mellon")).toBe("http://127.0.0.1:7410");
		expect(forumUrl({}, "Mellon.tail1234.ts.net")).toBe("http://127.0.0.1:7410");
		expect(forumUrl({}, "palantir.local")).toBe("http://mellon:7410");
	});

	test("harness from the executable, falling back to OmO's environment", () => {
		expect(harnessName({}, "/home/u/.omo/binary-runtime/5.1.28/omo")).toBe("omo");
		expect(harnessName({}, "/nix/store/x-pi/bin/pi")).toBe("pi");
		expect(harnessName({ OMO_NATIVE: "1" }, "/nix/store/x-bun/bin/bun")).toBe("omo");
		expect(harnessName({}, "/nix/store/x-node/bin/node")).toBe("pi");
	});

	test("identity prefers orchestrator run:node, then swarm member, then session id, and always passes server validation", () => {
		const session = forumIdentity({}, "Mellon.tailnet", "omo", "0199a7c2-5b1e-7f00-8c1d-2e3f4a5b6c7d");
		expect(session).toBe("mellon/omo/0199a7c2-5b1e-7f00-8c1d-2e3f4a5b6c7d");
		const worker = forumIdentity({ ORCH_RUN_DIR: "/tmp/orch/runs/r-42ab", ORCH_AGENT: "build fix" }, "palantir", "pi", "s");
		expect(worker).toBe("palantir/pi/r-42ab:build-fix");
		const member = forumIdentity({ SWARM_ID: "s1", SWARM_MEMBER: "m2" }, "palantir", "omo", "s");
		expect(member).toBe("palantir/omo/swarm-s1:m2");
		const odd = forumIdentity({}, "__weird host__", "pi", "../../etc/passwd" + "x".repeat(300));
		for (const author of [session, worker, member, odd, forumIdentity({}, "", "pi", undefined)]) expect(author).toMatch(AUTHOR_RE);
	});
});

describe("client against the server", () => {
	let dir: string;
	let forum: Forum;
	let server: ReturnType<typeof Bun.serve>;
	let alice: ForumClient;
	let bob: ForumClient;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-forum-client-"));
		forum = new Forum(join(dir, "forum.sqlite"));
		const handler = createHandler(forum);
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => handler.fetch(req, srv) });
		const base = `http://127.0.0.1:${server.port}`;
		alice = new ForumClient(base, "mellon/omo/alice");
		bob = new ForumClient(base, "palantir/pi/run-1:bob");
	});

	afterAll(() => {
		server.stop(true);
		forum.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("post, wait over HTTP, reply wakes the waiter, and the thread renders", async () => {
		const { thread } = await alice.request("POST", "/api/threads", { body: { title: "flaky test", body: "fails 1/10", kind: "help-wanted" } });
		const ready = forum.cursor();
		const waiting = alice.request("GET", `/api/wait?thread=${thread.id}&since=${ready}&timeout=30`, { timeoutMs: 45_000 });
		await bob.request("POST", `/api/threads/${thread.id}/replies`, { body: { body: "seed the RNG" } });
		const woke = await waiting;
		expect(woke.events[0].reply.body).toBe("seed the RNG");
		expect(woke.cursor).toBeGreaterThan(ready);
		expect(formatEvents(woke.events, woke.cursor, false)).toContain("seed the RNG");
		const read = await bob.request("GET", `/api/threads/${thread.id}`);
		expect(formatThread(read.thread, "http://f")).toContain("--- reply");
	});

	test("server errors surface status and message", async () => {
		const { thread } = await alice.request("POST", "/api/threads", { body: { title: "take me", kind: "request" } });
		await alice.request("POST", `/api/threads/${thread.id}/claim`, { body: {} });
		const error = await bob.request("POST", `/api/threads/${thread.id}/claim`, { body: {} }).catch((e) => e);
		expect(error).toBeInstanceOf(ForumError);
		expect(error.message).toContain("409");
		expect(error.message).toContain("mellon/omo/alice");
	});

	test("an abort stops a pending wait", async () => {
		const controller = new AbortController();
		const pending = bob.request("GET", "/api/wait?scope=new&timeout=30", { signal: controller.signal, timeoutMs: 45_000 }).catch((e) => e);
		controller.abort();
		const error = await pending;
		expect(error).toBeInstanceOf(ForumError);
		expect(error.message).toBe("forum request aborted");
	});

	test("unreachable forum explains the tailnet requirement", async () => {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		const port = probe.port;
		probe.stop(true);
		const local = await new ForumClient(`http://127.0.0.1:${port}`, "mellon/omo/x").request("GET", "/api/health").catch((e) => e);
		expect(local).toBeInstanceOf(ForumError);
		expect(local.message).toContain("unreachable");
		expect(local.message).toContain("systemctl status agent-forum");
		const remote = await new ForumClient("http://agent-forum-test.invalid:7410", "palantir/omo/x").request("GET", "/api/health").catch((e) => e);
		expect(remote.message).toContain("Tailscale");
	});
});
