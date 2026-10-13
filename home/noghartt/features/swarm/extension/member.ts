import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { Type } from "typebox";
import { classifyBash, classifyWrite, type Scope } from "../src/approval.ts";
import { run } from "../src/backends.ts";
import { shellQuote } from "../src/shell.ts";
import {
	formatPost,
	type Member,
	type MemberAssignment,
	memberLine,
	type Permission,
	POST_KINDS,
	type Post,
	type PostKind,
	RELAY_PREFIX,
	type Skill,
	SwarmClient,
} from "../src/protocol.ts";
import { lastAssistantText, onBeforeAgentStart, RELAY_NOTE, sleep, splitRef, summarizeToolCall, text } from "./common.ts";

const TOOL_LOG_LIMIT = 40;
const PERMISSION_TIMEOUT_MS = 15 * 60_000;
const SKILLS_DIR = join(homedir(), ".swarm-skills");

export function registerMember(pi: ExtensionAPI) {
	const self = process.env.SWARM_MEMBER!;
	const client = new SwarmClient(process.env.SWARM_URL!, process.env.SWARM_TOKEN!);
	const worktree = process.env.SWARM_WORKTREE ?? process.cwd();
	const scope: Scope = { worktree, home: homedir(), extra: [SKILLS_DIR] };
	// Set when cloud-mode aims every tool into an agentbox sandbox (agentbox backend): the host-side
	// session cannot see the sandbox's files, so skills move through `agentbox exec`.
	const sandbox = process.env.OMO_CLOUD_SANDBOX;
	const inSandbox = (script: string) => run(process.env.SWARM_AGENTBOX || "agentbox", ["exec", sandbox!, "--", "bash", "-c", script], { timeoutMs: 60_000 });

	let ctx: ExtensionContext | undefined;
	let assignment: MemberAssignment | undefined;
	let boardSeen = 0;
	let stopped = false;
	let reported = false;
	let reopen = false;
	let toolLog: string[] = [];
	const toolArgs = new Map<string, unknown>();
	const held: Post[] = [];
	let waiter: (() => void) | undefined;

	const event = (type: string, extra: Record<string, unknown> = {}) =>
		client.post(`/member/${encodeURIComponent(self)}/event`, { type, ...extra }).catch(() => undefined);

	// Starts a turn when idle, otherwise steers the running one. Every swarm message enters the
	// session here, so this is where the relay prefix is added.
	const deliver = (message: string) => {
		if (reported) reopen = true;
		const body = `${RELAY_PREFIX}${message}`;
		if (!ctx || ctx.isIdle()) pi.sendUserMessage(body);
		else pi.sendUserMessage(body, { deliverAs: "steer" });
	};

	const boardNews = async (): Promise<string> => {
		const page = await client.get<{ posts: Post[]; seq: number }>(`/board?after=${boardSeen}&limit=1`).catch(() => undefined);
		if (!page) return "";
		const fresh = page.seq - boardSeen;
		return fresh > 0 ? `\n\n(Board: ${fresh} new post${fresh === 1 ? "" : "s"} since you last read it; swarm_board shows them.)` : "";
	};

	const pumpInbox = async () => {
		while (!stopped) {
			try {
				const { posts } = await client.get<{ posts: Post[] }>(`/inbox/${encodeURIComponent(self)}?timeout=25`);
				if (!posts.length) continue;
				if (waiter) {
					held.push(...posts);
					waiter();
				} else deliver(posts.map(formatPost).join("\n"));
			} catch {
				await sleep(5_000);
			}
		}
	};

	onBeforeAgentStart(pi, async (start) => ({
		systemPrompt: [start.systemPrompt, assignment?.systemPrompt, RELAY_NOTE].filter(Boolean).join("\n\n"),
	}));

	pi.on("session_start", async (_event, next) => {
		ctx = next;
		for (let attempt = 0; attempt < 30 && !assignment; attempt++) {
			assignment = await client.get<MemberAssignment>(`/assignment/${encodeURIComponent(self)}`).catch(() => undefined);
			if (!assignment) await sleep(2_000);
		}
		if (!assignment) {
			next.ui.notify("swarm: could not reach the swarm daemon; this member has no assignment.", "error");
			return;
		}
		// The first model of the assignment's chain with credentials here, as the orchestrator picks workers.
		const wanted = (assignment.models?.length ? assignment.models : [assignment.model])
			.map((ref) => splitRef(ref))
			.map(({ provider, id }) => next.modelRegistry.find(provider, id))
			.find((candidate) => candidate && next.modelRegistry.hasConfiguredAuth(candidate));
		const current = next.model;
		if (!wanted) {
			await client.post("/post", {
				from: self,
				kind: "status",
				to: "leader",
				text: `Model ${assignment.model} is not available here; running on ${current ? `${current.provider}/${current.id}` : "the default model"} instead.`,
			});
		} else if (!current || current.provider !== wanted.provider || current.id !== wanted.id) {
			if (await pi.setModel(wanted)) pi.setThinkingLevel(assignment.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
		}
		pi.setSessionName(`swarm ${self}`);
		await event("ready");
		const fresh = !next.sessionManager.getBranch().some((entry) => entry.type === "message");
		if (fresh) pi.sendUserMessage(assignment.prompt);
		else deliver("Your session was restarted by the swarm. Read the board for anything you missed, then continue your focus.");
		void pumpInbox();
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		waiter?.();
		await event("exit");
	});

	pi.on("agent_start", async () => {
		toolLog = [];
		await event("busy", { reopen });
		if (reopen) reported = false;
		reopen = false;
	});

	pi.on("tool_execution_start", async (start) => {
		toolArgs.set(start.toolCallId, start.args);
	});

	pi.on("tool_execution_end", async (end) => {
		toolLog.push(summarizeToolCall(end.toolName, toolArgs.get(end.toolCallId), end.isError));
		toolLog = toolLog.slice(-TOOL_LOG_LIMIT);
		toolArgs.delete(end.toolCallId);
	});

	pi.on("agent_settled", async (_event, next) => {
		ctx = next;
		if (!reported) await event("idle", { text: lastAssistantText(next).slice(0, 400) });
	});

	const askUser = async (action: string, reason: string, signal?: AbortSignal): Promise<Permission> => {
		let permission = await client.post<Permission>("/permission", { from: self, action, reason, scope: "out" });
		const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
		while (permission.state === "pending" && Date.now() < deadline && !signal?.aborted) {
			permission = await client.get<Permission>(`/permission/${permission.id}?wait=30`, signal);
		}
		return permission;
	};

	pi.on("tool_call", async (call) => {
		// A sandboxed member acts inside a disposable container without credentials, as destructive-guard assumes.
		if (sandbox) return undefined;
		const input = call.input as Record<string, unknown>;
		const cwd = ctx?.cwd ?? worktree;
		let verdict;
		if (call.toolName === "bash" && typeof input.command === "string") verdict = classifyBash(input.command, scope, cwd);
		else if ((call.toolName === "write" || call.toolName === "edit") && typeof input.path === "string") verdict = classifyWrite(input.path, scope, cwd);
		if (!verdict?.outOfScope) return undefined;
		const action = call.toolName === "bash" ? `bash: ${input.command}` : `${call.toolName} ${input.path}`;
		const permission = await askUser(action, verdict.reason);
		if (permission.state === "approved") return undefined;
		return {
			block: true,
			reason: `Held for the user's approval (permission ${permission.id}, ${verdict.reason}) and ${permission.state === "denied" ? `denied${permission.note ? `: ${permission.note}` : ""}` : "not answered in time"}. Find an in-scope way, or ask the leader.`,
		};
	});

	pi.registerTool({
		name: "swarm_board",
		label: "Swarm Board",
		description: "Read the swarm's shared board: discoveries, decisions, questions, reports, skills, and lessons from every member and the leader.",
		parameters: Type.Object({
			since: Type.Optional(Type.Number({ description: "Only posts after this sequence number; default: those you have not read yet" })),
			kinds: Type.Optional(Type.Array(StringEnum(POST_KINDS))),
			from: Type.Optional(Type.String({ description: "Only posts by this member" })),
		}),
		async execute(_id, params) {
			const after = params.since ?? boardSeen;
			const query = new URLSearchParams({ after: String(after), limit: "200" });
			if (params.kinds?.length) query.set("kinds", params.kinds.join(","));
			if (params.from) query.set("from", params.from);
			const page = await client.get<{ posts: Post[]; seq: number }>(`/board?${query}`);
			if (params.since === undefined) boardSeen = page.seq;
			return text(page.posts.length ? page.posts.map(formatPost).join("\n") : "No new posts.");
		},
	});

	pi.registerTool({
		name: "swarm_post",
		label: "Swarm Post",
		description:
			"Share something with the swarm on the board: a discovery, a status update, a decision or interface others depend on, or a lesson. Address it with `to` (a member, leader, or *) only when it must reach someone right away; unaddressed posts wait on the board.",
		parameters: Type.Object({
			kind: StringEnum(["discovery", "status", "decision", "lesson", "answer"] as const),
			text: Type.String(),
			to: Type.Optional(Type.String()),
			ref: Type.Optional(Type.Number({ description: "Sequence number of the post this answers" })),
		}),
		async execute(_id, params) {
			const post = await client.post<Post>("/post", { from: self, kind: params.kind as PostKind, text: params.text, to: params.to, ref: params.ref });
			return text(`Posted #${post.seq}.${await boardNews()}`);
		},
	});

	pi.registerTool({
		name: "swarm_ask",
		label: "Swarm Ask",
		description: 'Ask a peer member or "leader" a question; it is delivered into their session. Follow with swarm_wait to block on the answer instead of ending your turn.',
		parameters: Type.Object({ to: Type.String(), question: Type.String() }),
		async execute(_id, params) {
			const post = await client.post<Post>("/post", { from: self, kind: "question", text: params.question, to: params.to });
			return text(`Asked ${params.to} (#${post.seq}).`);
		},
	});

	pi.registerTool({
		name: "swarm_wait",
		label: "Swarm Wait",
		description: "Block until a message addressed to you (or to everyone) arrives, or the timeout passes. Use it instead of ending your turn while you wait on a peer, the leader, or a decision.",
		parameters: Type.Object({ timeout_seconds: Type.Optional(Type.Number({ minimum: 5, maximum: 1800, default: 300 })) }),
		async execute(_id, params, signal) {
			const deadline = Date.now() + (params.timeout_seconds ?? 300) * 1000;
			while (!held.length && Date.now() < deadline && !signal?.aborted && !stopped) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(finish, deadline - Date.now());
					signal?.addEventListener("abort", finish, { once: true });
					waiter = finish;
					function finish() {
						clearTimeout(timer);
						waiter = undefined;
						resolve();
					}
				});
			}
			const mail = held.splice(0);
			return text(mail.length ? mail.map(formatPost).join("\n") : "No messages before the timeout.");
		},
	});

	pi.registerTool({
		name: "swarm_peers",
		label: "Swarm Peers",
		description: "List the swarm's members with their focus, state, model, fitness, and latest post, plus active claims and shared skills.",
		parameters: Type.Object({}),
		async execute() {
			const state = await client.get<{ members: Member[]; claims: { area: string; owner: string }[]; skills: Skill[]; generation: number }>("/state");
			const lines = [
				`You are ${self}. Generation ${state.generation}.`,
				...state.members.filter((member) => member.name !== self).map((member) => `${memberLine(member)}${member.lastPost ? `\n    last: ${member.lastPost}` : ""}`),
				state.claims.length ? `Claims: ${state.claims.map((claim) => `${claim.area} (${claim.owner})`).join(", ")}` : "No claims.",
				state.skills.length ? `Skills: ${state.skills.map((skill) => `${skill.name} by ${skill.author}`).join(", ")}` : "No shared skills yet.",
			];
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "swarm_claim",
		label: "Swarm Claim",
		description: "Claim an area (a file, directory, module, or interface) before editing something peers might also touch. Fails with the holder's name when a peer owns it.",
		parameters: Type.Object({ area: Type.String() }),
		async execute(_id, params) {
			const result = await client.post<{ ok: boolean; owner: string }>("/claim", { owner: self, area: params.area });
			return text(result.ok ? `You hold ${params.area}.` : `${params.area} is held by ${result.owner}; coordinate with swarm_ask.`);
		},
	});

	pi.registerTool({
		name: "swarm_release",
		label: "Swarm Release",
		description: "Release an area you claimed.",
		parameters: Type.Object({ area: Type.String() }),
		async execute(_id, params) {
			await client.post("/release", { owner: self, area: params.area });
			return text(`Released ${params.area}.`);
		},
	});

	pi.registerTool({
		name: "swarm_permission",
		label: "Swarm Permission",
		description:
			"Ask the leader whether you may do something you are unsure is within your focus (a new dependency, a change to a shared interface, a long or costly run). Blocks until decided. Destructive actions outside your worktree are held for the user automatically; you do not need this tool for them.",
		parameters: Type.Object({ action: Type.String(), reason: Type.String() }),
		async execute(_id, params, signal) {
			let permission = await client.post<Permission>("/permission", { from: self, action: params.action, reason: params.reason, scope: "ask" });
			const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
			while (permission.state === "pending" && Date.now() < deadline && !signal?.aborted) {
				permission = await client.get<Permission>(`/permission/${permission.id}?wait=30`, signal);
			}
			return text(`Permission ${permission.id}: ${permission.state}${permission.note ? ` - ${permission.note}` : ""}`);
		},
	});

	pi.registerTool({
		name: "swarm_skill_publish",
		label: "Swarm Skill Publish",
		description:
			"Publish a reusable skill for the whole swarm: a SKILL.md with instructions, plus any scripts it uses. Use it when you built a technique, checklist, or helper script peers (or the next generation) can reuse. Pass `dir` to publish a directory, or `files` inline.",
		parameters: Type.Object({
			name: Type.String(),
			description: Type.String({ description: "One line: what the skill does and when to use it" }),
			dir: Type.Optional(Type.String({ description: "Directory holding SKILL.md and helper files" })),
			files: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Relative path -> content" })),
		}),
		async execute(_id, params) {
			const files: Record<string, string> = { ...(params.files ?? {}) };
			if (params.dir) {
				const root = normalize(params.dir.startsWith("/") ? params.dir : join(sandbox ? worktree : (ctx?.cwd ?? worktree), params.dir));
				if (sandbox) {
					const listed = await inSandbox(
						`cd ${shellQuote(root)} && find . -type f -size -256k | head -n 50 | while IFS= read -r f; do printf '%s\\t' "$f"; base64 -w0 "$f"; echo; done`,
					);
					if (listed.code !== 0) throw new Error(`cannot read ${root} in the sandbox: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`);
					for (const line of listed.stdout.split("\n").filter(Boolean)) {
						const tab = line.indexOf("\t");
						files[line.slice(0, tab).replace(/^\.\//, "")] = Buffer.from(line.slice(tab + 1), "base64").toString("utf8");
					}
				} else {
					const listed = await pi.exec("bash", ["-c", `cd "$1" && find . -type f -size -256k | head -n 50`, "_", root]);
					for (const relative of listed.stdout.split("\n").filter(Boolean)) {
						files[relative.replace(/^\.\//, "")] = await readFile(join(root, relative), "utf8");
					}
				}
			}
			if (!Object.keys(files).length) throw new Error("Pass `dir` or `files`.");
			const skill = await client.post<Skill>("/skill", { author: self, name: params.name, description: params.description, files });
			return text(`Published skill ${skill.name} (${skill.files.join(", ")}).${await boardNews()}`);
		},
	});

	pi.registerTool({
		name: "swarm_skills",
		label: "Swarm Skills",
		description: "List skills that swarm members have published.",
		parameters: Type.Object({}),
		async execute() {
			const { skills } = await client.get<{ skills: Skill[] }>("/skills");
			return text(skills.length ? skills.map((skill) => `- ${skill.name} (g${skill.generation}, by ${skill.author}): ${skill.description}`).join("\n") : "No skills published yet.");
		},
	});

	pi.registerTool({
		name: "swarm_skill_fetch",
		label: "Swarm Skill Fetch",
		description: "Fetch a skill a peer published. Its files land under ~/.swarm-skills/<name>/ and its SKILL.md is returned for you to follow.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params) {
			const { skill, files } = await client.get<{ skill: Skill; files: Record<string, string> }>(`/skill/${encodeURIComponent(params.name)}`);
			if (sandbox) {
				// The content rides in the command line, which bounds a file at about 90 KB.
				const skipped: string[] = [];
				for (const [relative, content] of Object.entries(files)) {
					const encoded = Buffer.from(content).toString("base64");
					if (encoded.length > 120_000) {
						skipped.push(relative);
						continue;
					}
					const mode = /\.(sh|py|ts|js)$/.test(relative) ? "755" : "644";
					const written = await inSandbox(
						`f="$HOME/.swarm-skills"/${shellQuote(skill.name)}/${shellQuote(relative)}; mkdir -p "$(dirname "$f")" && printf %s ${shellQuote(encoded)} | base64 -d > "$f" && chmod ${mode} "$f"`,
					);
					if (written.code !== 0) throw new Error(`cannot install ${relative} in the sandbox: ${(written.stderr || written.stdout).trim().slice(0, 300)}`);
				}
				const main = Object.entries(files).find(([relative]) => relative.endsWith("SKILL.md"))?.[1] ?? "";
				return text(`Skill ${skill.name} by ${skill.author} installed in the sandbox at ~/.swarm-skills/${skill.name}.${skipped.length ? ` Skipped as too large: ${skipped.join(", ")}.` : ""}\n\n${main}`);
			}
			const root = join(SKILLS_DIR, skill.name);
			for (const [relative, content] of Object.entries(files)) {
				const target = normalize(join(root, relative));
				if (!target.startsWith(`${root}/`)) continue;
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content, { mode: /\.(sh|py|ts|js)$/.test(relative) ? 0o755 : 0o644 });
			}
			const main = Object.entries(files).find(([relative]) => relative.endsWith("SKILL.md"))?.[1] ?? "";
			return text(`Skill ${skill.name} by ${skill.author} installed in ${root}.\n\n${main}`);
		},
	});

	pi.registerTool({
		name: "swarm_done",
		label: "Swarm Done",
		description:
			"Finish your focus: commit everything first, then report what you did, what you learned, what is left, and how to verify it. The swarm gates the result (fitness) and the leader may still message you.",
		parameters: Type.Object({ report: Type.String() }),
		async execute(_id, params) {
			const result = await client.post<{ ok: boolean; message: string }>(`/member/${encodeURIComponent(self)}/done`, { report: params.report, tools: toolLog });
			if (result.ok) reported = true;
			return text(result.message);
		},
	});
}
