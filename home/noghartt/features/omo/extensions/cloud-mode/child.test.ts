import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkOption,
	childBoxName,
	childBranch,
	childIdentity,
	collectedRef,
	ensureArgs,
	isReadOnly,
	MAX_BOX,
	parseMarker,
	readTaskRecord,
	shortId,
	takeOption,
	withMarker,
} from "./child.ts";

describe("naming", () => {
	test("short id keeps the tail of a task id", () => {
		expect(shortId("st_01a1325e")).toBe("1a1325e".slice(-6));
		expect(shortId("0198-ABCD-ef12")).toBe("cdef12");
		expect(shortId("")).toBe("child");
	});

	test("child box is parent-short and fits agentbox names", () => {
		const name = childBoxName("nixcfg-a1b2c3", "1a1325");
		expect(name).toBe("nixcfg-a1b2c3-1a1325");
		expect(name).toMatch(/^[a-z0-9-]+$/);
	});

	test("a long parent is cut, the short suffix survives, no double dash", () => {
		const name = childBoxName("a-very-long-repository-name-x-9z9z9z", "1a1325");
		expect(name.length).toBeLessThanOrEqual(MAX_BOX);
		expect(name.endsWith("-1a1325")).toBe(true);
		expect(name).not.toContain("--");
	});

	test("branch and delivered ref", () => {
		expect(childBranch("nixcfg-a1b2c3", "1a1325")).toBe("task/nixcfg-a1b2c3/1a1325");
		expect(collectedRef("nixcfg-a1b2c3-1a1325", "task/nixcfg-a1b2c3/1a1325")).toBe("sandbox/nixcfg-a1b2c3-1a1325/task/nixcfg-a1b2c3/1a1325");
	});
});

describe("read-only classification", () => {
	test.each(["explore", "librarian", "oracle", "plan-consultant", "plan-reviewer", "omo-native-code-reviewer", "omo-native-gate-reviewer"])("%s shares the parent's sandbox", (agentType) => {
		expect(isReadOnly({ agentType })).toBe(true);
	});

	test("general work and unknown types get their own", () => {
		expect(isReadOnly({})).toBe(false);
		expect(isReadOnly({ agentType: "general" })).toBe(false);
		expect(isReadOnly({ category: "deep-low" })).toBe(false);
		expect(isReadOnly({ agentType: "omo-native-qa-executor" })).toBe(false);
	});

	test("an allowlist without writers is read-only; bash alone counts as a writer", () => {
		expect(isReadOnly({ toolAllow: ["read", "grep", "find"] })).toBe(true);
		expect(isReadOnly({ toolAllow: ["read", "bash"] })).toBe(false);
		expect(isReadOnly({ toolAllow: ["*"] })).toBe(false);
	});

	test("a denylist must cover every writer", () => {
		expect(isReadOnly({ toolDeny: ["write", "edit", "apply_patch", "bash", "powershell"] })).toBe(true);
		expect(isReadOnly({ toolDeny: ["write", "edit"] })).toBe(false);
	});
});

describe("parent marker", () => {
	const info = { spec: "mellon:/home/u/www/x", box: "x-abc123", env: ["GH_TOKEN"], net: "dev", size: "medium", share: false };

	test("round-trips and survives surrounding text", () => {
		const prompt = withMarker("Fix the bug", info);
		expect(prompt.startsWith("Fix the bug")).toBe(true);
		expect(parseMarker(`Task:\n${prompt}\n`)).toEqual(info);
	});

	test("a re-sent prompt keeps exactly one marker", () => {
		const once = withMarker("Do it", info);
		const twice = withMarker(once, { ...info, box: "other-box" });
		expect(twice.match(/cloud-mode:/g)).toHaveLength(1);
		expect(parseMarker(twice)?.box).toBe("other-box");
	});

	test("missing or damaged markers read as absent", () => {
		expect(parseMarker("no marker here")).toBeUndefined();
		expect(parseMarker("<!--cloud-mode:AAAA-->")).toBeUndefined();
		expect(parseMarker(`<!--cloud-mode:${Buffer.from('{"spec":1}').toString("base64")}-->`)).toBeUndefined();
	});
});

describe("options", () => {
	test("takeOption reads both forms and leaves the rest", () => {
		expect(takeOption(["host:/p", "--sandbox", "--net", "dev", "--size=large"], "net")).toEqual({ value: "dev", rest: ["host:/p", "--sandbox", "--size=large"] });
		expect(takeOption(["host", "--size=small"], "size")).toEqual({ value: "small", rest: ["host"] });
		expect(takeOption(["host"], "net")).toEqual({ value: undefined, rest: ["host"] });
	});

	test("checkOption accepts names only", () => {
		expect(checkOption("net", "dev")).toBe("dev");
		expect(checkOption("net", undefined)).toBeUndefined();
		expect(checkOption("size", "")).toBeUndefined();
		expect(() => checkOption("net", "dev; rm -rf /")).toThrow();
		expect(() => checkOption("size", "Big")).toThrow();
	});

	test("ensure arguments follow contract C1", () => {
		expect(ensureArgs("b", "/p", {})).toEqual(["ensure", "b", "--seed", "/p"]);
		expect(ensureArgs("child", "/p", { from: "b", net: "none", size: "small" })).toEqual(["ensure", "child", "--seed", "/p", "--from", "b", "--net", "none", "--size", "small"]);
	});
});

describe("child identity", () => {
	test("session context role wins", () => {
		expect(childIdentity({ sessionContext: { role: "child", task_id: "st_0a1b2c3d", state_dir: "/s/children/st_0a1b2c3d" } }, {})).toEqual({
			role: "child",
			taskId: "st_0a1b2c3d",
			stateDir: "/s/children/st_0a1b2c3d",
		});
		expect(childIdentity({ sessionContext: { role: "member" } }, {})?.role).toBe("member");
		expect(childIdentity({ sessionContext: { role: "weird" } }, {})?.role).toBe("child");
	});

	test("spawned children are recognised by the environment", () => {
		const env = { OMO_SENPI_TASK_RPC_CHILD: "1", SENPI_CODING_AGENT_SESSION_DIR: "/s/sessions/st_deadbeef" };
		expect(childIdentity({}, env)).toEqual({ role: "child", taskId: "st_deadbeef" });
	});

	test("an ordinary session is not a child", () => {
		expect(childIdentity({}, {})).toBeUndefined();
		expect(childIdentity({ sessionContext: {} }, { OMO_SENPI_TASK_RPC_CHILD: "0" })).toBeUndefined();
	});
});

describe("task record", () => {
	test("reads agent type and tool lists from either state layout", () => {
		const root = mkdtempSync(join(tmpdir(), "cloud-mode-"));
		mkdirSync(join(root, "tasks"), { recursive: true });
		mkdirSync(join(root, "children", "st_0a1b2c3d"), { recursive: true });
		writeFileSync(join(root, "tasks", "st_0a1b2c3d.json"), JSON.stringify({ agent_type: "explore", tool_allow: ["read"], tool_deny: ["bash"] }));
		const expected = { agentType: "explore", category: undefined, toolAllow: ["read"], toolDeny: ["bash"] };
		expect(readTaskRecord({ role: "child", taskId: "st_0a1b2c3d", stateDir: join(root, "children", "st_0a1b2c3d") })).toEqual(expected);
		expect(readTaskRecord({ role: "child", taskId: "st_0a1b2c3d", stateDir: root })).toEqual(expected);
	});

	test("unreadable records read as unknown", () => {
		expect(readTaskRecord({ role: "child", taskId: "st_00000000", stateDir: "/nonexistent" })).toBeUndefined();
		expect(readTaskRecord({ role: "child" })).toBeUndefined();
	});
});
