// Where members run. `sbx` packs members into clone-mode Docker Sandboxes (pods), each member
// in its own git worktree inside the pod's private clone and its own tmux session, because
// `sbx exec` cannot detach. `local` runs each member in its own worktree on the host, as a
// tab of the swarm's Herdr workspace.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Member, SwarmSpec } from "./protocol.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function run(
	command: string,
	args: string[],
	options: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.stdin.end(options.input ?? "");
	});
}

export async function must(command: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<string> {
	const result = await run(command, args, options);
	if (result.code !== 0) {
		throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
	}
	return result.stdout.trim();
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface LaunchSpec {
	member: Member;
	env: Record<string, string>;
	resume: boolean;
	// Files for the member's private agent directory (auth.json, settings.json); sbx only.
	agentFiles?: Record<string, string>;
}

export interface Backend {
	readonly kind: "sbx" | "local";
	podCapacity(): number;
	ensurePod(pod: string, boardPort: number): Promise<{ root: string }>;
	prepareWorktree(member: Member, root: string): Promise<string>;
	launch(spec: LaunchSpec): Promise<void>;
	writeAgentFiles(member: Member, files: Record<string, string>): Promise<void>;
	alive(member: Member): Promise<boolean>;
	stop(member: Member): Promise<void>;
	exec(member: Member, script: string, timeoutMs: number): Promise<RunResult>;
	attachCommand(member: Member): string[];
	collect(pods: string[]): Promise<void>;
	setBillingSecret(pod: string, provider: string, placeholder: string, value: string): Promise<void>;
	destroy(pods: string[]): Promise<void>;
	boardUrl(port: number): string;
	agentDir(member: Member): string;
}

const TMUX_SIZE = ["-x", "220", "-y", "60"];

function memberInvocation(member: Member, spec: LaunchSpec, omo: string, extraArgs: string[]): string {
	const env = Object.entries(spec.env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
	const args = [...extraArgs, "--model", `${member.model}:${member.thinking}`, ...(spec.resume ? ["--continue"] : [])];
	return `env ${env} ${omo} ${args.map(shellQuote).join(" ")}`;
}

type HerdrPane = { pane_id: string; tab_id: string };

// Members are tabs labeled with their name in one Herdr workspace per swarm, so they show up
// beside every other agent pane. Ids are looked up by label, which survives daemon restarts.
export class LocalBackend implements Backend {
	readonly kind = "local" as const;
	private readonly workspaceLabel: string;
	// attachCommand is synchronous, so it reads the tab ids launch and alive last saw.
	private readonly tabs = new Map<string, string>();

	constructor(
		private readonly spec: SwarmSpec,
		private readonly dir: string,
		private readonly herdr: string,
		private readonly omo: string,
	) {
		this.workspaceLabel = `swarm ${spec.id}`;
	}

	private async herdrResult<T>(args: string[]): Promise<T> {
		const out = await must(this.herdr, args).catch((error: Error) => {
			throw new Error(`${error.message}\nLocal swarm members run in Herdr; start Herdr first.`);
		});
		return (JSON.parse(out) as { result: T }).result;
	}

	private async workspace(): Promise<string | undefined> {
		const { workspaces } = await this.herdrResult<{ workspaces: { workspace_id: string; label: string }[] }>(["workspace", "list"]);
		return workspaces.find((workspace) => workspace.label === this.workspaceLabel)?.workspace_id;
	}

	private async memberPane(member: Member): Promise<HerdrPane | undefined> {
		const workspace = await this.workspace();
		const tabs = workspace
			? (await this.herdrResult<{ tabs: { tab_id: string; label: string }[] }>(["tab", "list", "--workspace", workspace])).tabs
			: [];
		const tab = tabs.find((candidate) => candidate.label === member.name)?.tab_id;
		if (!workspace || !tab) {
			this.tabs.delete(member.name);
			return undefined;
		}
		this.tabs.set(member.name, tab);
		const { panes } = await this.herdrResult<{ panes: HerdrPane[] }>(["pane", "list", "--workspace", workspace]);
		return panes.find((pane) => pane.tab_id === tab);
	}

	private async openTab(member: Member): Promise<HerdrPane> {
		const workspace = await this.workspace();
		if (workspace) {
			const created = await this.herdrResult<{ root_pane: HerdrPane }>([
				"tab", "create", "--workspace", workspace, "--cwd", member.worktree!, "--label", member.name, "--no-focus",
			]);
			return created.root_pane;
		}
		const created = await this.herdrResult<{ root_pane: HerdrPane }>([
			"workspace", "create", "--cwd", member.worktree!, "--label", this.workspaceLabel, "--no-focus",
		]);
		await must(this.herdr, ["tab", "rename", created.root_pane.tab_id, member.name]);
		return created.root_pane;
	}

	podCapacity(): number {
		return Number.POSITIVE_INFINITY;
	}

	async ensurePod(): Promise<{ root: string }> {
		return { root: this.spec.repo };
	}

	async prepareWorktree(member: Member, root: string): Promise<string> {
		const path = join(this.dir, "worktrees", member.name);
		const exists = await run("git", ["-C", path, "rev-parse", "--git-dir"]);
		if (exists.code === 0) return path;
		await mkdir(join(this.dir, "worktrees"), { recursive: true });
		await must("git", ["-C", root, "worktree", "add", "-B", member.branch, path, member.startRef ?? this.spec.base]);
		return path;
	}

	async launch(spec: LaunchSpec): Promise<void> {
		const { member } = spec;
		await this.stop(member);
		// The command carries the member's board token; typed into the pane it would land in the
		// shell's history, so the pane runs a private script instead. The shell outlives the
		// member, which keeps a failure readable in its tab.
		const script = join(this.dir, "launch", `${member.name}.sh`);
		await mkdir(dirname(script), { recursive: true, mode: 0o700 });
		await writeFile(script, `${memberInvocation(member, spec, this.omo, [])}\necho\necho "[swarm] member exited ($?)"\n`, { mode: 0o700 });
		const pane = await this.openTab(member);
		this.tabs.set(member.name, pane.tab_id);
		await must(this.herdr, ["pane", "run", pane.pane_id, `sh ${shellQuote(script)}`]);
	}

	async writeAgentFiles(): Promise<void> {}

	// Herdr errors propagate: only a missing tab or a pane back at its shell prompt is an exit.
	async alive(member: Member): Promise<boolean> {
		const pane = await this.memberPane(member);
		if (!pane) return false;
		const { process_info: info } = await this.herdrResult<{
			process_info: { foreground_process_group_id?: number; shell_pid?: number };
		}>(["pane", "process-info", "--pane", pane.pane_id]);
		return info.foreground_process_group_id !== undefined && info.foreground_process_group_id !== info.shell_pid;
	}

	async stop(member: Member): Promise<void> {
		const pane = await this.memberPane(member);
		if (pane) await must(this.herdr, ["tab", "close", pane.tab_id]);
		this.tabs.delete(member.name);
	}

	exec(member: Member, script: string, timeoutMs: number): Promise<RunResult> {
		return run("bash", ["-lc", script], { cwd: member.worktree, timeoutMs });
	}

	attachCommand(member: Member): string[] {
		const tab = this.tabs.get(member.name);
		return tab ? [this.herdr, "tab", "focus", tab] : [];
	}

	async collect(): Promise<void> {}

	async setBillingSecret(): Promise<void> {
		throw new Error("Billing fallback needs the sbx backend: local members already use the host's own logins.");
	}

	async destroy(): Promise<void> {
		const workspace = await this.workspace();
		if (workspace) await must(this.herdr, ["workspace", "close", workspace]);
		this.tabs.clear();
	}

	boardUrl(port: number): string {
		return `http://127.0.0.1:${port}`;
	}

	agentDir(): string {
		return process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
	}
}

const POD_HOME = "/home/agent";

export class SbxBackend implements Backend {
	readonly kind = "sbx" as const;

	constructor(
		private readonly spec: SwarmSpec,
		private readonly sbx: string,
		private readonly kitDir: string,
	) {}

	podCapacity(): number {
		return this.spec.podSize;
	}

	private exec_(pod: string, args: string[], options: { user?: string; workdir?: string; timeoutMs?: number } = {}) {
		const flags = [...(options.user ? ["-u", options.user] : []), ...(options.workdir ? ["-w", options.workdir] : [])];
		return run(this.sbx, ["exec", ...flags, pod, ...args], { timeoutMs: options.timeoutMs ?? 120_000 });
	}

	private async mustExec(pod: string, args: string[], options: { user?: string; workdir?: string } = {}): Promise<string> {
		const result = await this.exec_(pod, args, options);
		if (result.code !== 0) throw new Error(`sbx exec ${pod} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
		return result.stdout.trim();
	}

	async ensurePod(pod: string, boardPort: number): Promise<{ root: string }> {
		// The global policy is a one-time posture choice (allow-all, balanced, deny-all) for every
		// sandbox on the host, so the swarm names the fix instead of picking one.
		const policyHint = (error: Error): never => {
			if (!error.message.includes("global network policy has not been initialized")) throw error;
			throw new Error(
				"sbx's global network policy is not initialized. Run `sbx policy init balanced` once on the host (see SWARM.md), then restart the members with swarm_restart.",
			);
		};
		const listed = await run(this.sbx, ["ls", "--json"]);
		const exists = listed.code === 0 && listed.stdout.includes(`"${pod}"`);
		if (!exists) {
			await must(
				this.sbx,
				["run", "--detached", "--clone", "--name", pod, "--memory", this.spec.podMemory, "--skills", "off", this.kitDir, this.spec.repo],
				{ cwd: this.spec.repo, timeoutMs: 30 * 60_000 },
			).catch(policyHint);
		}
		// The proxy maps host.docker.internal to the host's localhost; only the board's port opens.
		await must(this.sbx, ["policy", "allow", "network", "--sandbox", pod, `localhost:${boardPort}`]).catch(policyHint);
		const root = await this.mustExec(pod, ["git", "rev-parse", "--show-toplevel"]);
		return { root };
	}

	async prepareWorktree(member: Member, root: string): Promise<string> {
		const path = `${POD_HOME}/swarm/${member.name}`;
		const start = member.startRef ?? this.spec.base;
		// Parents from earlier generations live on the host after collect; the host repo is
		// mounted read-only at /run/sandbox/source.
		const script = [
			"set -e",
			`cd ${shellQuote(root)}`,
			`git fetch -q /run/sandbox/source ${shellQuote(`+refs/heads/swarm/${this.spec.id}/*:refs/heads/swarm/${this.spec.id}/*`)} 2>/dev/null || true`,
			`if [ -d ${shellQuote(path)} ]; then exit 0; fi`,
			`mkdir -p ${POD_HOME}/swarm`,
			`git worktree add -B ${shellQuote(member.branch)} ${shellQuote(path)} ${shellQuote(start)}`,
		].join("\n");
		await this.mustExec(member.pod, ["bash", "-c", script]);
		return path;
	}

	agentDir(member: Member): string {
		return `${POD_HOME}/.swarm/agents/${member.name}`;
	}

	async writeAgentFiles(member: Member, files: Record<string, string>): Promise<void> {
		const dir = this.agentDir(member);
		await this.mustExec(member.pod, ["mkdir", "-p", dir]);
		const staging = await mkdtemp(join(tmpdir(), "swarm-agent-"));
		try {
			for (const [name, content] of Object.entries(files)) {
				const local = join(staging, name);
				await writeFile(local, content, { mode: 0o600 });
				await must(this.sbx, ["cp", local, `${member.pod}:${dir}/${name}`]);
			}
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
		await this.mustExec(member.pod, ["bash", "-c", `chown -R agent:agent ${shellQuote(dir)} && chmod 600 ${shellQuote(dir)}/*.json`], { user: "root" });
	}

	async launch(spec: LaunchSpec): Promise<void> {
		const { member } = spec;
		if (spec.agentFiles) await this.writeAgentFiles(member, spec.agentFiles);
		// Keep the tmux pane after an exit so the failure stays readable on attach.
		const invocation = memberInvocation(member, spec, "omo", ["--no-extensions", "-e", "/opt/swarm/swarm/extension/index.ts"]);
		const command = `${invocation}; echo; echo "[swarm] member exited ($?)"; sleep 86400`;
		await this.mustExec(member.pod, ["tmux", "new-session", "-d", "-s", member.name, ...TMUX_SIZE, "-c", member.worktree!, command]);
	}

	async alive(member: Member): Promise<boolean> {
		const pane = await this.exec_(member.pod, ["tmux", "list-panes", "-t", member.name, "-F", "#{pane_current_command}"], { timeoutMs: 30_000 });
		return pane.code === 0 && !pane.stdout.trim().split("\n").every((line) => line === "sleep");
	}

	async stop(member: Member): Promise<void> {
		await this.exec_(member.pod, ["tmux", "kill-session", "-t", member.name], { timeoutMs: 30_000 });
	}

	exec(member: Member, script: string, timeoutMs: number): Promise<RunResult> {
		return this.exec_(member.pod, ["bash", "-lc", script], { workdir: member.worktree, timeoutMs });
	}

	attachCommand(member: Member): string[] {
		return [this.sbx, "exec", "-it", member.pod, "tmux", "attach-session", "-t", member.name];
	}

	async collect(pods: string[]): Promise<void> {
		const refspec = `+refs/heads/swarm/${this.spec.id}/*:refs/heads/swarm/${this.spec.id}/*`;
		for (const pod of pods) await must("git", ["-C", this.spec.repo, "fetch", "-q", `sandbox-${pod}`, refspec]);
	}

	async setBillingSecret(pod: string, provider: string, placeholder: string, value: string): Promise<void> {
		const host = provider === "anthropic" ? "api.anthropic.com" : "api.openai.com";
		await must(this.sbx, ["secret", "set-custom", "--sandbox", pod, "--host", host, "--name", `swarm-${provider}-${pod}`, "--placeholder", placeholder, "--value", value]);
	}

	async destroy(pods: string[]): Promise<void> {
		if (pods.length) await run(this.sbx, ["rm", "--force", ...pods], { timeoutMs: 5 * 60_000 });
	}

	boardUrl(port: number): string {
		return `http://host.docker.internal:${port}`;
	}
}
