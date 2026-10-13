// Jev (TypeSafe's System One decision model) decides the orchestration's control
// flow: execution strategy, worker model, and whether a worker's result is
// accepted. It never writes text; every question is one atomic judgment and the
// branching stays in code, as https://docs.typesafe.ai recommends.
//
// Calls the documented HTTP endpoint directly, so Pi and OmO behave the same and
// the only dependency is TYPESAFE_API_KEY, not each harness's classifier registry.

export interface JevConfig {
	model: string;
	baseUrl: string;
	strategyConfidence: number;
	modelConfidence: number;
	// Below it a placement, net, or size answer falls back to the default.
	placementConfidence: number;
	// At or above it an env key counts as needed.
	envThreshold: number;
	acceptThreshold: number;
	blockedThreshold: number;
	// Below this a failing criterion is a clear miss; between it and acceptThreshold, borderline.
	borderlineFloor: number;
}

export interface PoolEntry {
	key: string;
	models: string[];
	thinking: string;
	tier: number;
	use: string;
}

type Question =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "noul"; instructions: string };

type Answer =
	| { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| { type: "noul"; noul: number };

export type Strategy = "solo" | "fan_out" | "mesh";

export interface StrategyDecision {
	strategy: Strategy;
	confidence: number;
	probabilities: Record<string, number>;
	needsClarification: number;
}

export interface ModelDecision {
	key: string;
	confidence: number;
	probabilities: Record<string, number>;
	escalated: boolean;
}

export interface GateVerdict {
	criteria: { criterion: string; p: number }[];
	blocked: number;
	// A warning for the leader, not part of the decision.
	unrelatedChanges: number;
}

/** Facts the orchestrator collected itself, so Jev checks claims instead of trusting prose. */
export interface GateEvidence {
	changed_files: string;
	diff_stat: string;
	commits_since_start: string;
	tool_calls: string;
}

export const MAX_CRITERIA = 8;

const STATE_LIMIT = 16_000;

function clip(text: string): string {
	return text.length > STATE_LIMIT ? `${text.slice(0, STATE_LIMIT)}\n[truncated]` : text;
}

export function jevApiKey(): string | undefined {
	return process.env.TYPESAFE_API_KEY || undefined;
}

async function ask(
	config: JevConfig,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
	signal?: AbortSignal,
): Promise<Record<string, Answer>> {
	const apiKey = jevApiKey();
	if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
	const baseUrl = (process.env.TYPESAFE_BASE_URL || config.baseUrl).replace(/\/+$/, "");
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(`${baseUrl}/v1/systemone`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: config.model, state, questions }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${body.slice(0, 500)}`);
	const answers = (JSON.parse(body) as { answers?: Record<string, Answer> }).answers;
	if (!answers) throw new Error(`Jev response has no answers: ${body.slice(0, 500)}`);
	for (const id of Object.keys(questions)) {
		if (answers[id]?.type !== questions[id].type) throw new Error(`Jev answer "${id}" is missing or mistyped`);
	}
	return answers;
}

function choice(answers: Record<string, Answer>, id: string) {
	return answers[id] as Extract<Answer, { type: "choice" }>;
}

function noul(answers: Record<string, Answer>, id: string): number {
	return (answers[id] as Extract<Answer, { type: "noul" }>).noul;
}

export async function decideStrategy(config: JevConfig, goal: string, signal?: AbortSignal): Promise<StrategyDecision> {
	const answers = await ask(
		config,
		{ goal: clip(goal) },
		{
			strategy: {
				type: "choice",
				instructions: "How should a team of coding agents execute the software work described in `goal`?",
				criteria: {
					solo: "One agent does it best: a small or tightly coupled change, a question, or an investigation",
					fan_out: "It splits into independent parts that need no communication while being worked on",
					mesh: "It splits into parallel parts that share interfaces or files and must coordinate while working",
				},
			},
			needs_clarification: {
				type: "noul",
				instructions: "`goal` is too ambiguous to start work without first asking the user a question.",
			},
		},
		signal,
	);
	const answer = choice(answers, "strategy");
	return {
		strategy: answer.choice as Strategy,
		confidence: answer.confidence,
		probabilities: answer.probabilities,
		needsClarification: noul(answers, "needs_clarification"),
	};
}

/** Picks a worker model; when Jev is unsure between its top two, the higher tier wins. */
export async function decideModel(
	config: JevConfig,
	pool: PoolEntry[],
	task: { task: string; acceptance: string; strategy: Strategy },
	signal?: AbortSignal,
	// Per pool key, how that model fared on past orchestrated tasks (priors.json).
	trackRecord?: Record<string, string>,
): Promise<ModelDecision> {
	const answers = await ask(
		config,
		{
			task: clip(task.task),
			acceptance: task.acceptance,
			team_strategy: task.strategy,
			...(trackRecord ? { model_track_record: trackRecord } : {}),
		},
		{
			model: {
				type: "choice",
				instructions: "Which coding model is the best fit for doing `task` until `acceptance` holds?",
				criteria: Object.fromEntries(pool.map((entry) => [entry.key, entry.use])),
			},
		},
		signal,
	);
	const answer = choice(answers, "model");
	if (answer.confidence >= config.modelConfidence) {
		return { key: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, escalated: false };
	}
	const tierOf = (key: string) => pool.find((entry) => entry.key === key)?.tier ?? 0;
	const [first, second] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
	const key = second && tierOf(second[0]) > tierOf(first[0]) ? second[0] : first[0];
	return { key, confidence: answer.confidence, probabilities: answer.probabilities, escalated: key !== answer.choice };
}

export interface PlacementMenu {
	modes: string[];
	nets: string[];
	sizes: string[];
	// Allowed catalog variables, each with what it is for.
	env: Record<string, string>;
}

// Each answer is undefined when Jev was not asked or was unsure; the caller's guardrails
// then keep the default.
export interface PlacementDecision {
	mode?: string;
	net?: string;
	size?: string;
	env: string[];
	confidence: { mode?: number; net: number; size: number };
}

const MODE_CRITERIA: Record<string, string> = {
	sandbox:
		"Its own disposable agentbox sandbox (a container with its own Nix store) cut from the leader's commit: for work that edits, builds, installs, or runs tests and is best kept off the host",
	shared: "The checkout of the upstream node it builds on (`workdir`), as is: when it must work directly on that node's changes",
	worktree:
		"A Git worktree on the host: for work that needs host-only resources (local services, hardware, the desktop, host credentials), or is too small to justify a sandbox",
};
const NET_CRITERIA: Record<string, string> = {
	none: "No network at all: pure code edits and offline tests",
	dev: "Package registries, GitHub, Nix caches, and model APIs: ordinary development with installs, builds, and dependency fetches",
	open: "Any public internet host: browsing or calling arbitrary external services",
};
const SIZE_CRITERIA: Record<string, string> = {
	small: "4 cores and 8 GB: edits, docs, light tests",
	medium: "8 cores and 16 GB: typical builds and test suites",
	large: "16 cores and 32 GB: heavy compiles, large Nix builds, big test matrices",
};

/** Proposes where a node runs and what its sandbox may reach, from the menu the caller allows. */
export async function decidePlacement(
	config: JevConfig,
	menu: PlacementMenu,
	node: { task: string; acceptance: string; kind: string },
	signal?: AbortSignal,
): Promise<PlacementDecision> {
	const pick = (options: string[], descriptions: Record<string, string>) =>
		Object.fromEntries(options.map((option) => [option, descriptions[option] ?? option]));
	const keys = Object.keys(menu.env);
	const questions: Record<string, Question> = {
		net: {
			type: "choice",
			instructions: "Which network access does the agent doing `task` need inside its sandbox?",
			criteria: pick(menu.nets, NET_CRITERIA),
		},
		size: {
			type: "choice",
			instructions: "How much CPU and memory does the agent doing `task` need for its builds and tests?",
			criteria: pick(menu.sizes, SIZE_CRITERIA),
		},
	};
	if (menu.modes.length > 1) {
		questions.placement = {
			type: "choice",
			instructions: "Where should the coding agent doing `task` work?",
			criteria: pick(menu.modes, MODE_CRITERIA),
		};
	}
	keys.forEach((key, index) => {
		questions[`env_${index}`] = {
			type: "noul",
			instructions: `Doing \`task\` needs the environment variable ${key} (${menu.env[key]}).`,
		};
	});
	const answers = await ask(config, { task: clip(node.task), acceptance: node.acceptance, node_kind: node.kind }, questions, signal);
	const sure = (id: string) => {
		const answer = choice(answers, id);
		return answer.confidence >= config.placementConfidence ? answer.choice : undefined;
	};
	return {
		mode: questions.placement ? sure("placement") : undefined,
		net: sure("net"),
		size: sure("size"),
		env: keys.filter((_, index) => noul(answers, `env_${index}`) >= config.envThreshold),
		confidence: {
			mode: questions.placement ? choice(answers, "placement").confidence : undefined,
			net: choice(answers, "net").confidence,
			size: choice(answers, "size").confidence,
		},
	};
}

/**
 * Judges a worker's turn one criterion at a time, so a single fuzzy clause cannot sink the
 * rest and retry feedback can name exactly what is missing. The report is weighed against
 * evidence the orchestrator gathered from the checkout and the worker's tool calls.
 */
export async function gateResult(
	config: JevConfig,
	task: { task: string; criteria: string[] },
	report: string,
	evidence: GateEvidence,
	signal?: AbortSignal,
): Promise<GateVerdict> {
	const criteria = task.criteria.slice(0, MAX_CRITERIA);
	const questions: Record<string, Question> = Object.fromEntries(
		criteria.map((criterion, index) => [
			`criterion_${index}`,
			{
				type: "noul",
				instructions: `This acceptance criterion for \`task\` holds: ${criterion}. \`evidence\` was collected independently of the worker: the files actually changed and the tool calls actually made. A claim in \`final_report\` about files or commands that \`evidence\` does not show (a file missing from changed_files, a command missing from tool_calls) does not count. Report style, summaries, and side notes do not count against it.`,
			} satisfies Question,
		]),
	);
	questions.blocked = {
		type: "noul",
		instructions: "`final_report` says the work could not be finished because a decision, information, or access is missing.",
	};
	questions.unrelated_changes = {
		type: "noul",
		instructions: "`evidence.changed_files` includes files that have nothing to do with `task`.",
	};
	const answers = await ask(config, { task: clip(task.task), evidence, final_report: clip(report) }, questions, signal);
	return {
		criteria: criteria.map((criterion, index) => ({ criterion, p: noul(answers, `criterion_${index}`) })),
		blocked: noul(answers, "blocked"),
		unrelatedChanges: noul(answers, "unrelated_changes"),
	};
}
