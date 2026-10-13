// Subagent support for cloud mode: how a session recognises that it is a task
// child, which agent type it runs, and the names of the sandbox and branch a
// write-capable child gets. Pure logic and one small file read, no pi imports,
// so it is unit-tested without the engine (child.test.ts).
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// agentbox sandbox names: a-z0-9-, at most 31 characters.
export const MAX_BOX = 31;

const clean = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Last six characters of a task id (`st_01a1325e`) or session id: unique enough per parent. */
export function shortId(id: string): string {
	return id.toLowerCase().replace(/^st_/, "").replace(/[^a-z0-9]/g, "").slice(-6) || "child";
}

/** `<parent-box>-<short>`; a long parent name is cut so the suffix always survives. */
export function childBoxName(parentBox: string, short: string): string {
	const room = MAX_BOX - short.length - 1;
	const parent = clean(parentBox).slice(0, room).replace(/-+$/g, "");
	return parent ? `${parent}-${short}` : short;
}

/** The branch a child works on. The full parent name stays in it for traceability. */
export const childBranch = (parentBox: string, short: string): string => `task/${parentBox}/${short}`;

/** Where `agentbox collect NAME --into PARENT` leaves a child's branch in the parent's clone. */
export const collectedRef = (childBox: string, branch: string): string => `sandbox/${childBox}/${branch}`;

// Agent types that only look: they keep sharing the parent's sandbox. The first
// four are OmO's own restricted types (their tool list has no write or edit and
// bash is swapped for a gh/curl reader); the reviewers write a report at most.
const READ_ONLY_AGENTS = /^(explore|librarian|oracle|metis|momus|plan-consultant|plan-reviewer|omo-native-(code|gate)-reviewer)$/;
const WRITE_TOOLS = ["write", "edit", "apply_patch", "bash", "powershell"];

export type AgentShape = { agentType?: string; category?: string; toolAllow?: string[]; toolDeny?: string[] };

/** True when the agent cannot change files: a known research type, or tool lists that exclude every writer. */
export function isReadOnly({ agentType, toolAllow, toolDeny }: AgentShape): boolean {
	if (agentType && READ_ONLY_AGENTS.test(agentType)) return true;
	if (!toolAllow && !toolDeny) return false;
	const reaches = (tool: string) => (!toolAllow || toolAllow.some((p) => p === "*" || p === tool)) && !toolDeny?.includes(tool);
	return !WRITE_TOOLS.some(reaches);
}

/** What a parent tells a child it spawns. `share` means: keep using `box`. */
export type ParentInfo = { spec: string; box: string; env: string[]; net?: string; size?: string; share: boolean };

const MARKER = /<!--cloud-mode:([A-Za-z0-9+/=]+)-->/;

export const encodeMarker = (info: ParentInfo): string => `<!--cloud-mode:${Buffer.from(JSON.stringify(info)).toString("base64")}-->`;

export function parseMarker(text: string): ParentInfo | undefined {
	const raw = MARKER.exec(text)?.[1];
	if (!raw) return undefined;
	try {
		const info = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Partial<ParentInfo>;
		if (typeof info.spec !== "string" || typeof info.box !== "string" || !Array.isArray(info.env)) return undefined;
		return { spec: info.spec, box: info.box, env: info.env.filter((v) => typeof v === "string"), net: info.net, size: info.size, share: info.share === true };
	} catch {
		return undefined;
	}
}

/** Appends the marker to a task prompt, replacing an older one (a re-sent prompt). */
export const withMarker = (prompt: string, info: ParentInfo): string => `${prompt.replace(/\s*<!--cloud-mode:[A-Za-z0-9+/=]+-->/g, "")}\n\n${encodeMarker(info)}`;

const OPTION = /^[a-z][a-z0-9-]*$/;

/** `--net`/`--size` values go onto a command line: profile and class names only. */
export function checkOption(name: string, value: string | undefined): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (!OPTION.test(value)) throw new Error(`--${name} takes a name like dev or medium, not "${value}".`);
	return value;
}

/** Pulls `--name=value` or `--name value` out of command words. */
export function takeOption(words: string[], name: string): { value?: string; rest: string[] } {
	const rest: string[] = [];
	let value: string | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === `--${name}`) value = words[++i] ?? "";
		else if (word.startsWith(`--${name}=`)) value = word.slice(name.length + 3);
		else rest.push(word);
	}
	return { value, rest };
}

/** `agentbox ensure NAME --seed PATH [--from BOX] [--net PROFILE] [--size CLASS]` (contract C1). */
export function ensureArgs(box: string, seed: string, options: { from?: string; net?: string; size?: string }): string[] {
	return ["ensure", box, "--seed", seed, ...(options.from ? ["--from", options.from] : []), ...(options.net ? ["--net", options.net] : []), ...(options.size ? ["--size", options.size] : [])];
}

export type ChildIdentity = { role: string; taskId?: string; stateDir?: string };

const ROLES = ["child", "dag_child", "member"];

/**
 * OmO marks a task child two ways (omo.js, `mC`/`gC`): a `sessionContext` on the
 * extension context with `role`, `task_id`, `state_dir` (sessions hosted by the
 * shared task daemon), or `OMO_SENPI_TASK_RPC_CHILD=1` in the environment of a
 * spawned child process, whose session dir name carries the task id.
 */
export function childIdentity(ctx: unknown, env: NodeJS.ProcessEnv = process.env): ChildIdentity | undefined {
	const sc = (ctx as { sessionContext?: Record<string, unknown> } | undefined)?.sessionContext;
	const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	const role = str(sc?.role);
	if (role) return { role: ROLES.includes(role) ? role : "child", taskId: str(sc?.task_id), stateDir: str(sc?.state_dir) };
	if (env.OMO_SENPI_TASK_RPC_CHILD !== "1") return undefined;
	return { role: "child", taskId: /st_[0-9a-f]{8}/.exec(env.SENPI_CODING_AGENT_SESSION_DIR ?? "")?.[0] };
}

/** The task record holds `agent_type`, `category`, `tool_allow`, `tool_deny` (omo-task.js); absent until readable. */
export function readTaskRecord(identity: ChildIdentity): AgentShape | undefined {
	if (!identity.taskId) return undefined;
	const dirs = new Set<string>();
	if (identity.stateDir) {
		dirs.add(identity.stateDir);
		if (basename(dirname(identity.stateDir)) === "children") dirs.add(dirname(dirname(identity.stateDir)));
	}
	for (const dir of dirs) {
		try {
			const record = JSON.parse(readFileSync(join(dir, "tasks", `${identity.taskId}.json`), "utf8")) as Record<string, unknown>;
			const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
			return {
				agentType: typeof record.agent_type === "string" ? record.agent_type : undefined,
				category: typeof record.category === "string" ? record.category : undefined,
				toolAllow: list(record.tool_allow),
				toolDeny: list(record.tool_deny),
			};
		} catch {
			// Not at this location, or not written yet.
		}
	}
	return undefined;
}
