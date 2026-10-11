#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { must, run } from "./backends.ts";
import { loadConfig, SwarmDaemon } from "./daemon.ts";
import {
	type BackendKind,
	type DaemonInfo,
	formatPost,
	memberLine,
	nowIso,
	type Pattern,
	type Permission,
	type Post,
	runDir,
	SwarmClient,
	type SwarmSpec,
	type SwarmState,
	swarmsRoot,
} from "./protocol.ts";

const USAGE = `swarm - agent swarms with a shared board (see SWARM.md)

  swarm start --goal TEXT [--repo DIR] [--backend sbx|local] [--pattern parallel|evolve]
              [--criteria TEXT]... [--fitness CMD] [--pod-size N] [--pod-memory 3g]
              [--max-members N] [--max-generations N] [--json]
  swarm ls [--json]                      swarms and their state
  swarm status ID [--json]               members, pods, pending permissions
  swarm board ID [--follow] [--kinds a,b]
  swarm send ID TO TEXT                  TO is a member, "leader", or "*"
  swarm attach ID MEMBER                 open the member's live session
  swarm approve|deny ID PERMISSION [NOTE]
  swarm stop ID [MEMBER...]              stop members (all when none named)
  swarm resume ID                        restart the daemon after a reboot or crash
  swarm rm ID [--yes]                    collect branches, then remove pods and worktrees
  swarm kit                              print the sandbox kit directory
  swarm serve ID                         run the daemon in the foreground (internal)`;

function fail(message: string): never {
	console.error(`swarm: ${message}`);
	process.exit(1);
}

function parse(argv: string[]): { positional: string[]; flags: Record<string, string[]> } {
	const positional: string[] = [];
	const flags: Record<string, string[]> = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg.startsWith("--")) {
			const [key, inline] = arg.slice(2).split(/=(.*)/s);
			const boolean = ["json", "follow", "yes"].includes(key);
			const value = inline ?? (boolean ? "true" : argv[++index]);
			if (value === undefined) fail(`--${key} needs a value`);
			(flags[key] ??= []).push(value);
		} else positional.push(arg);
	}
	return { positional, flags };
}

async function readInfo(id: string): Promise<DaemonInfo | undefined> {
	const info = JSON.parse(await readFile(join(runDir(id), "daemon.json"), "utf8").catch(() => "{}")) as Partial<DaemonInfo>;
	if (!info.pid || !info.port || !info.token) return undefined;
	try {
		process.kill(info.pid, 0);
	} catch {
		return undefined;
	}
	return info as DaemonInfo;
}

async function startDaemon(id: string): Promise<DaemonInfo> {
	const dir = runDir(id);
	// Dropping the pid makes readInfo wait for the new daemon; the port and token stay so
	// it can reclaim them for members launched by the previous one.
	const previous = JSON.parse(await readFile(join(dir, "daemon.json"), "utf8").catch(() => "{}")) as Partial<DaemonInfo>;
	await writeFile(join(dir, "daemon.json"), `${JSON.stringify({ port: previous.port, token: previous.token })}\n`, { mode: 0o600 });
	const log = openSync(join(dir, "daemon.log"), "a");
	const child = spawn(process.execPath, [process.argv[1], "serve", id], { detached: true, stdio: ["ignore", log, log], env: process.env });
	child.unref();
	for (let attempt = 0; attempt < 100; attempt++) {
		const info = await readInfo(id);
		if (info) return info;
		await Bun.sleep(100);
	}
	fail(`daemon did not start; see ${join(dir, "daemon.log")}`);
}

async function connect(id: string): Promise<SwarmClient> {
	if (!existsSync(join(runDir(id), "state.json"))) fail(`no swarm "${id}" under ${swarmsRoot()}`);
	return SwarmClient.fromInfo((await readInfo(id)) ?? (await startDaemon(id)));
}

async function gitMainCheckout(cwd: string): Promise<string> {
	const common = await must("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return common.endsWith("/.git") ? dirname(common) : must("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
}

async function start(flags: Record<string, string[]>, positional: string[]): Promise<void> {
	const config = loadConfig();
	const goal = (flags.goal?.join("\n") ?? positional.join(" ")).trim();
	if (!goal) fail("--goal is required");
	const cwd = resolve(flags.repo?.[0] ?? process.cwd());
	const backend = (flags.backend?.[0] ?? config.backend) as BackendKind;
	if (backend !== "sbx" && backend !== "local") fail(`unknown backend ${backend}`);
	const pattern = (flags.pattern?.[0] ?? "parallel") as Pattern;
	if (pattern !== "parallel" && pattern !== "evolve") fail(`unknown pattern ${pattern}`);
	// sbx clone mode only accepts the main checkout; members still start from this checkout's HEAD.
	const repo = await gitMainCheckout(cwd);
	const head = await must("git", ["-C", cwd, "rev-parse", "HEAD"]);
	const id = `${randomBytes(5).toString("hex").slice(0, 8)}`;
	const base = `swarm/${id}/base`;
	await must("git", ["-C", repo, "branch", base, head]);
	const spec: SwarmSpec = {
		id,
		goal,
		repo,
		base,
		pattern,
		backend,
		criteria: flags.criteria ?? [],
		fitnessCommand: flags.fitness?.[0],
		podSize: Number(flags["pod-size"]?.[0] ?? config.podSize),
		podMemory: flags["pod-memory"]?.[0] ?? config.podMemory,
		maxMembers: Number(flags["max-members"]?.[0] ?? config.maxMembers),
		maxGenerations: Number(flags["max-generations"]?.[0] ?? (pattern === "evolve" ? config.maxGenerations : 1)),
		createdAt: nowIso(),
	};
	const state: SwarmState = {
		spec,
		generation: 1,
		members: [],
		permissions: [],
		claims: [],
		skills: [],
		generations: [],
		pods: {},
		status: "active",
		boardSeq: 0,
	};
	const dir = runDir(id);
	await mkdir(join(dir, "skills"), { recursive: true });
	await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
	const info = await startDaemon(id);
	const client = SwarmClient.fromInfo(info);
	await client.post("/post", { from: "leader", kind: "decision", text: `Goal: ${goal}\nPattern: ${pattern}. Base: ${head.slice(0, 12)}.`, to: "*" });
	if (flags.json) console.log(JSON.stringify({ id, dir, repo, base, head, pattern, backend, port: info.port }));
	else console.log(`swarm ${id} started (${backend}, ${pattern}) in ${dir}`);
}

async function list(json: boolean): Promise<void> {
	const ids = await readdir(swarmsRoot()).catch(() => [] as string[]);
	const rows: { id: string; goal: string; repo: string; pattern: Pattern; backend: BackendKind; generation: number; status: string; daemon: boolean; counts: Record<string, number>; createdAt: string }[] = [];
	for (const id of ids) {
		const state = JSON.parse(await readFile(join(runDir(id), "state.json"), "utf8").catch(() => "null")) as SwarmState | null;
		if (!state) continue;
		const alive = !!(await readInfo(id));
		const counts: Record<string, number> = {};
		for (const member of state.members) counts[member.state] = (counts[member.state] ?? 0) + 1;
		rows.push({ id, goal: state.spec.goal, repo: state.spec.repo, pattern: state.spec.pattern, backend: state.spec.backend, generation: state.generation, status: state.status, daemon: alive, counts, createdAt: state.spec.createdAt });
	}
	rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	if (json) return console.log(JSON.stringify(rows));
	for (const row of rows) {
		const counts = Object.entries(row.counts).map(([state, count]) => `${count} ${state}`).join(", ") || "no members";
		console.log(`${row.id}  ${row.status}${row.daemon ? "" : " (daemon down)"}  ${row.pattern}/g${row.generation}  ${counts}\n    ${row.goal.split("\n")[0].slice(0, 100)}  [${row.repo}]`);
	}
}

async function status(id: string, json: boolean): Promise<void> {
	const state = await (await connect(id)).get<SwarmState & { maxPods: number }>("/state");
	if (json) return console.log(JSON.stringify(state));
	console.log(`${state.spec.id} ${state.status} ${state.spec.pattern} generation ${state.generation}  backend ${state.spec.backend} (max pods ${state.maxPods})`);
	console.log(`goal: ${state.spec.goal}`);
	for (const [pod, info] of Object.entries(state.pods)) console.log(`pod ${pod}: ${info.state}${info.error ? ` - ${info.error}` : ""}`);
	for (const member of state.members) console.log(memberLine(member));
	for (const permission of state.permissions.filter((candidate) => candidate.state === "pending")) {
		console.log(`pending permission ${permission.id} from ${permission.from} (${permission.scope}): ${permission.action}`);
	}
}

async function board(id: string, follow: boolean, kinds?: string): Promise<void> {
	const client = await connect(id);
	let after = 0;
	for (;;) {
		const page = await client.get<{ posts: Post[]; seq: number }>(`/board?after=${after}&limit=500${kinds ? `&kinds=${kinds}` : ""}`);
		for (const post of page.posts) console.log(formatPost(post));
		after = page.posts.at(-1)?.seq ?? page.seq;
		if (!follow) return;
		await Bun.sleep(1_500);
	}
}

async function attach(id: string, member: string): Promise<void> {
	const state = await (await connect(id)).get<{ attach: Record<string, string[]> }>("/state");
	const command = state.attach[member];
	if (!command?.length) fail(`member ${member} has no session yet`);
	const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
}

async function remove(id: string, yes: boolean): Promise<void> {
	const client = await connect(id);
	const state = await client.get<SwarmState>("/state");
	if (!yes) {
		const answer = prompt(`Remove swarm ${id}: stop ${state.members.length} members, fetch their branches, delete ${Object.keys(state.pods).length} pods and their uncommitted work? [y/N]`);
		if (!answer || !/^y(es)?$/i.test(answer.trim())) fail("aborted");
	}
	await client.post("/destroy", {});
	if (state.spec.backend === "local") {
		for (const member of state.members) {
			if (member.worktree) await run("git", ["-C", state.spec.repo, "worktree", "remove", "--force", member.worktree]);
		}
	}
	await client.post("/shutdown", {});
	console.log(`swarm ${id} removed; branches swarm/${id}/* stay in ${state.spec.repo}`);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const { positional, flags } = parse(rest);
	const json = !!flags.json;
	switch (command) {
		case "start":
			return start(flags, positional);
		case "serve":
			if (!positional[0]) fail("serve needs an id");
			return new SwarmDaemon(positional[0]).start();
		case "resume": {
			const info = (await readInfo(positional[0])) ?? (await startDaemon(positional[0]));
			return console.log(`swarm ${positional[0]} daemon pid ${info.pid} on port ${info.port}`);
		}
		case "ls":
		case "list":
			return list(json);
		case "status":
			return status(positional[0] ?? fail("status needs an id"), json);
		case "board":
			return board(positional[0] ?? fail("board needs an id"), !!flags.follow, flags.kinds?.[0]);
		case "send": {
			const [id, to, ...text] = positional;
			if (!id || !to || !text.length) fail("usage: swarm send ID TO TEXT");
			await (await connect(id)).post("/post", { from: "user", kind: "status", to, text: text.join(" ") });
			return;
		}
		case "attach":
			return attach(positional[0] ?? fail("attach needs an id"), positional[1] ?? fail("attach needs a member"));
		case "approve":
		case "deny": {
			const [id, permission, ...note] = positional;
			if (!id || !permission) fail(`usage: swarm ${command} ID PERMISSION [NOTE]`);
			const result = await (await connect(id)).post<Permission>(`/permission/${permission}/decide`, { approve: command === "approve", by: "user", note: note.join(" ") || undefined });
			return console.log(`${result.id}: ${result.state}`);
		}
		case "stop": {
			const [id, ...members] = positional;
			const result = await (await connect(id ?? fail("stop needs an id"))).post<{ stopped: string[] }>("/stop", { members: members.length ? members : undefined });
			return console.log(`stopped: ${result.stopped.join(", ") || "none"}`);
		}
		case "rm":
			return remove(positional[0] ?? fail("rm needs an id"), !!flags.yes);
		case "kit":
			return console.log(process.env.SWARM_KIT_DIR ?? fail("SWARM_KIT_DIR is not set"));
		default:
			console.log(USAGE);
			if (command && command !== "help" && command !== "--help") process.exit(1);
	}
}

await main();
