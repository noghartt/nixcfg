import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseFrontmatter } from "#pi/index.js";
import { resolveCliModel } from "#pi/core/model-resolver.js";
import type { ModelRuntime } from "#pi/core/model-runtime.js";
import type { PiResources } from "./resources.ts";
import { type Isolation, isIsolation, parseIsolation } from "./sandbox.ts";

/**
 * A specialized subagent: a model, the tools it is offered, how it is isolated, and instructions. Defined in markdown
 * files with YAML frontmatter, like Claude Code agents:
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for bugs and risky changes
 *   model: anthropic/claude-sonnet-5-5   # provider/model or a model ID; ":high" sets thinking
 *   thinking: high
 *   tools: read, bash                    # coding tools it is offered; default all
 *   isolation: worktree                  # its own git worktree and branch; default none
 *                                        # sandbox[:kind]: its own sbx sandbox VM; keepSandbox: true keeps it
 *   maxTurns: 40
 *   ---
 *   You review changes. ...
 *
 * `runner: antigravity` runs the task on the Antigravity CLI (`agy`) instead of a Pi conversation: `model` is then an
 * agy model ID (default gemini-4-neon-high), `tools`, `thinking` and `maxTurns` do not apply, and `allowWrites: true`
 * lets it change files (and run any command), only ever inside its own worktree.
 */
export interface AgentProfile {
	readonly name: string;
	readonly description: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	/** Tool names offered to the model; undefined offers every tool the parent has. */
	readonly tools?: readonly string[];
	readonly isolation: Isolation;
	/** Sandbox isolation: keep the sandbox after its work is pulled back. */
	readonly keepSandbox?: boolean;
	readonly maxTurns?: number;
	/** Where the task runs: a Pi conversation, or an `agy` run. */
	readonly runner: "pi" | "antigravity";
	/** Antigravity only: agy may write files; needs `isolation: worktree`. */
	readonly allowWrites?: boolean;
	readonly instructions: string;
	/** The file it came from, or "built-in". */
	readonly source: string;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const BUILT_IN: readonly AgentProfile[] = [
	{
		name: "general",
		description: "A copy of the main agent: same model and tools, works in the same directory",
		isolation: "none",
		runner: "pi",
		instructions: "",
		source: "built-in",
	},
	{
		name: "explore",
		description: "Read-only research: finds files, reads code, answers questions; never edits",
		tools: ["read", "bash"],
		isolation: "none",
		runner: "pi",
		instructions:
			"You research and report; you never change files. Use bash only for read-only commands (rg, fd, ls, git log, " +
			"git show, cat). Answer with the facts found, the paths and line numbers that show them, and what stays unknown.",
		source: "built-in",
	},
	{
		name: "reviewer",
		description: "Reviews code or a diff for bugs, risky changes and missed cases; never edits",
		tools: ["read", "bash"],
		isolation: "none",
		runner: "pi",
		instructions:
			"You review; you never change files. Look for bugs, regressions, missed edge cases, and changes that do not do " +
			"what they claim. Rank findings by severity, cite paths and lines, and say what you checked and found fine.",
		source: "built-in",
	},
	{
		name: "worker",
		description: "Implements a change in its own git worktree and branch, so parallel workers never collide",
		isolation: "worktree",
		runner: "pi",
		instructions:
			"You implement the task completely, run the relevant checks, and commit your work on your branch with a clear " +
			"message before you answer. Answer with what changed, what you verified, and anything left open.",
		source: "built-in",
	},
];

function list(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const items = Array.isArray(value) ? value.map(String) : String(value).split(",");
	const names = items.map((item) => item.trim()).filter(Boolean);
	return names.length > 0 ? names : undefined;
}

function parseProfile(path: string): AgentProfile | string {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(readFileSync(path, "utf-8"));
	} catch (error) {
		return `${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
	const meta = parsed.frontmatter;
	const name = String(meta.name ?? basename(path, ".md")).trim();
	if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) return `${path}: invalid name "${name}"`;
	const thinking = meta.thinking === undefined ? undefined : String(meta.thinking);
	if (thinking !== undefined && !THINKING.has(thinking)) return `${path}: unknown thinking level "${thinking}"`;
	const isolation = String(meta.isolation ?? "none");
	if (!isIsolation(isolation)) return `${path}: isolation must be worktree, none, sandbox or sandbox:<kind>`;
	const keepSandbox =
		meta.keepSandbox === undefined ? undefined : meta.keepSandbox === true || meta.keepSandbox === "true";
	const maxTurns = meta.maxTurns === undefined ? undefined : Number(meta.maxTurns);
	if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns >= 1)) {
		return `${path}: maxTurns must be a positive integer`;
	}
	const runner = String(meta.runner ?? "pi");
	if (runner !== "pi" && runner !== "antigravity") return `${path}: runner must be pi or antigravity`;
	// agy runs on this machine; it has no way into a sandbox.
	if (runner === "antigravity" && parseIsolation(isolation).mode === "sandbox") {
		return `${path}: runner antigravity cannot use sandbox isolation`;
	}
	const allowWrites = meta.allowWrites === undefined ? undefined : meta.allowWrites === true || meta.allowWrites === "true";
	if (allowWrites === true && (runner !== "antigravity" || isolation !== "worktree")) {
		return `${path}: allowWrites needs runner antigravity and isolation worktree`;
	}
	const tools = list(meta.tools);
	return {
		name,
		description: String(meta.description ?? "").trim(),
		...(meta.model === undefined ? {} : { model: String(meta.model).trim() }),
		...(thinking === undefined ? {} : { thinking: thinking as ModelThinkingLevel }),
		...(tools === undefined ? {} : { tools }),
		isolation,
		...(keepSandbox === undefined ? {} : { keepSandbox }),
		...(maxTurns === undefined ? {} : { maxTurns }),
		runner,
		...(allowWrites === undefined ? {} : { allowWrites }),
		instructions: parsed.body.trim(),
		source: path,
	};
}

/** Profile directories, lowest precedence first: a later file with the same name replaces an earlier profile. */
function profileDirs(resources: PiResources): string[] {
	const dirs = [join(resources.agentDir, "agents"), join(homedir(), ".agents", "agents")];
	// Project profiles follow pi's project trust, like project skills.
	if (resources.trusted) {
		const ancestors: string[] = [];
		for (let dir = resources.cwd; ; dir = dirname(dir)) {
			ancestors.unshift(dir);
			if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
		}
		for (const dir of ancestors) dirs.push(join(dir, ".agents", "agents"), join(dir, ".pi", "agents"));
	}
	return dirs;
}

/** Built-in profiles, then the user's, then the project's; re-read by `/reload`. */
export class AgentProfiles {
	readonly #resources: PiResources;
	readonly #models: ModelRuntime;
	#profiles = new Map<string, AgentProfile>();
	#diagnostics: string[] = [];

	constructor(resources: PiResources, models: ModelRuntime) {
		this.#resources = resources;
		this.#models = models;
		this.reload();
	}

	reload(): void {
		const profiles = new Map(BUILT_IN.map((profile) => [profile.name, profile]));
		const diagnostics: string[] = [];
		for (const dir of profileDirs(this.#resources)) {
			let files: string[];
			try {
				files = readdirSync(dir).filter((file) => file.endsWith(".md"));
			} catch {
				continue;
			}
			for (const file of files.sort()) {
				const profile = parseProfile(join(dir, file));
				if (typeof profile === "string") diagnostics.push(profile);
				else profiles.set(profile.name, profile);
			}
		}
		this.#profiles = profiles;
		this.#diagnostics = diagnostics;
	}

	get all(): AgentProfile[] {
		return [...this.#profiles.values()];
	}

	get diagnostics(): readonly string[] {
		return this.#diagnostics;
	}

	get(name: string | undefined): AgentProfile {
		const profile = this.#profiles.get(name ?? "general");
		if (profile === undefined) {
			throw new Error(`Unknown agent profile "${name}". Available: ${[...this.#profiles.keys()].join(", ")}`);
		}
		return profile;
	}

	/** The model a profile asks for, resolved like `pi --model`; undefined keeps the parent's. */
	resolveModel(profile: AgentProfile): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
		if (profile.runner === "antigravity") return {};
		const thinking = profile.thinking === undefined ? {} : { thinkingLevel: profile.thinking };
		if (profile.model === undefined) return thinking;
		const resolved = resolveCliModel({ cliModel: profile.model, modelRuntime: this.#models });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Agent profile ${profile.name}: cannot resolve model ${profile.model}: ${resolved.error ?? ""}`);
		}
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
			...thinking,
		};
	}

	/** The profile list the main agent sees in its system prompt. */
	describe(): string {
		return this.all
			.map((profile) => {
				const agy = profile.runner === "antigravity";
				const traits = [
					agy ? `Antigravity agy, model ${profile.model ?? "default"}` : undefined,
					!agy && profile.model !== undefined ? `model ${profile.model}` : undefined,
					!agy && profile.tools !== undefined ? `tools ${profile.tools.join(", ")}` : undefined,
					agy ? (profile.allowWrites === true ? "may write files" : "read-only") : undefined,
					agy ? "no background subagent; joins swarms" : undefined,
					profile.isolation === "worktree" ? "own git worktree" : undefined,
					profile.isolation.startsWith("sandbox")
						? `own sandbox VM${profile.isolation.includes(":") ? ` (kind ${profile.isolation.slice(8)})` : ""}`
						: undefined,
				].filter(Boolean);
				return `- ${profile.name}: ${profile.description}${traits.length > 0 ? ` (${traits.join("; ")})` : ""}`;
			})
			.join("\n");
	}
}
