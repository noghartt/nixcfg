import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export type RpcEvent = { type: string; [field: string]: unknown };

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

// Same resolution as worktree-agents: re-run the current harness (pi or omo)
// so workers inherit its auth, settings, and packaged extensions.
export function harnessInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	return /^(node|bun)(\.exe)?$/i.test(basename(process.execPath))
		? { command: "pi", args }
		: { command: process.execPath, args };
}

// OmO exports OMO_NATIVE to its process; Pi runs as a node or bun script.
export function harnessName(): "omo" | "pi" {
	return process.env.OMO_NATIVE || basename(process.execPath) === "omo" ? "omo" : "pi";
}

export class RpcChild {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(event: RpcEvent) => void>();
	private nextId = 0;
	private stdoutBuffer = "";
	private stderrTail = "";
	readonly exited: Promise<number>;

	constructor(args: string[], cwd: string, env: Record<string, string>) {
		const invocation = harnessInvocation(["--mode", "rpc", ...args]);
		this.child = spawn(invocation.command, invocation.args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Split on LF only: readline would also split on U+2028/U+2029 inside JSON strings.
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.stdoutBuffer += chunk.toString("utf8");
			let newline = this.stdoutBuffer.indexOf("\n");
			while (newline !== -1) {
				this.handleLine(this.stdoutBuffer.slice(0, newline).replace(/\r$/, ""));
				this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
				newline = this.stdoutBuffer.indexOf("\n");
			}
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8 * 1024);
		});
		this.exited = new Promise((resolve) => {
			this.child.on("error", (error) => {
				this.stderrTail += `\n${error.message}`;
				resolve(1);
			});
			this.child.on("close", (code) => resolve(code ?? 1));
		});
		void this.exited.then((code) => {
			for (const { reject } of this.pending.values()) reject(new Error(`worker exited (${code}): ${this.stderr()}`));
			this.pending.clear();
		});
	}

	private handleLine(line: string) {
		if (!line.trim()) return;
		let record: RpcEvent;
		try {
			record = JSON.parse(line) as RpcEvent;
		} catch {
			this.stderrTail += `\n[non-protocol stdout] ${line.slice(0, 200)}`;
			return;
		}
		if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
			const waiter = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			waiter.resolve(record as unknown as RpcResponse);
			return;
		}
		for (const listener of this.listeners) listener(record);
	}

	onEvent(listener: (event: RpcEvent) => void): void {
		this.listeners.add(listener);
	}

	async send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		const id = `orch-${++this.nextId}`;
		const response = await new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
		if (!response.success) throw new Error(`${response.command}: ${response.error ?? "failed"}`);
		return response.data as T;
	}

	write(record: Record<string, unknown>): void {
		if (this.child.exitCode === null) this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	stderr(): string {
		return this.stderrTail.trim();
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		const killer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
		await this.exited;
		clearTimeout(killer);
	}
}
