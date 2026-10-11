import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import {
	type DaemonInfo,
	formatPost,
	type Member,
	memberLine,
	type Permission,
	type Post,
	RELAY_PREFIX,
	runDir,
	SwarmClient,
	type SwarmState,
} from "../src/protocol.ts";
import { onBeforeAgentStart, RELAY_NOTE, sleep, splitRef, text } from "./common.ts";
import { openPanel } from "./panel.ts";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as {
	leader: { model: string; thinking: string };
	pool: { key: string; models: string[]; thinking: string; tier: number; use: string; optIn?: boolean }[];
};

const ENTRY = "swarm-leader";
const SWARM_BIN = process.env.SWARM_BIN || "swarm";
const LEADER_TOOLS = [
	"swarm_configure",
	"swarm_spawn",
	"swarm_wait",
	"swarm_status",
	"swarm_send",
	"swarm_board",
	"swarm_decide",
	"swarm_evolve",
	"swarm_collect",
	"swarm_stop",
	"swarm_restart",
];

interface ModelState {
	provider?: string;
	id?: string;
	thinking: string;
}

interface LeaderEntry {
	swarm?: string;
	leading: boolean;
	restore?: ModelState;
}

const POOL_TEXT = config.pool
	.map((entry) => `- ${entry.key}${entry.optIn ? " (opt-in: only when you name it)" : ""}: ${entry.models[0]}:${entry.thinking} - ${entry.use}`)
	.join("\n");

const LEADER_PROMPT = `You are leading an agent swarm. You hold the master context: the end goal, who is doing what, and what the swarm has learned. You do not write the members' code; you plan, coordinate, decide, and finally integrate.

Two patterns:
- parallel: the goal splits into distinct parts. Give each member a different focus; they share interfaces and discoveries on the board while they work; you integrate their branches.
- evolve: quality comes from trying competing approaches and selecting (performance, design exploration, a hard bug with several plausible causes, prompt or algorithm tuning). Members of a generation attack the same goal with different approaches; the gate scores each; you pick survivors, distill lessons, and seed the next generation (mutations of the winners plus fresh ideas) until the fitness is good enough or generations run out.
You may combine them: parallel parts, then a short evolve round on the part that matters most.

Working rules:
- Configure first (swarm_configure): pattern, acceptance criteria, and a fitness command when one can measure success objectively (tests, a benchmark printing a 0-1 score).
- Size the swarm to the work: 3-8 members for most goals, up to 20-30 when the work truly splits that far. Members are expensive.
- Leave each member's model empty so Jev picks from the pool; name a pool key or a provider/model id only when you have a reason. Pool:
${POOL_TEXT}
- Give each member a focus that stands alone: the part or approach, the interfaces it must respect, and criteria it can verify.
- Stay in the loop with swarm_wait. Answer questions and permission requests promptly (swarm_send, swarm_decide); broadcast decisions to "*". In-scope requests are yours to approve; destructive actions outside a member's scope go to the user automatically.
- Keep members from colliding: assign distinct areas and tell them to claim shared ones.
- When the work is done: swarm_collect, then integrate in a new worktree on a branch named swarm-integration/<id> (not under swarm/<id>/), resolving conflicts and sending problems back to the owning member. Run the checks, then decide the output the goal needs (one PR, a stack of PRs, or a report) and tell the user what you delivered and how it was verified.`;

export function registerLeader(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let swarmId: string | undefined;
	let client: SwarmClient | undefined;
	let leading = false;
	let restore: ModelState | undefined;
	let generationTag = 0;
	let stopPolling: (() => void) | undefined;
	const inbox: Post[] = [];
	let waiter: (() => void) | undefined;
	const prompting = new Set<string>();

	const persist = () => pi.appendEntry<LeaderEntry>(ENTRY, { swarm: swarmId, leading, restore });

	const connect = async (id: string): Promise<SwarmClient> => {
		const read = async () => JSON.parse(await readFile(join(runDir(id), "daemon.json"), "utf8").catch(() => "{}")) as Partial<DaemonInfo>;
		let info = await read();
		const alive = async () => {
			if (!info.port || !info.token) return false;
			return SwarmClient.fromInfo(info as DaemonInfo)
				.get("/state", AbortSignal.timeout(3_000))
				.then(() => true, () => false);
		};
		if (!(await alive())) {
			const resumed = await pi.exec(SWARM_BIN, ["resume", id]);
			if (resumed.code !== 0) throw new Error(`swarm resume ${id}: ${resumed.stderr.trim() || resumed.stdout.trim()}`);
			info = await read();
		}
		return SwarmClient.fromInfo(info as DaemonInfo);
	};

	const requireSwarm = (): SwarmClient => {
		if (!client || !swarmId) throw new Error("No swarm is attached to this session. Start one with /leader <goal> or attach with /leader attach <id>.");
		return client;
	};

	const deliver = (posts: Post[]) => {
		if (!posts.length) return;
		if (waiter) {
			inbox.push(...posts);
			waiter();
			return;
		}
		if (!leading) {
			ctx?.ui.notify(`swarm ${swarmId}: ${posts.length} message(s) for the leader. /leader resumes leader mode.`, "info");
			inbox.push(...posts);
			return;
		}
		const body = `${RELAY_PREFIX}${posts.map(formatPost).join("\n")}`;
		if (!ctx || ctx.isIdle()) pi.sendUserMessage(body);
		else pi.sendUserMessage(body, { deliverAs: "followUp" });
	};

	const reviewPermissions = async () => {
		if (!client || !ctx?.hasUI) return;
		const { permissions } = await client.get<{ permissions: Permission[] }>("/permissions?state=pending");
		for (const permission of permissions) {
			if (permission.scope !== "out" || prompting.has(permission.id)) continue;
			prompting.add(permission.id);
			const approve = await ctx.ui.confirm(
				`Swarm ${swarmId}: ${permission.from} wants to act outside its scope`,
				`${permission.action}\n\nWhy it was held: ${permission.reason}\n\nApprove this action?`,
			);
			await client.post(`/permission/${permission.id}/decide`, { approve, by: "user", note: approve ? "approved by the user" : "denied by the user" }).catch(() => undefined);
			prompting.delete(permission.id);
		}
	};

	// Members in sandboxes hold access tokens but no refresh token. Asking the registry for each
	// provider's auth makes this session run OmO's own locked refresh before expiry; swarmd then
	// pushes the fresh token into every pod.
	const refreshCredentials = async () => {
		if (!client || !ctx) return;
		const state = await client.get<SwarmState>("/state").catch(() => undefined);
		if (!state || state.spec.backend !== "sbx") return;
		const providers = new Set(state.members.filter((member) => !["done", "failed", "stopped"].includes(member.state)).map((member) => splitRef(member.model).provider));
		const registry = ctx.modelRegistry as unknown as { getProviderAuth?: (id: string) => Promise<unknown> };
		for (const provider of providers) await registry.getProviderAuth?.(provider).catch(() => undefined);
	};

	const startPolling = () => {
		stopPolling?.();
		let stopped = false;
		stopPolling = () => {
			stopped = true;
			waiter?.();
		};
		void (async () => {
			while (!stopped && client) {
				try {
					const { posts } = await client.get<{ posts: Post[] }>("/inbox/leader?timeout=25");
					if (!stopped) deliver(posts);
				} catch {
					await sleep(5_000);
				}
			}
		})();
		void (async () => {
			let tick = 0;
			while (!stopped) {
				await reviewPermissions().catch(() => undefined);
				if (tick++ % 30 === 0) await refreshCredentials().catch(() => undefined);
				await sleep(2_000);
			}
		})();
	};

	const bind = async (id: string) => {
		client = await connect(id);
		swarmId = id;
		startPolling();
		pi.events.emit("swarm:attached", { id });
	};

	const activateTools = () => {
		const active = new Set(pi.getActiveTools());
		for (const name of LEADER_TOOLS) active.add(name);
		pi.setActiveTools([...active]);
	};

	const deactivateTools = () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !LEADER_TOOLS.includes(name)));
	};

	const applyLeaderModel = async (next: ExtensionContext) => {
		if (!restore) restore = { provider: next.model?.provider, id: next.model?.id, thinking: pi.getThinkingLevel() };
		const { provider, id } = splitRef(config.leader.model);
		const model = next.modelRegistry.find(provider, id);
		if (model && (await pi.setModel(model))) pi.setThinkingLevel(config.leader.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
		else next.ui.notify(`Leader model ${config.leader.model} is unavailable; keeping the current model.`, "warning");
	};

	const restoreModel = async (next: ExtensionContext) => {
		if (restore?.provider && restore.id) {
			const model = next.modelRegistry.find(restore.provider, restore.id);
			if (model) await pi.setModel(model);
		}
		if (restore) pi.setThinkingLevel(restore.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
		restore = undefined;
	};

	onBeforeAgentStart(pi, async (event) => {
		if (!leading) return undefined;
		return { systemPrompt: [event.systemPrompt, LEADER_PROMPT, swarmId ? `Current swarm: ${swarmId}.` : "", RELAY_NOTE].filter(Boolean).join("\n\n") };
	});

	pi.on("session_start", async (_event, next) => {
		ctx = next;
		const saved = next.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === ENTRY);
		const data = saved?.type === "custom" ? (saved.data as LeaderEntry | undefined) : undefined;
		leading = !!data?.leading;
		restore = data?.restore;
		if (data?.swarm && existsSync(join(runDir(data.swarm), "state.json"))) {
			await bind(data.swarm).catch((error: Error) => next.ui.notify(`swarm ${data.swarm}: ${error.message}`, "warning"));
		}
		if (leading) activateTools();
	});

	pi.on("agent_start", async (_event, next) => {
		ctx = next;
	});

	pi.on("session_shutdown", async () => {
		stopPolling?.();
	});

	const startSwarm = async (args: string[], next: ExtensionContext) => {
		const flags: string[] = [];
		const goalWords: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--local") flags.push("--backend", "local");
			else if (arg.startsWith("--") && ["--pattern", "--backend", "--criteria", "--fitness", "--max-members", "--max-generations", "--pod-size", "--pod-memory"].includes(arg.split("=")[0])) {
				if (arg.includes("=")) flags.push(arg);
				else flags.push(arg, args[++index] ?? "");
			} else goalWords.push(arg);
		}
		const goal = goalWords.join(" ").trim();
		if (!goal) {
			next.ui.notify("Usage: /leader [--pattern parallel|evolve] [--local] [--criteria TEXT] [--fitness CMD] <goal>", "warning");
			return;
		}
		const started = await pi.exec(SWARM_BIN, ["start", "--json", "--repo", next.cwd, "--goal", goal, ...flags], { cwd: next.cwd });
		if (started.code !== 0) {
			next.ui.notify(`swarm start failed: ${started.stderr.trim() || started.stdout.trim()}`, "error");
			return;
		}
		const info = JSON.parse(started.stdout.trim().split("\n").at(-1)!) as { id: string; pattern: string; backend: string; head: string };
		await applyLeaderModel(next);
		leading = true;
		await bind(info.id);
		activateTools();
		persist();
		const patternChosen = flags.includes("--pattern") || flags.some((flag) => flag.startsWith("--pattern="));
		pi.sendUserMessage(
			[
				`${RELAY_PREFIX}You lead swarm ${info.id} (backend ${info.backend}, starting from ${info.head.slice(0, 12)}).`,
				`Goal: ${goal}`,
				"",
				patternChosen
					? `The user chose the ${info.pattern} pattern.`
					: "Choose the pattern (parallel or evolve), acceptance criteria, and a fitness command if success can be measured, and set them with swarm_configure.",
				"Then plan the members and spawn them with swarm_spawn, coordinate with swarm_wait, and integrate at the end. Ask the user first if the goal is too ambiguous to plan.",
			].join("\n"),
			next.isIdle() ? undefined : { deliverAs: "followUp" },
		);
	};

	pi.registerCommand("leader", {
		description: "Lead an agent swarm: /leader <goal> | attach <id> | off | status",
		getArgumentCompletions: (prefix) => {
			const items = ["attach", "off", "status", "--pattern", "--local", "--criteria", "--fitness"].filter((item) => item.startsWith(prefix.trim()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (raw, next) => {
			ctx = next;
			const args = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
			const [verb, target] = args;
			if (verb === "off") {
				leading = false;
				deactivateTools();
				await restoreModel(next);
				persist();
				next.ui.notify(`Leader mode off.${swarmId ? ` Swarm ${swarmId} keeps running; /leader attach ${swarmId} resumes.` : ""}`, "info");
				return;
			}
			if (verb === "attach") {
				if (!target) return next.ui.notify("Usage: /leader attach <swarm id>", "warning");
				await bind(target);
				await applyLeaderModel(next);
				leading = true;
				activateTools();
				persist();
				const state = await requireSwarm().get<SwarmState>("/state");
				pi.sendUserMessage(
					`${RELAY_PREFIX}You are leading swarm ${target} again. Goal: ${state.spec.goal}\nGeneration ${state.generation}, pattern ${state.spec.pattern}.\n${state.members.map(memberLine).join("\n")}\nCatch up with swarm_board and continue.`,
				);
				return;
			}
			if (verb === "status" || (!verb && swarmId)) {
				if (!verb && !leading) {
					leading = true;
					await applyLeaderModel(next);
					activateTools();
					persist();
				}
				const state = await requireSwarm().get<SwarmState>("/state");
				next.ui.notify(`swarm ${swarmId} ${state.status} g${state.generation}\n${state.members.map(memberLine).join("\n") || "no members yet"}`, "info");
				if (inbox.length && leading && !waiter) deliver(inbox.splice(0));
				return;
			}
			await startSwarm(args, next);
		},
	});

	pi.registerCommand("swarms", {
		description: "Swarm panel: every swarm for this repo, its members, and their live sessions",
		handler: async (_args, next) => {
			ctx = next;
			await openPanel(pi, next, {
				current: swarmId,
				attachLeader: async (id) => {
					await bind(id);
					await applyLeaderModel(next);
					leading = true;
					activateTools();
					persist();
				},
			});
		},
	});

	const memberSpec = Type.Object({
		name: Type.Optional(Type.String({ description: "Short name; derived from the focus when omitted" })),
		focus: Type.String({ description: "What this member owns (parallel) or attacks (evolve), with the interfaces it must respect" }),
		approach: Type.Optional(Type.String({ description: "evolve: the distinct approach or mutation this member tries" })),
		criteria: Type.Optional(Type.Array(Type.String(), { description: "Member-specific acceptance criteria; defaults to the swarm's" })),
		model: Type.Optional(Type.String({ description: "Pool key or provider/model id; omit to let Jev choose" })),
		thinking: Type.Optional(StringEnum(["low", "medium", "high", "xhigh"] as const)),
		parents: Type.Optional(Type.Array(Type.String(), { description: "Members whose branch this one starts from (the first one)" })),
	});

	pi.registerTool({
		name: "swarm_configure",
		label: "Swarm Configure",
		description: "Set the swarm's pattern (parallel or evolve), acceptance criteria, optional fitness command (run in each member's worktree; prints a 0-1 score or exits 0 on success), and limits. Broadcast to every member.",
		defaultActive: false,
		parameters: Type.Object({
			pattern: StringEnum(["parallel", "evolve"] as const),
			criteria: Type.Optional(Type.Array(Type.String())),
			fitness_command: Type.Optional(Type.String()),
			max_generations: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			max_members: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })),
		}),
		async execute(_id, params) {
			const spec = await requireSwarm().post("/configure", {
				pattern: params.pattern,
				criteria: params.criteria,
				fitnessCommand: params.fitness_command,
				maxGenerations: params.max_generations,
				maxMembers: params.max_members,
			});
			return text(`Configured: ${JSON.stringify(spec)}`);
		},
	});

	pi.registerTool({
		name: "swarm_spawn",
		label: "Swarm Spawn",
		description: "Add members to the current generation. Each starts in its own worktree and sandbox slot; members beyond the memory budget queue until capacity frees up.",
		defaultActive: false,
		parameters: Type.Object({ members: Type.Array(memberSpec, { minItems: 1, maxItems: 30 }) }),
		async execute(_id, params) {
			const { members } = await requireSwarm().post<{ members: Member[] }>("/spawn", { members: params.members });
			return text(`Spawned:\n${members.map((member) => `${memberLine(member)}\n    model: ${member.modelNote}`).join("\n")}`);
		},
	});

	pi.registerTool({
		name: "swarm_wait",
		label: "Swarm Wait",
		description: "Block until a member reports, asks, requests permission, fails, or a generation completes, or the timeout passes. Returns those messages plus a short status.",
		defaultActive: false,
		parameters: Type.Object({ timeout_seconds: Type.Optional(Type.Number({ minimum: 5, maximum: 3600, default: 600 })) }),
		async execute(_id, params, signal) {
			const swarm = requireSwarm();
			const deadline = Date.now() + (params.timeout_seconds ?? 600) * 1000;
			while (!inbox.length && Date.now() < deadline && !signal?.aborted) {
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
			const posts = inbox.splice(0);
			const state = await swarm.get<SwarmState>("/state");
			const counts: Record<string, number> = {};
			for (const member of state.members) counts[member.state] = (counts[member.state] ?? 0) + 1;
			const pending = state.permissions.filter((permission) => permission.state === "pending");
			return text(
				[
					posts.length ? posts.map(formatPost).join("\n") : "No messages before the timeout.",
					"",
					`Status: generation ${state.generation}; ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(", ") || "no members"}.`,
					pending.length ? `Pending permissions: ${pending.map((permission) => `${permission.id} (${permission.scope}) from ${permission.from}: ${permission.action.slice(0, 120)}`).join("; ")}` : undefined,
					state.members.filter((member) => member.attention).map((member) => `${member.name} needs attention: ${member.attention}`).join("\n") || undefined,
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "swarm_status",
		label: "Swarm Status",
		description: "Show the swarm: members (state, model, fitness, last post), pods, claims, skills, generations, and pending permissions.",
		defaultActive: false,
		parameters: Type.Object({}),
		async execute() {
			const state = await requireSwarm().get<SwarmState & { maxPods: number }>("/state");
			return text(
				[
					`Swarm ${state.spec.id}: ${state.status}, ${state.spec.pattern}, generation ${state.generation}/${state.spec.maxGenerations}, backend ${state.spec.backend} (max pods ${state.maxPods}).`,
					`Goal: ${state.spec.goal}`,
					state.spec.criteria.length ? `Criteria: ${state.spec.criteria.join("; ")}` : undefined,
					state.spec.fitnessCommand ? `Fitness: ${state.spec.fitnessCommand}` : undefined,
					...Object.entries(state.pods).map(([pod, info]) => `pod ${pod}: ${info.state}${info.error ? ` (${info.error})` : ""}`),
					...state.members.map((member) => `${memberLine(member)}${member.lastPost ? `\n    last: ${member.lastPost}` : ""}${member.fitness ? `\n    fitness: ${member.fitness.note}` : ""}`),
					state.claims.length ? `Claims: ${state.claims.map((claim) => `${claim.area} (${claim.owner})`).join(", ")}` : undefined,
					state.skills.length ? `Skills: ${state.skills.map((skill) => `${skill.name} by ${skill.author}`).join(", ")}` : undefined,
					...state.generations.map((record) => `g${record.generation}: survivors ${record.survivors.join(", ") || "-"}`),
					...state.permissions.filter((permission) => permission.state === "pending").map((permission) => `pending ${permission.id} (${permission.scope}) ${permission.from}: ${permission.action}`),
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "swarm_send",
		label: "Swarm Send",
		description: 'Message a member, or "*" for every member (decisions, interface changes, redirections). Delivered into their sessions.',
		defaultActive: false,
		parameters: Type.Object({
			to: Type.String(),
			text: Type.String(),
			kind: Type.Optional(StringEnum(["decision", "answer", "status", "lesson"] as const)),
			ref: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const post = await requireSwarm().post<Post>("/post", { from: "leader", kind: params.kind ?? "decision", to: params.to, text: params.text, ref: params.ref });
			return text(`Sent #${post.seq} to ${params.to}.`);
		},
	});

	pi.registerTool({
		name: "swarm_board",
		label: "Swarm Board",
		description: "Read the board: everything members posted (discoveries, questions, reports, skills, claims).",
		defaultActive: false,
		parameters: Type.Object({
			since: Type.Optional(Type.Number()),
			kinds: Type.Optional(Type.Array(Type.String())),
			from: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
		}),
		async execute(_id, params) {
			const query = new URLSearchParams({ after: String(params.since ?? 0), limit: String(params.limit ?? 120) });
			if (params.kinds?.length) query.set("kinds", params.kinds.join(","));
			if (params.from) query.set("from", params.from);
			const page = await requireSwarm().get<{ posts: Post[] }>(`/board?${query}`);
			return text(page.posts.map(formatPost).join("\n") || "The board is empty.");
		},
	});

	pi.registerTool({
		name: "swarm_decide",
		label: "Swarm Decide",
		description: "Approve or deny a member's permission request. Set ask_user to hand the decision to the user instead.",
		defaultActive: false,
		parameters: Type.Object({
			id: Type.String(),
			approve: Type.Boolean(),
			note: Type.Optional(Type.String()),
			ask_user: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, next) {
			const swarm = requireSwarm();
			let approve = params.approve;
			let by = "leader";
			const { permissions } = await swarm.get<{ permissions: Permission[] }>("/permissions");
			const permission = permissions.find((candidate) => candidate.id === params.id);
			if (!permission) throw new Error(`Unknown permission ${params.id}`);
			if (params.ask_user || permission.scope === "out") {
				if (!next.hasUI) throw new Error("This decision needs the user, and this session has no UI.");
				approve = await next.ui.confirm(`Swarm ${swarmId}: ${permission.from} asks`, `${permission.action}\n\nWhy: ${permission.reason}${params.note ? `\n\nLeader: ${params.note}` : ""}`);
				by = "user";
			}
			const decided = await swarm.post<Permission>(`/permission/${params.id}/decide`, { approve, by, note: params.note });
			return text(`Permission ${decided.id}: ${decided.state} (by ${by}).`);
		},
	});

	pi.registerTool({
		name: "swarm_evolve",
		label: "Swarm Evolve",
		description:
			"Close the current generation and start the next: survivors (best members whose branches seed children), lessons distilled from the generation, and the next population (mutations of survivors and fresh approaches). Children start from a survivor's branch, round-robin unless parents is set.",
		defaultActive: false,
		parameters: Type.Object({
			survivors: Type.Array(Type.String()),
			lessons: Type.String(),
			population: Type.Array(memberSpec, { minItems: 1, maxItems: 30 }),
		}),
		async execute(_id, params) {
			const { members } = await requireSwarm().post<{ members: Member[] }>("/evolve", params);
			generationTag = members[0]?.generation ?? generationTag;
			return text(`Generation ${generationTag} spawned:\n${members.map(memberLine).join("\n")}`);
		},
	});

	pi.registerTool({
		name: "swarm_collect",
		label: "Swarm Collect",
		description: "Fetch every member's branch into the host repository (sbx pods via their sandbox-<pod> remotes) and list them with state and fitness, ready to integrate.",
		defaultActive: false,
		parameters: Type.Object({}),
		async execute() {
			const result = await requireSwarm().post<{ repo: string; branches: { member: string; branch: string; generation: number; state: string; fitness?: number }[] }>("/collect", {});
			return text(
				[`Branches in ${result.repo}:`, ...result.branches.map((branch) => `- ${branch.branch} (g${branch.generation} ${branch.state}${branch.fitness !== undefined ? ` fitness ${branch.fitness.toFixed(2)}` : ""})`)].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "swarm_stop",
		label: "Swarm Stop",
		description: "Stop named members, or every member when none are named (the swarm then stops scheduling). Branches and the board stay.",
		defaultActive: false,
		parameters: Type.Object({ members: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params) {
			const result = await requireSwarm().post<{ stopped: string[] }>("/stop", { members: params.members });
			return text(`Stopped: ${result.stopped.join(", ") || "none"}`);
		},
	});

	pi.registerTool({
		name: "swarm_restart",
		label: "Swarm Restart",
		description:
			"Restart a member's session (it resumes its conversation). With billing, switch its providers to pay-per-token API keys, for example when the subscription limit is exhausted; the user must confirm, and the key stays on the host behind the sandbox proxy.",
		defaultActive: false,
		parameters: Type.Object({
			member: Type.String(),
			billing: Type.Optional(Type.Array(StringEnum(["anthropic", "openai"] as const))),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, next) {
			if (params.billing?.length) {
				if (!next.hasUI) throw new Error("Switching to API billing needs the user's confirmation, and this session has no UI.");
				const ok = await next.ui.confirm(
					`Swarm ${swarmId}: switch ${params.member} to API billing?`,
					`Providers: ${params.billing.join(", ")}. Requests will be billed per token to your API account instead of the subscription.${params.reason ? `\n\nLeader's reason: ${params.reason}` : ""}`,
				);
				if (!ok) return text("The user declined API billing.");
			}
			const member = await requireSwarm().post<Member>(`/member/${encodeURIComponent(params.member)}/restart`, { billing: params.billing });
			return text(`Restarted: ${memberLine(member)}`);
		},
	});
}
