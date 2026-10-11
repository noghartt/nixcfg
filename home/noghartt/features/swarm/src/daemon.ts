// swarmd: one detached process per swarm. It owns the run directory (state, board, skills),
// serves the board over HTTP to the leader session and to members inside sandboxes, schedules
// members onto pods under a memory budget, gates finished members with Jev and the optional
// fitness command, and seeds each generation from the previous one's survivors.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join, normalize } from "node:path";
import { decideModel, gateResult, type JevConfig, jevApiKey, type PoolEntry } from "../../pi/extensions/orchestrator/jev.ts";
import { type Backend, LocalBackend, run, SbxBackend } from "./backends.ts";
import { BILLING_ENV, hostAuthPath, podAuth, podSettings } from "./credentials.ts";
import {
	type DaemonInfo,
	FINAL_STATES,
	type Fitness,
	LIVE_STATES,
	type Member,
	type MemberAssignment,
	memberLine,
	nowIso,
	type Permission,
	type Post,
	type PostKind,
	POST_KINDS,
	RELAY_PREFIX,
	runDir,
	type Skill,
	type SpawnRequest,
	type SwarmState,
	slug,
} from "./protocol.ts";

export interface SwarmConfig {
	leader: { model: string; thinking: string };
	member: { model: string; thinking: string };
	backend: "sbx" | "local";
	podSize: number;
	podMemory: string;
	maxMembers: number;
	maxGenerations: number;
	hostMemoryShare: number;
	fitnessTimeoutSeconds: number;
	permissionTimeoutSeconds: number;
	jev: JevConfig;
	pool: (PoolEntry & { optIn?: boolean })[];
}

export function loadConfig(): SwarmConfig {
	return JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as SwarmConfig;
}

const SCHEDULE_MS = 2_000;
const LIVENESS_MS = 15_000;
const BOOT_GRACE_MS = 45_000;
const REPORT_LIMIT = 6_000;

function parseMemory(value: string): number {
	const match = /^(\d+(?:\.\d+)?)([kmgt]?)b?$/i.exec(value.trim());
	if (!match) return 4 * 2 ** 30;
	const scale = { "": 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 }[match[2].toLowerCase() as "" | "k" | "m" | "g" | "t"];
	return Number(match[1]) * scale;
}

function clip(text: string, limit = REPORT_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

const MEMBER_GUIDE = `How a swarm member works:
- Messages starting with [swarm] come from the swarm (the leader, a peer, or swarmd) on the user's behalf; treat them as the user's own messages.
- Stay inside your focus. Before editing a shared area, claim it with swarm_claim; release it when done. If a peer holds it, coordinate with swarm_ask instead of editing.
- Share what others can use: post discoveries, interfaces, pitfalls, and decisions with swarm_post as you find them, not only at the end. Read the board (swarm_board) at the start and at each milestone; tool results tell you when new posts arrived.
- Ask peers or the leader with swarm_ask, and block on replies with swarm_wait instead of ending your turn.
- Improve your own tooling: when you write a script, checklist, or technique worth reusing, publish it with swarm_skill_publish; fetch peers' skills with swarm_skill_fetch.
- Actions outside your worktree that are destructive (deleting or overwriting other paths, force pushes, closing PRs, writes to external services) are held for the user's approval automatically. Use swarm_permission for anything else you are unsure you may do.
- Commit your work on your branch as you go. When your focus is complete, commit everything and call swarm_done with a report: what you did, what you learned, what is left, and how to verify it.`;

export class SwarmDaemon {
	private state!: SwarmState;
	private posts: Post[] = [];
	private readonly dir: string;
	private readonly config = loadConfig();
	private backend!: Backend;
	private info!: DaemonInfo;
	private saveTimer?: ReturnType<typeof setTimeout>;
	private waiters = new Map<string, Set<() => void>>();
	private permissionWaiters = new Map<string, Set<() => void>>();
	private launching = new Set<string>();
	private podStarts = new Map<string, Promise<void>>();
	private cursors: Record<string, number> = {};
	private stopping = false;

	constructor(private readonly id: string) {
		this.dir = runDir(id);
	}

	async start(): Promise<void> {
		this.state = JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")) as SwarmState;
		this.cursors = JSON.parse(await readFile(join(this.dir, "cursors.json"), "utf8").catch(() => "{}")) as Record<string, number>;
		const board = await readFile(join(this.dir, "board.jsonl"), "utf8").catch(() => "");
		this.posts = board
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Post);
		const spec = this.state.spec;
		this.backend =
			spec.backend === "sbx"
				? new SbxBackend(spec, process.env.SWARM_SBX || "sbx", process.env.SWARM_KIT_DIR || join(dirname(new URL(import.meta.url).pathname), "..", "kit"))
				: new LocalBackend(spec, this.dir, process.env.SWARM_HERDR || "herdr", process.env.SWARM_OMO || "omo");

		// Members that were mid-launch when a previous daemon died are relaunched by the scheduler.
		for (const member of this.state.members) if (member.state === "starting") member.state = "queued";

		// Members keep the SWARM_URL and SWARM_TOKEN they launched with, and each pod's network
		// policy opens only the port it was set up with, so a restarted daemon reclaims both.
		const infoPath = join(this.dir, "daemon.json");
		const previous = JSON.parse(await readFile(infoPath, "utf8").catch(() => "{}")) as Partial<DaemonInfo>;
		const token = previous.token ?? randomBytes(24).toString("hex");
		const serve = (port: number) =>
			Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 120, fetch: (request) => this.handle(request, token) });
		let server: ReturnType<typeof serve>;
		try {
			server = serve(previous.port ?? 0);
		} catch {
			server = serve(0);
		}
		this.info = { id: this.id, pid: process.pid, port: server.port!, token, startedAt: nowIso() };
		await writeFile(infoPath, `${JSON.stringify(this.info, null, 2)}\n`, { mode: 0o600 });
		// `mode` only applies when the file is created, and the CLI may have created it first.
		await chmod(infoPath, 0o600);
		const stranded = this.state.members.filter((member) => LIVE_STATES.has(member.state)).map((member) => member.name);
		if (previous.port && previous.port !== this.info.port && stranded.length) {
			await this.system(
				`The board's port ${previous.port} was taken, so it moved to ${this.info.port}. Members still on the old address: ${stranded.join(", ")}. Restart them with swarm_restart.`,
				"leader",
			);
		}

		setInterval(() => void this.schedule().catch((error) => this.system(`scheduler error: ${(error as Error).message}`)), SCHEDULE_MS);
		setInterval(() => void this.checkLiveness().catch(() => undefined), LIVENESS_MS);
		if (spec.backend === "sbx" && existsSync(hostAuthPath())) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			watch(dirname(hostAuthPath()), (_event, file) => {
				if (file !== "auth.json") return;
				clearTimeout(timer);
				timer = setTimeout(() => void this.syncCredentials(), 1_000);
			});
		}
		process.on("SIGTERM", () => void this.shutdown());
		process.on("SIGINT", () => void this.shutdown());
		await this.schedule();
	}

	private async shutdown(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		await this.flush();
		const { port, token } = this.info;
		await writeFile(join(this.dir, "daemon.json"), `${JSON.stringify({ port, token })}\n`).catch(() => undefined);
		process.exit(0);
	}


	private changed(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.flush(), 200);
	}

	private async flush(): Promise<void> {
		clearTimeout(this.saveTimer);
		const tmp = join(this.dir, `.state.${process.pid}.json`);
		await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
		await rename(tmp, join(this.dir, "state.json"));
		await writeFile(join(this.dir, "cursors.json"), `${JSON.stringify(this.cursors)}\n`);
	}

	private member(name: string): Member {
		const member = this.state.members.find((candidate) => candidate.name === name);
		if (!member) throw new HttpError(404, `unknown member "${name}"`);
		return member;
	}

	private touch(member: Member, patch: Partial<Member>): void {
		Object.assign(member, patch, { updatedAt: nowIso() });
		this.changed();
	}


	async post(from: string, kind: PostKind, text: string, to?: string, ref?: number): Promise<Post> {
		const post: Post = { seq: ++this.state.boardSeq, ts: nowIso(), from, kind, to: to || undefined, text: text.trim(), ref, generation: this.state.generation };
		this.posts.push(post);
		await appendFile(join(this.dir, "board.jsonl"), `${JSON.stringify(post)}\n`);
		const author = this.state.members.find((member) => member.name === from);
		if (author) this.touch(author, { lastPost: `[${kind}] ${post.text.slice(0, 160)}` });
		this.changed();
		for (const waiters of this.waiters.values()) for (const wake of waiters) wake();
		return post;
	}

	private system(text: string, to?: string): Promise<Post> {
		return this.post("swarmd", "system", text, to);
	}

	// Broadcasts reach only members still working; a finished member wakes for direct messages.
	private addressedTo(name: string): (post: Post) => boolean {
		const member = this.state.members.find((candidate) => candidate.name === name);
		const takesBroadcast = name !== "leader" && !!member && !FINAL_STATES.has(member.state);
		return (post) => post.from !== name && (post.to === name || (post.to === "*" && takesBroadcast));
	}

	private takeInbox(name: string): Post[] {
		const cursor = this.cursors[name] ?? 0;
		const fresh = this.posts.filter((post) => post.seq > cursor && this.addressedTo(name)(post));
		this.cursors[name] = this.state.boardSeq;
		if (fresh.length) this.changed();
		return fresh;
	}

	private async waitInbox(name: string, timeoutMs: number, signal: AbortSignal): Promise<Post[]> {
		let fresh = this.takeInbox(name);
		const deadline = Date.now() + timeoutMs;
		while (!fresh.length && Date.now() < deadline && !signal.aborted) {
			await new Promise<void>((resolve) => {
				const set = this.waiters.get(name) ?? new Set();
				this.waiters.set(name, set);
				const finish = () => {
					set.delete(finish);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(finish, deadline - Date.now());
				signal.addEventListener("abort", finish, { once: true });
				set.add(finish);
			});
			fresh = this.takeInbox(name);
		}
		return fresh;
	}


	private uniqueName(base: string): string {
		const taken = new Set(this.state.members.map((member) => member.name));
		const root = slug(base, 20);
		if (!taken.has(root) && root !== "leader" && root !== "swarmd") return root;
		for (let index = 2; ; index++) if (!taken.has(`${root}-${index}`)) return `${root}-${index}`;
	}

	private resolveModel(requested?: string): { model: string; thinking?: string; note: string } | undefined {
		if (!requested) return undefined;
		const entry = this.config.pool.find((candidate) => candidate.key === requested);
		if (entry) return { model: entry.models[0], thinking: entry.thinking, note: `pool entry ${entry.key}` };
		return { model: requested, note: "chosen by the leader" };
	}

	private async chooseModel(request: SpawnRequest, criteria: string[]): Promise<{ model: string; thinking: string; note: string }> {
		const explicit = this.resolveModel(request.model);
		if (explicit) return { model: explicit.model, thinking: request.thinking ?? explicit.thinking ?? this.config.member.thinking, note: explicit.note };
		const pool = this.config.pool.filter((entry) => !entry.optIn);
		if (jevApiKey() && pool.length > 1) {
			try {
				const decision = await decideModel(this.config.jev, pool, {
					task: `${request.focus}${request.approach ? `\nApproach: ${request.approach}` : ""}`,
					acceptance: criteria.join("\n") || this.state.spec.goal,
					strategy: this.state.spec.pattern === "parallel" ? "mesh" : "fan_out",
				});
				const entry = pool.find((candidate) => candidate.key === decision.key)!;
				return {
					model: entry.models[0],
					thinking: request.thinking ?? entry.thinking,
					note: `Jev picked ${entry.key} (p=${decision.confidence.toFixed(2)}${decision.escalated ? ", escalated a tier" : ""})`,
				};
			} catch (error) {
				return { ...this.config.member, thinking: request.thinking ?? this.config.member.thinking, note: `Jev unavailable (${(error as Error).message.slice(0, 120)}); default model` };
			}
		}
		return { ...this.config.member, thinking: request.thinking ?? this.config.member.thinking, note: "default member model" };
	}

	async spawn(requests: SpawnRequest[]): Promise<Member[]> {
		const live = this.state.members.filter((member) => !FINAL_STATES.has(member.state)).length;
		if (live + requests.length > this.state.spec.maxMembers) {
			throw new HttpError(409, `maxMembers is ${this.state.spec.maxMembers}; ${live} are live, ${requests.length} requested`);
		}
		const created: Member[] = [];
		for (const request of requests) {
			if (!request.focus?.trim()) throw new HttpError(400, "every member needs a focus");
			const criteria = request.criteria?.length ? request.criteria : this.state.spec.criteria;
			const choice = await this.chooseModel(request, criteria);
			const name = this.uniqueName(request.name ?? request.focus);
			const parents = request.parents ?? [];
			const member: Member = {
				name,
				generation: this.state.generation,
				focus: request.focus.trim(),
				approach: request.approach?.trim() || undefined,
				criteria,
				parents,
				model: choice.model,
				thinking: choice.thinking,
				modelNote: choice.note,
				state: "queued",
				pod: "",
				branch: `swarm/${this.state.spec.id}/${name}`,
				startRef: parents[0] ? this.member(parents[0]).branch : this.state.spec.base,
				billing: [],
				updatedAt: nowIso(),
			};
			this.state.members.push(member);
			created.push(member);
		}
		this.changed();
		await this.system(`Spawned generation ${this.state.generation}: ${created.map((member) => `${member.name} (${member.model}:${member.thinking})`).join(", ")}`);
		void this.schedule();
		return created;
	}

	private maxPods(): number {
		const budget = totalmem() * this.config.hostMemoryShare;
		return Math.max(1, Math.floor(budget / parseMemory(this.state.spec.podMemory)));
	}

	private assignPod(): string | undefined {
		if (this.backend.kind === "local") return "local";
		const occupancy = new Map<string, number>();
		for (const pod of Object.keys(this.state.pods)) if (this.state.pods[pod].state !== "failed") occupancy.set(pod, 0);
		for (const member of this.state.members) {
			if (member.pod && occupancy.has(member.pod) && (LIVE_STATES.has(member.state) || this.launching.has(member.name))) {
				occupancy.set(member.pod, occupancy.get(member.pod)! + 1);
			}
		}
		for (const [pod, count] of occupancy) if (count < this.backend.podCapacity()) return pod;
		if (occupancy.size >= this.maxPods()) return undefined;
		for (let index = 1; ; index++) {
			const pod = `swarm-${this.state.spec.id.slice(0, 8)}-p${index}`;
			if (!this.state.pods[pod] || this.state.pods[pod].state === "failed") return pod;
		}
	}

	private ensurePod(pod: string): Promise<void> {
		const existing = this.podStarts.get(pod);
		if (existing) return existing;
		this.state.pods[pod] = { state: "creating" };
		this.changed();
		const started = this.backend
			.ensurePod(pod, this.info.port)
			.then(({ root }) => {
				this.state.pods[pod] = { state: "ready", root };
				this.changed();
			})
			.catch(async (error: Error) => {
				this.state.pods[pod] = { state: "failed", error: error.message.slice(0, 600) };
				this.podStarts.delete(pod);
				this.changed();
				await this.system(`Pod ${pod} failed to start: ${error.message.slice(0, 400)}`, "leader");
				throw error;
			});
		this.podStarts.set(pod, started);
		return started;
	}

	private async schedule(): Promise<void> {
		if (this.state.status !== "active") return;
		for (const member of this.state.members) {
			if (member.state !== "queued" || this.launching.has(member.name)) continue;
			const pod = member.pod && this.state.pods[member.pod]?.state !== "failed" ? member.pod : this.assignPod();
			if (!pod) return;
			member.pod = pod;
			this.launching.add(member.name);
			void this.launch(member).finally(() => this.launching.delete(member.name));
		}
	}

	private async launch(member: Member, resume = false): Promise<void> {
		this.touch(member, { state: "starting", attention: undefined });
		try {
			let root = this.state.spec.repo;
			if (this.backend.kind === "sbx") {
				await this.ensurePod(member.pod);
				root = this.state.pods[member.pod].root!;
			}
			const worktree = await this.backend.prepareWorktree(member, root);
			this.touch(member, { worktree });
			const env: Record<string, string> = {
				SWARM_ROLE: "member",
				SWARM_ID: this.state.spec.id,
				SWARM_MEMBER: member.name,
				SWARM_URL: this.backend.boardUrl(this.info.port),
				SWARM_TOKEN: this.info.token,
				SWARM_WORKTREE: worktree,
				OMO_CODING_AGENT_DIR: this.backend.agentDir(member),
			};
			let agentFiles: Record<string, string> | undefined;
			if (this.backend.kind === "sbx") {
				env.PI_OFFLINE = "1";
				agentFiles = { "auth.json": await podAuth(this.billingPlaceholders(member)), "settings.json": podSettings(member.model, member.thinking) };
			}
			await this.backend.launch({ member, env, resume, agentFiles });
			this.touch(member, { state: "running", startedAt: nowIso() });
		} catch (error) {
			this.touch(member, { state: "failed", attention: `launch failed: ${(error as Error).message.slice(0, 300)}` });
			await this.system(`${member.name} failed to launch: ${(error as Error).message.slice(0, 400)}`, "leader");
		}
	}

	private billingPlaceholders(member: Member): Record<string, string> {
		return Object.fromEntries(member.billing.map((provider) => [provider, this.placeholder(member.pod, provider)]));
	}

	private placeholder(pod: string, provider: string): string {
		const stem = provider === "anthropic" ? "sk-ant-api03-swarm" : "sk-swarm";
		return `${stem}-${this.state.spec.id.slice(0, 8)}-${slug(pod, 40)}-placeholder`;
	}

	private async checkLiveness(): Promise<void> {
		for (const member of this.state.members) {
			if (!LIVE_STATES.has(member.state) || member.state === "starting" || this.launching.has(member.name)) continue;
			if (member.startedAt && Date.now() - Date.parse(member.startedAt) < BOOT_GRACE_MS) continue;
			if (!(await this.backend.alive(member))) {
				this.touch(member, { state: "failed", attention: "the member's process exited" });
				await this.system(`${member.name} exited unexpectedly. Attach to read its pane, or restart it with swarm_restart.`, "leader");
			}
		}
		await this.checkGeneration();
	}

	private async syncCredentials(): Promise<void> {
		for (const member of this.state.members) {
			if (!LIVE_STATES.has(member.state) || !member.pod) continue;
			const auth = await podAuth(this.billingPlaceholders(member));
			await this.backend.writeAgentFiles(member, { "auth.json": auth }).catch(() => undefined);
		}
	}

	assignment(name: string): MemberAssignment {
		const member = this.member(name);
		const spec = this.state.spec;
		const peers = this.state.members.filter((peer) => peer.name !== name && peer.generation === member.generation);
		const previous = this.state.generations.at(-1);
		const parents = member.parents.map((parentName) => this.state.members.find((candidate) => candidate.name === parentName)).filter((parent): parent is Member => !!parent);
		const lines = [
			`You are ${member.name}, one member of a swarm working toward a shared goal.`,
			`Goal: ${spec.goal}`,
			"",
			spec.pattern === "evolve"
				? `Pattern: evolve. This is generation ${member.generation}${spec.maxGenerations ? ` of up to ${spec.maxGenerations}` : ""}. Several members attack the goal with different approaches; the fittest results seed the next generation. Make your approach count and report honestly what worked and what did not.`
				: "Pattern: parallel. Each member owns a different part of the goal; share knowledge so the parts fit together.",
			`Your focus: ${member.focus}`,
			member.approach ? `Approach to try: ${member.approach}` : undefined,
			member.criteria.length ? `Acceptance criteria:\n${member.criteria.map((criterion) => `- ${criterion}`).join("\n")}` : undefined,
			spec.fitnessCommand ? `Fitness check run on your worktree when you finish: \`${spec.fitnessCommand}\`` : undefined,
			"",
			`Your worktree is ${member.worktree} on branch ${member.branch}, starting from ${member.startRef}.`,
			parents.length ? `\nYou build on the previous generation's survivors:\n${parents.map((parent) => `- ${parent.name} (fitness ${parent.fitness?.score.toFixed(2) ?? "n/a"}, branch ${parent.branch}): ${clip(parent.report ?? "(no report)", 1500)}`).join("\n")}` : undefined,
			previous?.lessons ? `\nLessons from generation ${previous.generation}:\n${previous.lessons}` : undefined,
			this.state.skills.length ? `\nShared skills (swarm_skill_fetch to use one): ${this.state.skills.map((skill) => `${skill.name} (${skill.description})`).join("; ")}` : undefined,
			peers.length ? `\nPeers this generation:\n${peers.map(memberLine).join("\n")}` : undefined,
			"",
			"Start by reading the board (swarm_board), then work your focus.",
		].filter((line): line is string => line !== undefined);
		return {
			name,
			model: member.model,
			thinking: member.thinking,
			modelNote: member.modelNote,
			worktree: member.worktree ?? "",
			branch: member.branch,
			prompt: `${RELAY_PREFIX}${lines.join("\n")}`,
			systemPrompt: MEMBER_GUIDE,
		};
	}


	private async evidence(member: Member): Promise<{ changed_files: string; diff_stat: string; commits_since_start: string; dirty: string }> {
		const start = member.startRef ?? this.state.spec.base;
		const script = [
			`git diff --name-only ${start}..HEAD`,
			"echo @@SWARM@@",
			`git diff --stat ${start}..HEAD | tail -n 40`,
			"echo @@SWARM@@",
			`git log --oneline ${start}..HEAD | head -n 40`,
			"echo @@SWARM@@",
			"git status --porcelain | head -n 40",
		].join("; ");
		const result = await this.backend.exec(member, script, 60_000);
		const [changed_files = "", diff_stat = "", commits_since_start = "", dirty = ""] = result.stdout.split("@@SWARM@@\n").map((part) => part.trim());
		return { changed_files, diff_stat, commits_since_start, dirty };
	}

	async done(name: string, report: string, tools: string[]): Promise<{ ok: boolean; message: string }> {
		const member = this.member(name);
		const evidence = await this.evidence(member);
		if (evidence.dirty) {
			return { ok: false, message: `Uncommitted changes in your worktree:\n${evidence.dirty}\nCommit them on ${member.branch} (or discard what you do not need), then call swarm_done again.` };
		}
		this.touch(member, { state: "done", report: clip(report), attention: undefined });
		await this.post(name, "report", clip(report, 2_000), "leader");
		void this.score(member, report, tools, evidence);
		return { ok: true, message: "Reported. The swarm gates your result; stay available: the leader or peers may still message you." };
	}

	private async score(member: Member, report: string, tools: string[], evidence: { changed_files: string; diff_stat: string; commits_since_start: string }): Promise<void> {
		const parts: number[] = [];
		const fitness: Fitness = { score: 0, note: "" };
		const notes: string[] = [];
		if (this.state.spec.fitnessCommand) {
			const result = await this.backend.exec(member, this.state.spec.fitnessCommand, this.config.fitnessTimeoutSeconds * 1000);
			const numbers = result.stdout.trim().match(/-?\d+(?:\.\d+)?/g);
			const last = numbers ? Number(numbers.at(-1)) : Number.NaN;
			const score = Number.isFinite(last) && last >= 0 && last <= 1 ? last : result.code === 0 ? 1 : 0;
			fitness.command = { score, output: clip(`${result.stdout}\n${result.stderr}`.trim(), 1_500) };
			parts.push(score);
			notes.push(`fitness command ${score.toFixed(2)} (exit ${result.code})`);
		}
		if (jevApiKey() && member.criteria.length) {
			try {
				const verdict = await gateResult(this.config.jev, { task: `${this.state.spec.goal}\nFocus: ${member.focus}`, criteria: member.criteria }, report, { ...evidence, tool_calls: tools.join("\n") });
				fitness.jev = verdict.criteria;
				fitness.blocked = verdict.blocked;
				const mean = verdict.criteria.reduce((sum, item) => sum + item.p, 0) / Math.max(1, verdict.criteria.length);
				parts.push(mean);
				notes.push(`Jev criteria mean ${mean.toFixed(2)}${verdict.blocked >= this.config.jev.blockedThreshold ? `, blocked p=${verdict.blocked.toFixed(2)}` : ""}`);
			} catch (error) {
				notes.push(`Jev unavailable: ${(error as Error).message.slice(0, 160)}`);
			}
		}
		fitness.score = parts.length ? parts.reduce((sum, value) => sum + value, 0) / parts.length : 0.5;
		fitness.note = notes.join("; ") || "ungated (no fitness command and no TYPESAFE_API_KEY)";
		const blocked = (fitness.blocked ?? 0) >= this.config.jev.blockedThreshold;
		const misses = fitness.jev?.filter((item) => item.p < this.config.jev.acceptThreshold).map((item) => item.criterion) ?? [];
		this.touch(member, { fitness, attention: blocked ? "reports it is blocked" : undefined });
		await this.system(
			`${member.name} finished: fitness ${fitness.score.toFixed(2)} (${fitness.note}).${misses.length ? ` Unmet: ${misses.join("; ")}.` : ""}${blocked ? " It reports being blocked." : ""}`,
			"leader",
		);
		await this.checkGeneration();
	}

	private async checkGeneration(): Promise<void> {
		const generation = this.state.generation;
		const members = this.state.members.filter((member) => member.generation === generation);
		if (!members.length || members.some((member) => !FINAL_STATES.has(member.state) || (member.state === "done" && !member.fitness))) return;
		if (this.state.generations.some((record) => record.generation === generation && record.completedAt)) return;
		const ranking = [...members].sort((a, b) => (b.fitness?.score ?? -1) - (a.fitness?.score ?? -1));
		const record = this.state.generations.find((candidate) => candidate.generation === generation);
		if (record) record.completedAt = nowIso();
		else this.state.generations.push({ generation, members: members.map((member) => member.name), survivors: [], lessons: "", completedAt: nowIso() });
		this.changed();
		await this.system(
			[
				`Generation ${generation} is complete. Ranking:`,
				...ranking.map((member) => `- ${member.name}: ${member.state}${member.fitness ? ` fitness ${member.fitness.score.toFixed(2)}` : ""} (${member.focus.slice(0, 80)})`),
				this.state.spec.pattern === "evolve"
					? generation >= this.state.spec.maxGenerations
						? "This was the last allowed generation: collect and integrate the best result."
						: "Next: swarm_evolve with survivors, lessons, and the next population, or stop evolving and integrate."
					: "Next: swarm_collect, then integrate the branches.",
			].join("\n"),
			"leader",
		);
	}

	async evolve(survivors: string[], lessons: string, population: SpawnRequest[]): Promise<Member[]> {
		if (this.state.spec.pattern === "evolve" && this.state.generation >= this.state.spec.maxGenerations) {
			throw new HttpError(409, `maxGenerations (${this.state.spec.maxGenerations}) reached`);
		}
		for (const name of survivors) this.member(name);
		if (!population.length) throw new HttpError(400, "population is empty");
		const current = this.state.generation;
		for (const member of this.state.members) {
			if (member.generation === current && LIVE_STATES.has(member.state)) {
				this.touch(member, { state: "stopped" });
				await this.backend.stop(member).catch(() => undefined);
			}
		}
		await this.collect();
		const record = this.state.generations.find((candidate) => candidate.generation === current);
		if (record) Object.assign(record, { survivors, lessons });
		else this.state.generations.push({ generation: current, members: this.state.members.filter((member) => member.generation === current).map((member) => member.name), survivors, lessons, completedAt: nowIso() });
		this.state.generation = current + 1;
		this.changed();
		await this.post("leader", "lesson", `Generation ${current} -> ${current + 1}. Survivors: ${survivors.join(", ") || "none"}.\n${lessons}`, "*");
		return this.spawn(
			population.map((request, index) => ({
				...request,
				parents: request.parents ?? (survivors.length ? [survivors[index % survivors.length]] : []),
			})),
		);
	}

	async collect(): Promise<{ repo: string; branches: { member: string; branch: string; generation: number; state: string; fitness?: number }[] }> {
		const pods = [...new Set(this.state.members.map((member) => member.pod).filter((pod) => pod && this.state.pods[pod]?.state === "ready"))];
		await this.backend.collect(pods);
		const branches: { member: string; branch: string; generation: number; state: string; fitness?: number }[] = [];
		for (const member of this.state.members) {
			const exists = await run("git", ["-C", this.state.spec.repo, "rev-parse", "--verify", "-q", `refs/heads/${member.branch}`]);
			if (exists.code === 0) branches.push({ member: member.name, branch: member.branch, generation: member.generation, state: member.state, fitness: member.fitness?.score });
		}
		return { repo: this.state.spec.repo, branches };
	}


	async requestPermission(from: string, action: string, reason: string, scope: Permission["scope"]): Promise<Permission> {
		const permission: Permission = { id: randomUUID().slice(0, 8), from, action: action.slice(0, 2_000), reason: reason.slice(0, 1_000), scope, state: "pending", ts: nowIso() };
		this.state.permissions.push(permission);
		const member = this.state.members.find((candidate) => candidate.name === from);
		if (member) this.touch(member, { attention: `permission ${permission.id}: ${action.slice(0, 80)}` });
		this.changed();
		await this.post(from, "request", `Permission ${permission.id} (${scope === "out" ? "out of scope, needs the user" : "leader decides"}): ${action}\nWhy: ${reason}`, "leader");
		return permission;
	}

	async decide(id: string, approve: boolean, by: string, note?: string): Promise<Permission> {
		const permission = this.state.permissions.find((candidate) => candidate.id === id);
		if (!permission) throw new HttpError(404, `unknown permission ${id}`);
		if (permission.state !== "pending") return permission;
		if (permission.scope === "out" && by !== "user") throw new HttpError(403, "out-of-scope actions need the user's decision");
		Object.assign(permission, { state: approve ? "approved" : "denied", decidedBy: by, note });
		const member = this.state.members.find((candidate) => candidate.name === permission.from);
		if (member?.attention?.startsWith(`permission ${id}`)) this.touch(member, { attention: undefined });
		this.changed();
		for (const wake of this.permissionWaiters.get(id) ?? []) wake();
		await this.post(by, "decision", `Permission ${id} ${permission.state}${note ? `: ${note}` : ""}`, permission.from);
		return permission;
	}

	private async waitPermission(id: string, timeoutMs: number, signal: AbortSignal): Promise<Permission> {
		const find = () => this.state.permissions.find((candidate) => candidate.id === id);
		const deadline = Date.now() + timeoutMs;
		while (find()?.state === "pending" && Date.now() < deadline && !signal.aborted) {
			await new Promise<void>((resolve) => {
				const set = this.permissionWaiters.get(id) ?? new Set();
				this.permissionWaiters.set(id, set);
				const finish = () => {
					set.delete(finish);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(finish, deadline - Date.now());
				signal.addEventListener("abort", finish, { once: true });
				set.add(finish);
			});
		}
		const permission = find();
		if (!permission) throw new HttpError(404, `unknown permission ${id}`);
		return permission;
	}

	async claim(owner: string, area: string): Promise<{ ok: boolean; owner: string }> {
		const key = area.trim();
		const held = this.state.claims.find((claim) => claim.area === key);
		if (held && held.owner !== owner) return { ok: false, owner: held.owner };
		if (!held) {
			this.state.claims.push({ area: key, owner, ts: nowIso() });
			this.changed();
			await this.post(owner, "claim", `claimed ${key}`);
		}
		return { ok: true, owner };
	}

	async release(owner: string, area: string): Promise<void> {
		const before = this.state.claims.length;
		this.state.claims = this.state.claims.filter((claim) => !(claim.area === area.trim() && claim.owner === owner));
		if (this.state.claims.length !== before) {
			this.changed();
			await this.post(owner, "claim", `released ${area.trim()}`);
		}
	}

	async publishSkill(author: string, name: string, description: string, files: Record<string, string>): Promise<Skill> {
		const skillName = slug(name, 40);
		const root = join(this.dir, "skills", skillName);
		if (!Object.keys(files).some((path) => path.endsWith("SKILL.md"))) {
			files = { "SKILL.md": `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${files[Object.keys(files)[0]] ?? description}\n`, ...files };
		}
		for (const [relative, content] of Object.entries(files)) {
			const target = normalize(join(root, relative));
			if (!target.startsWith(`${root}/`)) throw new HttpError(400, `skill file escapes its directory: ${relative}`);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content);
		}
		const skill: Skill = { name: skillName, description: description.slice(0, 300), author, generation: this.state.generation, files: Object.keys(files), ts: nowIso() };
		this.state.skills = [...this.state.skills.filter((candidate) => candidate.name !== skillName), skill];
		this.changed();
		await this.post(author, "skill", `published skill "${skillName}": ${skill.description}`, "*");
		return skill;
	}

	async fetchSkill(name: string): Promise<{ skill: Skill; files: Record<string, string> }> {
		const skill = this.state.skills.find((candidate) => candidate.name === name);
		if (!skill) throw new HttpError(404, `unknown skill ${name}`);
		const files: Record<string, string> = {};
		for (const relative of skill.files) files[relative] = await readFile(join(this.dir, "skills", name, relative), "utf8");
		return { skill, files };
	}


	async stopMembers(names?: string[]): Promise<string[]> {
		const targets = this.state.members.filter((member) => (names?.length ? names.includes(member.name) : true) && !FINAL_STATES.has(member.state));
		for (const member of targets) {
			const queued = member.state === "queued";
			this.touch(member, { state: "stopped" });
			if (!queued) await this.backend.stop(member).catch(() => undefined);
		}
		if (!names?.length) this.state.status = "stopped";
		this.changed();
		if (targets.length) await this.system(`Stopped: ${targets.map((member) => member.name).join(", ")}`);
		return targets.map((member) => member.name);
	}

	async restart(name: string, billing?: string[]): Promise<Member> {
		const member = this.member(name);
		if (billing?.length) {
			for (const provider of billing) {
				const envName = BILLING_ENV[provider];
				if (!envName) throw new HttpError(400, `no billing fallback for provider ${provider}`);
				const value = process.env[envName];
				if (!value) throw new HttpError(400, `${envName} is not set in the swarm daemon's environment`);
				await this.backend.setBillingSecret(member.pod, provider, this.placeholder(member.pod, provider), value);
			}
			member.billing = [...new Set([...member.billing, ...billing])];
		}
		this.touch(member, { state: "starting" });
		await this.backend.stop(member).catch(() => undefined);
		this.state.status = "active";
		this.launching.add(member.name);
		await this.launch(member, true).finally(() => this.launching.delete(member.name));
		await this.system(`${member.name} restarted${billing?.length ? ` with API billing for ${billing.join(", ")}` : ""}.`);
		return member;
	}

	async destroy(): Promise<void> {
		await this.stopMembers();
		await this.collect().catch(() => undefined);
		await this.backend.destroy(Object.keys(this.state.pods));
		for (const pod of Object.keys(this.state.pods)) this.state.pods[pod] = { state: "failed", error: "removed" };
		this.changed();
	}

	snapshot(): SwarmState & { daemon: DaemonInfo; maxPods: number; attach: Record<string, string[]> } {
		return {
			...this.state,
			daemon: { ...this.info, token: "" },
			maxPods: this.maxPods(),
			attach: Object.fromEntries(this.state.members.filter((member) => member.pod).map((member) => [member.name, this.backend.attachCommand(member)])),
		};
	}


	private async handle(request: Request, token: string): Promise<Response> {
		if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
		try {
			return json(await this.route(request));
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			return json({ error: (error as Error).message }, status);
		}
	}

	private async route(request: Request): Promise<unknown> {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
		const query = (key: string) => url.searchParams.get(key) ?? undefined;
		const seconds = (key: string, fallback: number, max: number) => Math.min(max, Math.max(0, Number(query(key) ?? fallback))) * 1000;
		const [head, arg, tail] = parts;

		switch (`${request.method} ${head ?? ""}${tail ? ` ${tail}` : ""}`) {
			case "GET state":
				return this.snapshot();
			case "GET board": {
				const after = Number(query("after") ?? 0);
				const kinds = query("kinds")?.split(",").filter((kind) => POST_KINDS.includes(kind as PostKind));
				const from = query("from");
				const limit = Math.min(500, Number(query("limit") ?? 100));
				const posts = this.posts.filter((post) => post.seq > after && (!kinds?.length || kinds.includes(post.kind)) && (!from || post.from === from));
				return { posts: posts.slice(-limit), seq: this.state.boardSeq };
			}
			case "GET inbox":
				return { posts: await this.waitInbox(arg, seconds("timeout", 25, 60), request.signal), seq: this.state.boardSeq };
			case "POST post": {
				const kind = (POST_KINDS.includes(body.kind) ? body.kind : "status") as PostKind;
				if (!body.text?.trim()) throw new HttpError(400, "text is required");
				if (body.to && body.to !== "*" && body.to !== "leader") this.member(body.to);
				return this.post(String(body.from ?? "leader"), kind, String(body.text), body.to, body.ref);
			}
			case "GET assignment":
				return this.assignment(arg);
			case "POST member event": {
				const member = this.member(arg);
				if (body.type === "ready") {
					if (member.state === "starting") this.touch(member, { state: "running" });
				} else if (body.type === "busy") {
					if (member.state === "idle" || (member.state === "done" && body.reopen)) this.touch(member, { state: "running", attention: undefined });
				} else if (body.type === "idle") {
					if (member.state === "running") this.touch(member, { state: "idle", lastPost: `[idle] ${String(body.text ?? "").slice(0, 160)}` });
				} else if (body.type === "exit") {
					if (LIVE_STATES.has(member.state)) this.touch(member, { state: "failed", attention: "the member's session ended" });
				}
				return { ok: true };
			}
			case "POST member done":
				return this.done(arg, String(body.report ?? ""), Array.isArray(body.tools) ? body.tools.map(String) : []);
			case "POST member restart":
				return this.restart(arg, Array.isArray(body.billing) ? body.billing.map(String) : undefined);
			case "POST configure": {
				const spec = this.state.spec;
				if (body.pattern === "parallel" || body.pattern === "evolve") spec.pattern = body.pattern;
				if (Number(body.maxGenerations) > 0) spec.maxGenerations = Number(body.maxGenerations);
				else if (body.pattern === "evolve" && spec.maxGenerations < 2) spec.maxGenerations = this.config.maxGenerations;
				if (Array.isArray(body.criteria)) spec.criteria = body.criteria.map(String);
				if (typeof body.fitnessCommand === "string") spec.fitnessCommand = body.fitnessCommand.trim() || undefined;
				if (Number(body.maxMembers) > 0) spec.maxMembers = Number(body.maxMembers);
				this.changed();
				await this.post("leader", "decision", `Swarm configured: pattern ${spec.pattern}, up to ${spec.maxGenerations} generation(s), ${spec.maxMembers} members.${spec.criteria.length ? `\nCriteria:\n${spec.criteria.map((criterion) => `- ${criterion}`).join("\n")}` : ""}${spec.fitnessCommand ? `\nFitness command: ${spec.fitnessCommand}` : ""}`, "*");
				return spec;
			}
			case "POST spawn":
				return { members: await this.spawn(Array.isArray(body.members) ? body.members : []) };
			case "POST evolve":
				return { members: await this.evolve(Array.isArray(body.survivors) ? body.survivors : [], String(body.lessons ?? ""), Array.isArray(body.population) ? body.population : []) };
			case "POST collect":
				return this.collect();
			case "POST stop":
				return { stopped: await this.stopMembers(Array.isArray(body.members) ? body.members : undefined) };
			case "POST resume": {
				this.state.status = "active";
				for (const member of this.state.members) if (member.state === "stopped" && body.members?.includes(member.name)) member.state = "queued";
				this.changed();
				void this.schedule();
				return { ok: true };
			}
			case "POST destroy":
				await this.destroy();
				return { ok: true };
			case "POST shutdown":
				setTimeout(() => void this.shutdown(), 100);
				return { ok: true };
			case "POST permission":
				return this.requestPermission(String(body.from), String(body.action ?? ""), String(body.reason ?? ""), body.scope === "out" ? "out" : "ask");
			case "GET permission":
				return this.waitPermission(arg, seconds("wait", 0, 60), request.signal);
			case "GET permissions":
				return { permissions: this.state.permissions.filter((permission) => !query("state") || permission.state === query("state")) };
			case "POST permission decide":
				return this.decide(arg, body.approve === true, String(body.by ?? "leader"), body.note ? String(body.note) : undefined);
			case "POST claim":
				return this.claim(String(body.owner), String(body.area ?? ""));
			case "POST release":
				await this.release(String(body.owner), String(body.area ?? ""));
				return { ok: true };
			case "POST skill":
				return this.publishSkill(String(body.author), String(body.name ?? ""), String(body.description ?? ""), (body.files ?? {}) as Record<string, string>);
			case "GET skills":
				return { skills: this.state.skills };
			case "GET skill":
				return this.fetchSkill(arg);
			default:
				throw new HttpError(404, `no route ${request.method} ${url.pathname}`);
		}
	}
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value ?? null), { status, headers: { "Content-Type": "application/json" } });
}

