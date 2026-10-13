// Workers in agentbox sandboxes, on the leader's cloud host when it runs in OmO cloud mode
// (OMO_CLOUD, set by cloud-mode), or on this machine (`local`) for a host-side leader. An
// isolated node gets its own sandbox: seeded from the leader's checkout (the host directory,
// or the leader's own sandbox), branched from the leader's commit, and driven by a local
// worker process whose cloud-mode points every tool into it. Only committed history crosses,
// as git bundles, through `agentbox`.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Cloud = { dest: string; hostDir: string; box?: string };
// No `box`: the host directory itself.
export type Place = { cwd: string; box?: string };

export function leaderCloud(): Cloud | undefined {
	const spec = process.env.OMO_CLOUD;
	const colon = spec?.indexOf(":") ?? -1;
	if (!spec || colon < 1) return undefined;
	return { dest: spec.slice(0, colon), hostDir: spec.slice(colon + 1), box: process.env.OMO_CLOUD_SANDBOX || undefined };
}

// A host-side leader running in a sandbox-capable placement: its workers' sandboxes live on
// this machine and are seeded from (and collected into) the repository itself.
export const localCloud = (repoRoot: string): Cloud => ({ dest: "local", hostDir: repoRoot });

export function workerEnv(cloud: Cloud, box: string | undefined, env?: string[]): Record<string, string> {
	// OMO_CLOUD_ENV makes the worker's cloud-mode opt its sandbox into those catalog variables.
	// Without an explicit list it passes the leader's own opt-ins on. An empty value still has to
	// be set: the worker inherits the leader's environment, and an empty one keeps the opt-ins
	// provision() gave the sandbox.
	const vars = env ? env.join(",") : process.env.OMO_CLOUD_ENV;
	return {
		OMO_CLOUD: `${cloud.dest}:${cloud.hostDir}`,
		...(box ? { OMO_CLOUD_SANDBOX: box } : {}),
		OMO_CLOUD_ENV: vars ?? "",
	};
}

// agentbox-root accepts a-z, 0-9 and dashes, at most 31 characters.
export const boxName = (runId: string, node: string): string => `o${runId}-${node}`.slice(0, 31).replace(/-+$/, "");

const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const inBox = (box: string | undefined, command: string): string =>
	box ? `agentbox exec ${q(box)} -- bash -c ${q(command)}` : command;

type Result = { code: number | null; stdout: string; stderr: string };

// Shares cloud-mode's multiplexed master connection to the host; cloud-mode's
// `local` target (OmO on the sandbox host itself) runs the command in a local
// bash instead. Seeding clones a whole repo, so only git queries get a short
// timeout.
function invocation(dest: string, command: string): [string, string[]] {
	if (dest === "local") return ["bash", ["-c", command]];
	const sockets = join(homedir(), ".ssh", "omo-cloud");
	mkdirSync(sockets, { recursive: true, mode: 0o700 });
	return [
		"ssh",
		[
			"-o", "BatchMode=yes",
			"-o", "ControlMaster=auto",
			"-o", `ControlPath=${sockets}/%C`,
			"-o", "ControlPersist=600",
			"-o", "LogLevel=ERROR",
			"-T", "--", dest, command,
		],
	];
}

function runRaw(dest: string, command: string, signal?: AbortSignal, timeout?: number): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
	const [program, args] = invocation(dest, command);
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout });
		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
	});
}

async function ssh(dest: string, command: string, signal?: AbortSignal, timeout?: number): Promise<Result> {
	const result = await runRaw(dest, command, signal, timeout);
	return { ...result, stdout: result.stdout.toString("utf8") };
}

async function must(dest: string, command: string, what: string, signal?: AbortSignal): Promise<string> {
	const result = await ssh(dest, command, signal);
	if (result.code !== 0) throw new Error(`${what} on ${dest}: ${result.stderr.trim() || `exit ${result.code}`}`);
	return result.stdout;
}

export async function git(cloud: Cloud, place: Place, args: string[]): Promise<string | undefined> {
	const result = await ssh(cloud.dest, inBox(place.box, `git -C ${q(place.cwd)} ${args.map(q).join(" ")}`), undefined, 60_000);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function fingerprints(cloud: Cloud, place: Place, root: string, paths: string[]): Promise<string[]> {
	if (!paths.length) return [];
	const script = `cd ${q(root)} && for p in ${paths.map(q).join(" ")}; do stat -c '%s:%Y' -- "$p" 2>/dev/null || echo missing; done`;
	const result = await ssh(cloud.dest, inBox(place.box, script), undefined, 60_000);
	const lines = result.stdout.split("\n");
	return paths.map((_, index) => lines[index] || "missing");
}

export async function leaderPlace(cloud: Cloud, signal?: AbortSignal): Promise<Place> {
	if (!cloud.box) return { cwd: cloud.hostDir };
	const out = await must(cloud.dest, `agentbox ensure ${q(cloud.box)} --seed ${q(cloud.hostDir)}`, `sandbox ${cloud.box}`, signal);
	return { cwd: out.trim().split("\n").pop() ?? "", box: cloud.box };
}

export interface Limits {
	net?: string;
	size?: string;
	// Replaces the sandbox's catalog opt-ins; an empty list clears them.
	env?: string[];
}

// `from` seeds from an upstream node's sandbox and starts at its HEAD instead of the leader's.
export async function provision(
	cloud: Cloud,
	box: string,
	branch: string,
	limits: Limits = {},
	signal?: AbortSignal,
	from?: Place & { box: string },
): Promise<Place> {
	const source = from ?? (await leaderPlace(cloud, signal));
	const head = await git(cloud, source, ["rev-parse", "HEAD"]);
	if (!head) throw new Error(`cannot read HEAD in ${source.box ? `sandbox ${source.box}` : cloud.hostDir}`);
	const seedBox = from?.box ?? cloud.box;
	const flags = [
		...(seedBox ? ["--from", seedBox] : []),
		...(limits.net ? ["--net", limits.net] : []),
		...(limits.size ? ["--size", limits.size] : []),
	];
	const out = await must(
		cloud.dest,
		`agentbox ensure ${q(box)} --seed ${q(cloud.hostDir)}${flags.map((flag) => ` ${q(flag)}`).join("")}`,
		`sandbox ${box}`,
		signal,
	);
	const place = { cwd: out.trim().split("\n").pop() ?? "", box };
	if (limits.env) {
		const keys = limits.env.length ? limits.env.map(q).join(" ") : "--none";
		await must(cloud.dest, `agentbox env ${q(box)} ${keys}`, `env of sandbox ${box}`, signal);
	}
	await must(cloud.dest, inBox(box, `git -C ${q(place.cwd)} switch -q -c ${q(branch)} ${q(head)}`), `branch ${branch} in ${box}`, signal);
	return place;
}

// The branch as a git bundle, read straight out of the checkout (inside its sandbox, if any).
export async function bundle(cloud: Cloud, place: Place, branch: string, signal?: AbortSignal): Promise<Buffer> {
	const result = await runRaw(cloud.dest, inBox(place.box, `git -C ${q(place.cwd)} bundle create - ${q(`refs/heads/${branch}`)}`), signal);
	if (result.code !== 0) throw new Error(`bundling ${branch} on ${cloud.dest}: ${result.stderr.trim() || `exit ${result.code}`}`);
	return result.stdout;
}

// Only commits leave a sandbox, so leftovers are committed before the branches are fetched
// into the leader's repo as `sandbox/<box>/*`.
export async function collect(cloud: Cloud, place: Place, worker: string): Promise<string> {
	const message = `orch: uncommitted work of ${worker}`;
	await must(
		cloud.dest,
		inBox(place.box, `cd ${q(place.cwd)} && if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -qm ${q(message)}; fi`),
		`committing leftovers in ${place.box}`,
	);
	const into = cloud.box ? ` --into ${q(cloud.box)}` : "";
	return (await must(cloud.dest, `agentbox collect ${q(place.box ?? "")} ${q(cloud.hostDir)}${into}`, `collecting ${place.box}`)).trim();
}
