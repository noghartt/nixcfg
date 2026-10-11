// SSH transport for cloud mode: one multiplexed master connection per host,
// so each tool operation costs a round trip instead of a new handshake.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import type {
	BashOperations,
	EditOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";

export type Target = { dest: string; home: string; cwd: string };

export type RunResult = { code: number | null; stdout: Buffer; stderr: string };

const socketDir = posix.join(homedir(), ".ssh", "omo-cloud");

export const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Killing a multiplexed client leaves its remote process running, so
// anything that must stop when killed (agent bash, `!` commands) gets its own
// connection; short file operations share the master.
export function sshOptions(shared = true): string[] {
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	const connection = shared
		? ["-o", "ControlMaster=auto", "-o", `ControlPath=${socketDir}/%C`, "-o", "ControlPersist=600"]
		: ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
	return [
		"-o", "BatchMode=yes",
		...connection,
		"-o", "ServerAliveInterval=30",
		"-o", "LogLevel=ERROR",
	];
}

export const remoteShell = (cwd: string, command: string): string => `cd ${q(cwd)} && exec bash -c ${q(command)}`;

export function run(
	dest: string,
	command: string,
	options: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; onStdout?: (chunk: Buffer, kill: () => void) => void } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) return reject(new Error("Operation aborted"));
		const child = spawn("ssh", [...sshOptions(), "-T", "--", dest, command], {
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const kill = () => child.kill();
		child.stdout.on("data", (chunk: Buffer) => (options.onStdout ? options.onStdout(chunk, kill) : out.push(chunk)));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
		options.signal?.addEventListener("abort", kill, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			if (options.signal?.aborted) return reject(new Error("Operation aborted"));
			resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

export async function exec(dest: string, command: string, input?: string | Buffer): Promise<Buffer> {
	const result = await run(dest, command, { input });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `ssh ${dest}: exit ${result.code}`);
	return result.stdout;
}

/** Local home paths (including `~`, which the tools expand locally) map to the remote home. */
export function toRemote(target: Target, path: string): string {
	const local = homedir();
	if (path === local) return target.home;
	if (path.startsWith(`${local}/`)) return target.home + path.slice(local.length);
	return path;
}

const notFound = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

const IMAGE_MAGIC: Array<[string, (b: Buffer) => boolean]> = [
	["image/png", (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))],
	["image/jpeg", (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
	["image/gif", (b) => b.subarray(0, 3).toString("latin1") === "GIF"],
	["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
	["image/bmp", (b) => b.subarray(0, 2).toString("latin1") === "BM"],
];

export function readOps(target: Target): ReadOperations {
	return {
		readFile: (path) => exec(target.dest, `cat -- ${q(toRemote(target, path))}`),
		access: async (path) => {
			if ((await run(target.dest, `test -r ${q(toRemote(target, path))}`)).code !== 0) throw notFound(path);
		},
		// Only image-named files pay the extra round trip for their magic bytes.
		detectImageMimeType: async (path) => {
			if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) return null;
			const head = (await run(target.dest, `head -c 12 -- ${q(toRemote(target, path))}`)).stdout;
			return IMAGE_MAGIC.find(([, matches]) => matches(head))?.[0] ?? null;
		},
	};
}

export function writeOps(target: Target): WriteOperations {
	return {
		// Content travels on stdin, so size is not bounded by the command line.
		writeFile: async (path, content) => {
			await exec(target.dest, `cat > ${q(toRemote(target, path))}`, content);
		},
		mkdir: async (dir) => {
			await exec(target.dest, `mkdir -p -- ${q(toRemote(target, dir))}`);
		},
	};
}

export function editOps(target: Target): EditOperations {
	const read = readOps(target);
	return {
		readFile: read.readFile,
		access: async (path) => {
			const remote = q(toRemote(target, path));
			if ((await run(target.dest, `test -r ${remote} && test -w ${remote}`)).code !== 0) throw notFound(path);
		},
		writeFile: writeOps(target).writeFile,
	};
}

/** `!` commands typed by the user; the agent's bash goes through the PTY instead. */
export function userBashOps(target: Target): BashOperations {
	return {
		exec: (command, _cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const child = spawn("ssh", [...sshOptions(false), "-T", "--", target.dest, remoteShell(target.cwd, command)], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				const onAbort = () => child.kill();
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("error", reject);
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

/** The agent's bash: OmO's local PTY runs ssh, so background sessions, input, and kill keep working. */
export const ptyCommand = (target: Target, command: string): string =>
	["exec", "ssh", ...sshOptions(false), "-tt", "--", target.dest, remoteShell(target.cwd, command)].map(q).join(" ");
