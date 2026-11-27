// Workers of a leader running in OmO cloud mode (OMO_CLOUD, set by cloud-mode): they share the
// leader's checkout on the cloud host, and their own cloud-mode points every tool there. The
// orchestrator reads that checkout's git state over cloud-mode's multiplexed SSH connection.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Cloud = { dest: string; hostDir: string };

export function leaderCloud(): Cloud | undefined {
	const spec = process.env.OMO_CLOUD;
	const colon = spec?.indexOf(":") ?? -1;
	if (!spec || colon < 1) return undefined;
	return { dest: spec.slice(0, colon), hostDir: spec.slice(colon + 1) };
}

export const workerEnv = (cloud: Cloud): Record<string, string> => ({ OMO_CLOUD: `${cloud.dest}:${cloud.hostDir}` });

const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

type Result = { code: number | null; stdout: string; stderr: string };

function ssh(dest: string, command: string, timeout: number): Promise<Result> {
	const sockets = join(homedir(), ".ssh", "omo-cloud");
	mkdirSync(sockets, { recursive: true, mode: 0o700 });
	const args = [
		"-o", "BatchMode=yes",
		"-o", "ControlMaster=auto",
		"-o", `ControlPath=${sockets}/%C`,
		"-o", "ControlPersist=600",
		"-o", "LogLevel=ERROR",
		"-T", "--", dest, command,
	];
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], timeout });
		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr }));
	});
}

export async function git(cloud: Cloud, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await ssh(cloud.dest, `git -C ${q(cwd)} ${args.map(q).join(" ")}`, 60_000);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function fingerprints(cloud: Cloud, root: string, paths: string[]): Promise<string[]> {
	if (!paths.length) return [];
	const script = `cd ${q(root)} && for p in ${paths.map(q).join(" ")}; do stat -c '%s:%Y' -- "$p" 2>/dev/null || echo missing; done`;
	const result = await ssh(cloud.dest, script, 60_000);
	const lines = result.stdout.split("\n");
	return paths.map((_, index) => lines[index] || "missing");
}
