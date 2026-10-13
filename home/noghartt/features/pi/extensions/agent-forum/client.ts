// Agent forum client: endpoint and identity resolution, HTTP calls with
// actionable errors, and plain-text rendering for tool results. Runs in the
// host-side harness process, so sandboxed sessions need no network exception.
import { basename } from "node:path";

export const KINDS = ["question", "help-wanted", "blocker", "announcement", "request", "discussion"] as const;

type Env = Record<string, string | undefined>;

const shortHost = (hostname: string) => hostname.split(".")[0]!.toLowerCase();

export function forumUrl(env: Env, hostname: string): string {
	const configured = env.AGENT_FORUM_URL?.trim();
	if (configured) return configured.replace(/\/+$/, "");
	return shortHost(hostname) === "mellon" ? "http://127.0.0.1:7410" : "http://mellon:7410";
}

export function harnessName(env: Env, execPath: string): "omo" | "pi" {
	const exe = basename(execPath).toLowerCase();
	if (exe.startsWith("omo")) return "omo";
	if (exe === "pi") return "pi";
	// Under a bun/node runtime the binary name says nothing; OmO exports these.
	return env.OMO_NATIVE || env.OMO_BIN ? "omo" : "pi";
}

const slug = (value: string, pattern: RegExp, max: number) =>
	value.replace(pattern, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, max);

// <host>/<harness>/<session-or-run:node>, matching the server's AUTHOR_RE.
export function forumIdentity(env: Env, hostname: string, harness: string, sessionId: string | undefined): string {
	const host = slug(shortHost(hostname), /[^a-z0-9._-]+/g, 63) || "unknown";
	let tail: string;
	if (env.ORCH_RUN_DIR && env.ORCH_AGENT) tail = `${basename(env.ORCH_RUN_DIR)}:${env.ORCH_AGENT}`;
	else if (env.SWARM_ID && env.SWARM_MEMBER) tail = `swarm-${env.SWARM_ID}:${env.SWARM_MEMBER}`;
	else tail = sessionId || `pid-${process.pid}`;
	return `${host}/${harness}/${slug(tail, /[^A-Za-z0-9._:@-]+/g, 128) || "anonymous"}`;
}

export class ForumError extends Error {}

export interface RequestOptions {
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export class ForumClient {
	constructor(
		readonly base: string,
		readonly author: string,
	) {}

	private hint(): string {
		return new URL(this.base).hostname === "127.0.0.1" || new URL(this.base).hostname === "localhost"
			? "Check agent-forum.service on Mellon (systemctl status agent-forum)."
			: "The forum lives on Mellon and is reachable only over the tailnet: check that Tailscale is up here and Mellon is online, or set AGENT_FORUM_URL.";
	}

	async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const timeoutMs = options.timeoutMs ?? 15_000;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const headers: Record<string, string> = { accept: "application/json", "x-forum-author": this.author };
		if (options.body !== undefined) headers["content-type"] = "application/json";
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw new ForumError("forum request aborted");
			if (timeout.aborted) throw new ForumError(`agent forum at ${this.base} did not answer within ${Math.round(timeoutMs / 1000)}s. ${this.hint()}`);
			const cause = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : String(error);
			throw new ForumError(`agent forum unreachable at ${this.base} (${cause}). ${this.hint()}`);
		}
		const data = (await res.json().catch(() => null)) as { error?: string; claimedBy?: string; retryAfter?: number } | null;
		if (!res.ok) {
			const detail = data?.error ?? res.statusText;
			const extra = data?.retryAfter ? ` Retry in ${data.retryAfter}s.` : "";
			throw new ForumError(`agent forum ${method} ${path} failed: ${res.status} ${detail}.${extra}`);
		}
		return data as T;
	}
}

export interface ThreadSummary {
	id: number;
	title: string;
	kind: string;
	status: string;
	tags: string[];
	author: string;
	createdAt: string;
	activityAt: string;
	claimedBy: string | null;
	score: number;
	replies: number;
	excerpt?: string;
}

export interface Reply {
	id: number;
	author: string;
	body: string;
	createdAt: string;
	score: number;
}

export interface ThreadDetail extends ThreadSummary {
	body: string;
	resolvedBy: string | null;
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

function headline(t: ThreadSummary): string {
	const claim = t.claimedBy ? `, claimed by ${t.claimedBy}` : "";
	const tags = t.tags.length ? ` [${t.tags.map((tag) => `#${tag}`).join(" ")}]` : "";
	return `#${t.id} ${t.title} (${t.kind}, ${t.status}${claim}; ${t.replies} replies, ${t.score >= 0 ? "+" : ""}${t.score})${tags}`;
}

export function formatList(threads: ThreadSummary[], base: string): string {
	if (!threads.length) return "No matching threads.";
	return [
		...threads.map((t) => {
			const excerpt = t.excerpt ? `\n    ${t.excerpt.replace(/\s+/g, " ").slice(0, 200)}` : "";
			return `${headline(t)}\n    by ${t.author}, active ${t.activityAt}${excerpt}`;
		}),
		`\nWeb: ${base}/`,
	].join("\n");
}

export function formatThread(t: ThreadDetail, base: string): string {
	const lines = [headline(t), `by ${t.author} at ${t.createdAt} · ${base}/t/${t.id}`, "", t.body || "(no body)"];
	if (t.status === "resolved") lines.push("", `Resolved by ${t.resolvedBy}${t.resolution ? `: ${t.resolution}` : ""}`);
	for (const r of t.replyList) {
		const accepted = r.id === t.acceptedReply ? " [accepted]" : "";
		lines.push("", `--- reply ${r.id} by ${r.author} at ${r.createdAt}${accepted}`, r.body);
	}
	return lines.join("\n");
}

export function formatEvents(events: ForumEvent[], cursor: number | undefined, timedOut: boolean): string {
	const resume = cursor === undefined ? "" : ` cursor=${cursor} (pass it as since to resume without gaps).`;
	if (!events.length) return `${timedOut ? "Timed out" : "Stopped"} with no new activity.${resume}`;
	const lines = events.map((e) => {
		const what = e.reply ? `reply ${e.reply.id} by ${e.author}:\n    ${e.reply.body.slice(0, 2000).replace(/\n/g, "\n    ")}` : `${e.type} by ${e.author}`;
		return `[${e.type}] ${headline(e.thread)}\n  ${what}`;
	});
	return `${lines.join("\n")}\n${resume.trim()}`;
}
