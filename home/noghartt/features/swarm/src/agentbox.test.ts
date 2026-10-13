import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOX_MAX,
	boxName,
	branchScript,
	cloudEnv,
	collectArgs,
	ensureArgs,
	execArgs,
	hostBranch,
	lastLine,
	leftoversScript,
	pickBackend,
	rmArgs,
} from "./agentbox.ts";

const sh = (script: string, cwd?: string) => {
	const result = Bun.spawnSync(["bash", "-c", script], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
	return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
};

describe("boxName", () => {
	test("short names are swarm-<id>-<member>", () => {
		expect(boxName("a1b2c3d4", "parser")).toBe("swarm-a1b2c3d4-parser");
	});

	test("every name is a-z0-9- within the limit, for any member name", () => {
		for (const member of ["Parser_Rewrite", "x".repeat(80), "ünïcode member", "a-b-", "--"]) {
			const name = boxName("a1b2c3d4ffff", member);
			expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(name.length).toBeLessThanOrEqual(BOX_MAX);
		}
	});

	test("long names sharing a prefix stay distinct and deterministic", () => {
		const a = boxName("a1b2c3d4", "implement-the-parser-a");
		const b = boxName("a1b2c3d4", "implement-the-parser-b");
		expect(a).not.toBe(b);
		expect(a).toBe(boxName("a1b2c3d4", "implement-the-parser-a"));
		expect(a.length).toBeLessThanOrEqual(BOX_MAX);
	});

	test("a name that exactly fits is not hashed", () => {
		const member = "m".repeat(BOX_MAX - "swarm-a1b2c3d4-".length);
		expect(boxName("a1b2c3d4", member)).toBe(`swarm-a1b2c3d4-${member}`);
	});

	test("different swarms never share a sandbox", () => {
		expect(boxName("a1b2c3d4", "parser")).not.toBe(boxName("e5f6a7b8", "parser"));
	});
});

describe("agentbox commands", () => {
	test("ensure seeds the repo and passes only the options that are set", () => {
		expect(ensureArgs("box", "/r")).toEqual(["ensure", "box", "--seed", "/r"]);
		expect(ensureArgs("box", "/r", { from: "parent", net: "dev", size: "small" })).toEqual([
			"ensure", "box", "--seed", "/r", "--from", "parent", "--net", "dev", "--size", "small",
		]);
	});

	test("the sandbox directory is the last stdout line", () => {
		expect(lastLine("note\n/agent/sandboxes/box/work/repo\n")).toBe("/agent/sandboxes/box/work/repo");
		expect(lastLine("")).toBe("");
	});

	test("cloud-mode env targets this machine's sandbox", () => {
		expect(cloudEnv("/home/u/repo", "box")).toEqual({ OMO_CLOUD: "local:/home/u/repo", OMO_CLOUD_SANDBOX: "box" });
	});

	test("exec runs the script in the sandbox directory through bash", () => {
		expect(execArgs("box", "/d with 'quote", "git status")).toEqual([
			"exec", "box", "--", "bash", "-lc", "cd '/d with '\\''quote' && (git status\n)",
		]);
	});

	test("collect, rm, and the host branch name", () => {
		expect(collectArgs("box", "/r")).toEqual(["collect", "box", "/r"]);
		expect(rmArgs("box")).toEqual(["rm", "box", "--yes"]);
		expect(hostBranch("box", "swarm/id/m")).toBe("sandbox/box/swarm/id/m");
	});
});

describe("pickBackend", () => {
	test("auto follows the agentbox CLI", () => {
		expect(pickBackend("auto", true)).toBe("agentbox");
		expect(pickBackend("auto", false)).toBe("sbx");
	});

	test("explicit choices win and unknown ones fail", () => {
		expect(pickBackend("local", true)).toBe("local");
		expect(pickBackend("sbx", true)).toBe("sbx");
		expect(() => pickBackend("docker", true)).toThrow("unknown backend docker");
	});
});

describe("scripts against a scratch repository", () => {
	let dir: string;
	let first: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "swarm-agentbox-"));
		const init = [
			"git init -q -b main .",
			"git config user.email t@example.invalid",
			"git config user.name t",
			"echo one > a.txt",
			"git add a.txt",
			"git commit -qm one",
		].join(" && ");
		expect(sh(init, dir).code).toBe(0);
		first = sh("git rev-parse HEAD", dir).out;
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("branchScript creates the member branch at the first start point that resolves", () => {
		const result = sh(branchScript(dir, "swarm/id/m", "swarm/id/base", ["deadbeef", first, "origin/swarm/id/base"]));
		expect(result.err).toBe("");
		expect(sh("git branch --show-current", dir).out).toBe("swarm/id/m");
		expect(sh("git rev-parse HEAD", dir).out).toBe(first);
		expect(sh("git rev-parse swarm/id/base", dir).out).toBe(first);
	});

	test("branchScript resolves a remote-tracking start point", () => {
		sh("git update-ref refs/remotes/origin/swarm/id/p1 HEAD && echo two > a.txt && git commit -qam two", dir);
		const parent = sh("git rev-parse origin/swarm/id/p1", dir).out;
		const result = sh(branchScript(dir, "swarm/id/child", "swarm/id/p1", ["swarm/id/p1", "origin/swarm/id/p1"]));
		expect(result.err).toBe("");
		expect(sh("git rev-parse swarm/id/child", dir).out).toBe(parent);
	});

	test("branchScript is idempotent and keeps the member's commits on a restart", () => {
		expect(sh(branchScript(dir, "swarm/id/m", "swarm/id/base", [first]), undefined).code).toBe(0);
		sh("echo two > a.txt && git commit -qam two", dir);
		const head = sh("git rev-parse HEAD", dir).out;
		sh("git switch -q main", dir);
		expect(sh(branchScript(dir, "swarm/id/m", "swarm/id/base", [first])).code).toBe(0);
		expect(sh("git branch --show-current", dir).out).toBe("swarm/id/m");
		expect(sh("git rev-parse HEAD", dir).out).toBe(head);
	});

	test("branchScript fails loudly when no start point exists", () => {
		const result = sh(branchScript(dir, "swarm/id/m", "swarm/id/missing", ["nope", "origin/nope"]));
		expect(result.code).not.toBe(0);
		expect(result.err).toContain("swarm/id/missing");
		expect(sh("git branch --list swarm/id/m", dir).out).toBe("");
	});

	test("leftoversScript commits uncommitted work and leaves a clean tree alone", () => {
		expect(sh(leftoversScript(dir, "swarm: leftovers")).code).toBe(0);
		expect(sh("git log --oneline | wc -l", dir).out).toBe("1");
		sh("echo two > b.txt", dir);
		expect(sh(leftoversScript(dir, "swarm: leftovers")).code).toBe(0);
		expect(sh("git log -1 --format=%s", dir).out).toBe("swarm: leftovers");
		expect(sh("git status --porcelain", dir).out).toBe("");
	});
});
