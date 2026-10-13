import { describe, expect, test } from "bun:test";
import { defaultBranchOf, type Exec, publishRef, refuseTarget } from "./publish.ts";

const SYMREF = "ref: refs/heads/main\tHEAD\n0123abcd\tHEAD";

function fakeExec(responses: Record<string, string> = {}) {
	const calls: string[][] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);
		const key = Object.keys(responses).find((pattern) => [command, ...args].join(" ").includes(pattern));
		return key ? responses[key] : "";
	};
	return { exec, calls };
}

describe("publish helpers", () => {
	test("reads the default branch from ls-remote --symref", () => {
		expect(defaultBranchOf(SYMREF)).toBe("main");
		expect(defaultBranchOf("")).toBeUndefined();
	});
	test("refuses the default branch and non-branch names", () => {
		expect(refuseTarget("main", "main")).toBeDefined();
		expect(refuseTarget("refs/heads/x", "main")).toBeDefined();
		expect(refuseTarget("-f", "main")).toBeDefined();
		expect(refuseTarget("feat/orchestrator-publish", "main")).toBeUndefined();
	});
});

describe("publishRef", () => {
	test("pushes over SSH without force, then opens a draft PR against the default branch", async () => {
		const { exec, calls } = fakeExec({ "ls-remote": SYMREF, "pr create": "https://github.com/o/r/pull/1" });
		const lines = await publishRef(exec, {
			repo: "/repo",
			ref: "refs/remotes/sandbox/obox/orch/run-api",
			name: "feat/api",
			pr: { title: "Add API", body: "Body" },
		});
		const push = calls.find((call) => call.includes("push"))!;
		expect(push).toContain("url.git@github.com:.insteadOf=https://github.com/");
		expect(push).toContain("refs/remotes/sandbox/obox/orch/run-api:refs/heads/feat/api");
		expect(push.some((arg) => arg.startsWith("-f") || arg === "--force" || arg.startsWith("+"))).toBe(false);
		const pr = calls.find((call) => call[0] === "gh")!;
		expect(pr).toEqual(["gh", "pr", "create", "--draft", "--head", "feat/api", "--base", "main", "--title", "Add API", "--body", "Body"]);
		expect(lines.at(-1)).toContain("pull/1");
	});
	test("refuses the default branch before pushing", async () => {
		const { exec, calls } = fakeExec({ "ls-remote": SYMREF });
		await expect(publishRef(exec, { repo: "/repo", ref: "refs/heads/x", name: "main" })).rejects.toThrow("default branch");
		expect(calls.some((call) => call.includes("push"))).toBe(false);
	});
	test("fails when origin's default branch cannot be resolved", async () => {
		const { exec, calls } = fakeExec();
		await expect(publishRef(exec, { repo: "/repo", ref: "refs/heads/x", name: "feat/x" })).rejects.toThrow("default branch");
		expect(calls.some((call) => call.includes("push"))).toBe(false);
	});
});
