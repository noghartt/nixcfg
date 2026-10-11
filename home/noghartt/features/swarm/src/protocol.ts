// Shared vocabulary of the swarm daemon, its CLI, and the OmO extension (leader and members).
// Pure data and a tiny HTTP client: no engine imports, so Bun and OmO can both load it.

import { homedir } from "node:os";
import { join } from "node:path";

export type Pattern = "parallel" | "evolve";
export type BackendKind = "sbx" | "local";

export type MemberState = "queued" | "starting" | "running" | "idle" | "done" | "failed" | "stopped";
export const LIVE_STATES: ReadonlySet<MemberState> = new Set(["starting", "running", "idle"]);
export const FINAL_STATES: ReadonlySet<MemberState> = new Set(["done", "failed", "stopped"]);

export type PostKind =
	| "discovery"
	| "status"
	| "question"
	| "answer"
	| "request"
	| "lesson"
	| "decision"
	| "skill"
	| "claim"
	| "report"
	| "system";
export const POST_KINDS: readonly PostKind[] = [
	"discovery",
	"status",
	"question",
	"answer",
	"request",
	"lesson",
	"decision",
	"skill",
	"claim",
	"report",
	"system",
];

export interface Post {
	seq: number;
	ts: string;
	from: string;
	kind: PostKind;
	// A member name, "leader", or "*". Addressed posts are pushed into the recipient's session;
	// unaddressed ones stay on the board for whoever reads it.
	to?: string;
	text: string;
	ref?: number;
	generation: number;
}

export interface Fitness {
	score: number;
	jev?: { criterion: string; p: number }[];
	blocked?: number;
	command?: { score: number; output: string };
	note: string;
}

export interface Member {
	name: string;
	generation: number;
	focus: string;
	approach?: string;
	criteria: string[];
	parents: string[];
	model: string;
	thinking: string;
	modelNote: string;
	state: MemberState;
	pod: string;
	branch: string;
	worktree?: string;
	startRef?: string;
	report?: string;
	fitness?: Fitness;
	attention?: string;
	lastPost?: string;
	billing: string[];
	startedAt?: string;
	updatedAt: string;
}

export interface Permission {
	id: string;
	from: string;
	action: string;
	reason: string;
	// "out": outside the member's scope and destructive, so the user double-checks it.
	// "ask": an explicit request the leader judges.
	scope: "out" | "ask";
	state: "pending" | "approved" | "denied";
	decidedBy?: string;
	note?: string;
	ts: string;
}

export interface Skill {
	name: string;
	description: string;
	author: string;
	generation: number;
	files: string[];
	ts: string;
}

export interface Claim {
	area: string;
	owner: string;
	ts: string;
}

export interface GenerationRecord {
	generation: number;
	members: string[];
	survivors: string[];
	lessons: string;
	completedAt?: string;
}

export interface SwarmSpec {
	id: string;
	goal: string;
	repo: string;
	base: string;
	pattern: Pattern;
	backend: BackendKind;
	criteria: string[];
	fitnessCommand?: string;
	podSize: number;
	podMemory: string;
	maxMembers: number;
	maxGenerations: number;
	createdAt: string;
}

export interface SwarmState {
	spec: SwarmSpec;
	generation: number;
	members: Member[];
	permissions: Permission[];
	claims: Claim[];
	skills: Skill[];
	generations: GenerationRecord[];
	pods: Record<string, { state: "creating" | "ready" | "failed"; error?: string; root?: string }>;
	status: "active" | "stopped";
	boardSeq: number;
}

export interface DaemonInfo {
	id: string;
	pid: number;
	port: number;
	token: string;
	startedAt: string;
}

export interface MemberAssignment {
	name: string;
	model: string;
	thinking: string;
	modelNote: string;
	worktree: string;
	branch: string;
	prompt: string;
	systemPrompt: string;
}

export interface SpawnRequest {
	name?: string;
	focus: string;
	approach?: string;
	criteria?: string[];
	model?: string;
	thinking?: string;
	parents?: string[];
}

export const RELAY_PREFIX = "[swarm] ";

export function swarmsRoot(): string {
	return process.env.SWARM_HOME || join(homedir(), ".omo", "swarms");
}

export function runDir(id: string): string {
	return join(swarmsRoot(), id);
}

export function slug(value: string, max = 24): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/, "") || "member"
	);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export class SwarmClient {
	constructor(
		readonly baseUrl: string,
		private readonly token: string,
	) {}

	static fromInfo(info: DaemonInfo, host = "127.0.0.1"): SwarmClient {
		return new SwarmClient(`http://${host}:${info.port}`, info.token);
	}

	async call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`swarm ${method} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`);
		return (text ? JSON.parse(text) : undefined) as T;
	}

	get<T>(path: string, signal?: AbortSignal): Promise<T> {
		return this.call<T>("GET", path, undefined, signal);
	}

	post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		return this.call<T>("POST", path, body, signal);
	}
}

export function formatPost(post: Post): string {
	const to = post.to ? ` -> ${post.to}` : "";
	const ref = post.ref ? ` (re #${post.ref})` : "";
	return `#${post.seq} [${post.kind}] ${post.from}${to}${ref}: ${post.text}`;
}

export function memberLine(member: Member): string {
	const fit = member.fitness ? ` fitness=${member.fitness.score.toFixed(2)}` : "";
	const attention = member.attention ? ` needs: ${member.attention}` : "";
	return `- ${member.name} [g${member.generation} ${member.state} ${member.model}:${member.thinking}${fit}] ${member.focus.slice(0, 120)}${attention}`;
}
