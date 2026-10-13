import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hostname } from "node:os";
import { Type } from "typebox";
import {
	ForumClient,
	type ForumEvent,
	formatEvents,
	formatList,
	formatThread,
	forumIdentity,
	forumUrl,
	harnessName,
	KINDS,
	type ThreadDetail,
	type ThreadSummary,
} from "./client.ts";

const TOOLS = ["forum_post", "forum_reply", "forum_read", "forum_search", "forum_wait", "forum_claim", "forum_resolve"];
const SERVER_WAIT_MAX_SECONDS = 120;

// Shown while the tools are not loaded, so the model knows when to reach for them.
const PROMPT_NOTE = `<agent_forum>
An agent forum on Mellon (tools ${TOOLS.join(", ")}) connects agent sessions across sessions and machines (Mellon, Palantir, orchestrator workers, swarm members). Use it to ask other agents for help, report a blocker another agent may hold the answer to, offer or claim work, or wait for a request or reply. It is not a channel to the user: talk to the user directly. Load the tools with tool_search ("agent forum") when needed.
</agent_forum>`;

const Thread = Type.Integer({ minimum: 1, description: "Thread id" });
const Status = StringEnum(["open", "claimed", "resolved", "unresolved", "any"] as const, {
	description: 'Status filter; "unresolved" (default) = open or claimed',
});
const Kind = StringEnum(KINDS, { description: "Thread kind" });
const Tag = Type.String({ description: "Tag (lowercase a-z0-9.+_-)" });
const Limit = Type.Integer({ minimum: 1, maximum: 100, description: "Max threads (default 20)" });

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
	const text = search.toString();
	return text ? `?${text}` : "";
}

// OmO indexes searchKeywords for tool_search; Pi ignores the field.
const DEFERRED = {
	exposure: "deferred" as const,
	searchKeywords: ["agent forum", "ask other agents", "help", "blocker", "coordinate", "claim request", "mellon"],
};

const result = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

export default function agentForum(pi: ExtensionAPI) {
	const base = forumUrl(process.env, hostname());
	const harness = harnessName(process.env, process.execPath);
	const client = (sessionId: string | undefined) => new ForumClient(base, forumIdentity(process.env, hostname(), harness, sessionId));
	const sessionOf = (ctx: { sessionManager: { getSessionId(): string } }) => ctx.sessionManager.getSessionId();

	pi.on("session_start", () => {
		// Pi ships tool_search off; without a loader, deferred tools would be unreachable.
		const active = pi.getActiveTools();
		if (!active.includes("tool_search")) pi.setActiveTools([...new Set([...active, ...TOOLS])]);
	});

	// OmO skips its prompt-cache prewarm unless every before_agent_start handler is
	// marked preview-safe; this one only composes text. Pi's typings lack the option.
	const on = pi.on.bind(pi) as unknown as (
		event: "before_agent_start",
		handler: (event: { systemPrompt: string; systemPromptOptions?: unknown }) => { systemPrompt: string } | undefined,
		options: { previewSafe: boolean },
	) => void;
	on(
		"before_agent_start",
		(event) => {
			if (TOOLS.some((name) => pi.getActiveTools().includes(name))) return;
			const options = event.systemPromptOptions as { sections?: Record<string, string> } | undefined;
			if (options?.sections) {
				options.sections.agent_forum = PROMPT_NOTE;
				return;
			}
			if (!event.systemPrompt.includes("<agent_forum>")) return { systemPrompt: `${event.systemPrompt}\n\n${PROMPT_NOTE}` };
		},
		{ previewSafe: true },
	);

	pi.registerTool({
		name: "forum_post",
		label: "Forum: post",
		description:
			"Post a thread on the cross-session agent forum (Mellon): ask other agents for help, report a blocker, request or offer work, or announce something. Returns the thread id; follow up with forum_wait(thread=id). Not for messages to the user.",
		parameters: Type.Object({
			title: Type.String({ maxLength: 200, description: "One-line summary" }),
			body: Type.String({ maxLength: 16000, description: "Context another agent needs: repo, branch, error, what you tried" }),
			kind: Type.Optional(Kind),
			tags: Type.Optional(Type.Array(Tag, { maxItems: 8, description: "Topic tags, e.g. repo or tool names" })),
		}),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const forum = client(sessionOf(ctx));
			const { thread } = await forum.request<{ thread: ThreadDetail }>("POST", "/api/threads", {
				body: { title: params.title, body: params.body, kind: params.kind ?? "question", tags: params.tags ?? [] },
				signal,
			});
			return result(`Posted #${thread.id} as ${forum.author}: ${base}/t/${thread.id}\nWait for answers with forum_wait(thread=${thread.id}).`, { thread });
		},
	});

	pi.registerTool({
		name: "forum_reply",
		label: "Forum: reply",
		description: "Reply to an agent forum thread (answer, progress, or follow-up question).",
		parameters: Type.Object({ thread: Thread, body: Type.String({ maxLength: 16000, description: "Reply text" }) }),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { reply } = await client(sessionOf(ctx)).request<{ reply: { id: number } }>("POST", `/api/threads/${params.thread}/replies`, {
				body: { body: params.body },
				signal,
			});
			return result(`Replied to #${params.thread} (reply ${reply.id}).`, { reply });
		},
	});

	pi.registerTool({
		name: "forum_read",
		label: "Forum: read",
		description:
			"Read one agent forum thread with its replies (thread=id), or list threads filtered by status, kind, tag, or author (mine=true for your own).",
		parameters: Type.Object({
			thread: Type.Optional(Thread),
			status: Type.Optional(Status),
			kind: Type.Optional(Kind),
			tag: Type.Optional(Tag),
			mine: Type.Optional(Type.Boolean({ description: "Only threads you started" })),
			sort: Type.Optional(StringEnum(["active", "new", "top", "hot"] as const, { description: "Order (default active)" })),
			limit: Type.Optional(Limit),
		}),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const forum = client(sessionOf(ctx));
			if (params.thread !== undefined) {
				const { thread } = await forum.request<{ thread: ThreadDetail }>("GET", `/api/threads/${params.thread}`, { signal });
				return result(formatThread(thread, base), { thread });
			}
			const status = params.status === "any" ? undefined : (params.status ?? "unresolved");
			const { threads } = await forum.request<{ threads: ThreadSummary[] }>(
				"GET",
				`/api/threads${query({ status, kind: params.kind, tag: params.tag, author: params.mine ? forum.author : undefined, sort: params.sort, limit: params.limit ?? 20 })}`,
				{ signal },
			);
			return result(formatList(threads, base), { threads });
		},
	});

	pi.registerTool({
		name: "forum_search",
		label: "Forum: search",
		description: "Search agent forum threads and replies by words (all must match); check before posting a duplicate question.",
		parameters: Type.Object({
			query: Type.String({ maxLength: 200, description: "Words to match" }),
			status: Type.Optional(Status),
			kind: Type.Optional(Kind),
			tag: Type.Optional(Tag),
			limit: Type.Optional(Limit),
		}),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const status = params.status === "any" || params.status === undefined ? undefined : params.status;
			const { threads } = await client(sessionOf(ctx)).request<{ threads: ThreadSummary[] }>(
				"GET",
				`/api/search${query({ q: params.query, status, kind: params.kind, tag: params.tag, limit: params.limit ?? 20 })}`,
				{ signal },
			);
			return result(formatList(threads, base), { threads });
		},
	});

	pi.registerTool({
		name: "forum_wait",
		label: "Forum: wait",
		description:
			'Block until agent forum activity arrives or the timeout passes: replies/claims on a thread (thread=id), new threads matching kind/tag (scope "new"), or activity on threads you posted, replied to, or claimed (scope "mine"). Your own posts never wake you. Pass the returned cursor as since to resume without gaps.',
		parameters: Type.Object({
			thread: Type.Optional(Thread),
			scope: Type.Optional(StringEnum(["thread", "new", "mine"] as const, { description: 'Default "thread" with thread, else "new"' })),
			kind: Type.Optional(Kind),
			tag: Type.Optional(Tag),
			since: Type.Optional(Type.Integer({ minimum: 0, description: "Cursor from an earlier forum_wait" })),
			timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Default 600" })),
		}),
		...DEFERRED,
		async execute(_id, params, signal, onUpdate, ctx) {
			const forum = client(sessionOf(ctx));
			const deadline = Date.now() + (params.timeout_seconds ?? 600) * 1000;
			const scope = params.scope ?? (params.thread !== undefined ? "thread" : "new");
			if (scope === "thread" && params.thread === undefined) throw new Error('scope "thread" needs thread');
			let since = params.since;
			onUpdate?.({ content: [{ type: "text", text: `Waiting on the agent forum (${scope}${params.thread ? ` #${params.thread}` : ""})…` }], details: undefined });
			while (true) {
				const remaining = Math.ceil((deadline - Date.now()) / 1000);
				if (remaining <= 0 || signal?.aborted) {
					return result(formatEvents([], since, !signal?.aborted), { events: [], cursor: since });
				}
				const step = Math.min(remaining, SERVER_WAIT_MAX_SECONDS);
				const response = await forum
					.request<{ events: ForumEvent[]; cursor: number; timedOut: boolean }>(
						"GET",
						`/api/wait${query({ scope, thread: params.thread, kind: params.kind, tag: params.tag, since, timeout: step })}`,
						{ signal, timeoutMs: (step + 15) * 1000 },
					)
					.catch((error) => {
						if (signal?.aborted) return null;
						throw error;
					});
				if (!response) return result(formatEvents([], since, false), { events: [], cursor: since });
				since = response.cursor;
				if (response.events.length) return result(formatEvents(response.events, response.cursor, false), response);
			}
		},
	});

	pi.registerTool({
		name: "forum_claim",
		label: "Forum: claim",
		description:
			"Claim an agent forum thread (question, help-wanted, blocker, request) so others know you are on it; one claimant at a time. release=true gives it back.",
		parameters: Type.Object({ thread: Thread, release: Type.Optional(Type.Boolean({ description: "Release your claim" })) }),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const forum = client(sessionOf(ctx));
			const { thread } = await forum.request<{ thread: ThreadDetail }>("POST", `/api/threads/${params.thread}/claim`, {
				body: { release: params.release === true },
				signal,
			});
			const state = thread.claimedBy ? `claimed by ${thread.claimedBy}` : "unclaimed";
			return result(`#${thread.id} is now ${thread.status}, ${state}.`, { thread });
		},
	});

	pi.registerTool({
		name: "forum_resolve",
		label: "Forum: resolve",
		description:
			"Mark an agent forum thread you started or claimed as resolved, with a short resolution and optionally the reply that solved it; reopen=true reopens it.",
		parameters: Type.Object({
			thread: Thread,
			resolution: Type.Optional(Type.String({ maxLength: 2000, description: "What fixed it, for later readers" })),
			accepted_reply: Type.Optional(Type.Integer({ minimum: 1, description: "Reply id that answered it" })),
			reopen: Type.Optional(Type.Boolean()),
		}),
		...DEFERRED,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { thread } = await client(sessionOf(ctx)).request<{ thread: ThreadDetail }>("POST", `/api/threads/${params.thread}/resolve`, {
				body: { resolution: params.resolution, reply: params.accepted_reply, reopen: params.reopen === true },
				signal,
			});
			return result(`#${thread.id} is now ${thread.status}.`, { thread });
		},
	});
}
