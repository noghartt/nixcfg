// Process entry: listens on fixed hosts (loopback) plus every address of the
// tailnet interface. Tailscale assigns that address at runtime and may bring
// the interface up after this service, so the address set is rescanned.
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Forum } from "./forum.ts";
import { createHandler } from "./http.ts";

const env = process.env;
const port = Number(env.AGENT_FORUM_PORT ?? 7410);
const dbPath = env.AGENT_FORUM_DB ?? join(env.STATE_DIRECTORY ?? ".", "forum.sqlite");
const fixedHosts = (env.AGENT_FORUM_HOSTS ?? "127.0.0.1").split(",").filter(Boolean);
const iface = env.AGENT_FORUM_INTERFACE ?? "tailscale0";
const rescanMs = Number(env.AGENT_FORUM_RESCAN_SECONDS ?? 30) * 1000;

const forum = new Forum(dbPath);
const handler = createHandler(forum);
const listeners = new Map<string, ReturnType<typeof Bun.serve>>();

function interfaceAddresses(): string[] {
	if (!iface) return [];
	return (networkInterfaces()[iface] ?? [])
		.filter((a) => !(a.family === "IPv6" && a.address.toLowerCase().startsWith("fe80")))
		.map((a) => a.address);
}

function syncListeners(): void {
	const wanted = new Set([...fixedHosts, ...interfaceAddresses()]);
	for (const [host, server] of listeners) {
		if (wanted.has(host)) continue;
		server.stop(true);
		listeners.delete(host);
		console.log(`agent-forum: stopped listening on ${host}`);
	}
	for (const host of wanted) {
		if (listeners.has(host)) continue;
		try {
			listeners.set(
				host,
				// idleTimeout must outlast the longest long-poll.
				Bun.serve({ hostname: host, port, idleTimeout: 150, fetch: (req, server) => handler.fetch(req, server) }),
			);
			console.log(`agent-forum: listening on ${host.includes(":") ? `[${host}]` : host}:${port}`);
		} catch (error) {
			console.error(`agent-forum: cannot listen on ${host}:${port}:`, error);
		}
	}
}

function prune(): void {
	const result = forum.prune();
	if (result.threads || result.events) console.log(`agent-forum: pruned ${result.threads} threads, ${result.events} events`);
}

syncListeners();
if (!listeners.size) {
	console.error("agent-forum: no listener could be started");
	process.exit(1);
}
prune();
const timers = [setInterval(syncListeners, rescanMs), setInterval(prune, 3_600_000)];

function shutdown(): void {
	for (const timer of timers) clearInterval(timer);
	for (const server of listeners.values()) server.stop(true);
	forum.close();
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
