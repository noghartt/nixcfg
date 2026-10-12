// Workers in agentbox sandboxes. When the leader runs in OmO cloud mode (OMO_CLOUD, set by
// cloud-mode), an isolated node gets its own sandbox on the leader's host instead of a local
// worktree: seeded from the leader's checkout (the host directory, or the leader's own sandbox),
// branched from the leader's commit, and driven by a local worker process whose cloud-mode
// points every tool into it. Only committed history crosses, as git bundles, through `agentbox`.
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

export function workerEnv(cloud: Cloud, box: string | undefined): Record<string, string> {
	// OMO_CLOUD_ENV (the leader's opted-in catalog variables) makes the worker's cloud-mode opt
	// its own sandbox into the same ones.
	const vars = process.env.OMO_CLOUD_ENV;
	return {
		OMO_CLOUD: `${cloud.dest}:${cloud.hostDir}`,
		...(box ? { OMO_CLOUD_SANDBOX: box } : {}),
		...(vars ? { OMO_CLOUD_ENV: vars } : {}),
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
function ssh(dest: string, command: string, signal?: AbortSignal, timeout?: number): Promise<Result> {
	let program = "bash";
	let args = ["-c", command];
	if (dest !== "local") {
		const sockets = join(homedir(), ".ssh", "omo-cloud");
		mkdirSync(sockets, { recursive: true, mode: 0o700 });
		program = "ssh";
		args = [
			"-o", "BatchMode=yes",
			"-o", "ControlMaster=auto",
			"-o", `ControlPath=${sockets}/%C`,
			"-o", "ControlPersist=600",
			"-o", "LogLevel=ERROR",
			"-T", "--", dest, command,
		];
	}
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
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

export async function provision(cloud: Cloud, box: string, branch: string, signal?: AbortSignal): Promise<Place> {
	const leader = await leaderPlace(cloud, signal);
	const head = await git(cloud, leader, ["rev-parse", "HEAD"]);
	if (!head) throw new Error(`cannot read the leader's HEAD in ${leader.box ? `sandbox ${leader.box}` : cloud.hostDir}`);
	const from = cloud.box ? ` --from ${q(cloud.box)}` : "";
	const out = await must(cloud.dest, `agentbox ensure ${q(box)} --seed ${q(cloud.hostDir)}${from}`, `sandbox ${box}`, signal);
	const place = { cwd: out.trim().split("\n").pop() ?? "", box };
	await must(cloud.dest, inBox(box, `git -C ${q(place.cwd)} switch -q -c ${q(branch)} ${q(head)}`), `branch ${branch} in ${box}`, signal);
	return place;
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
