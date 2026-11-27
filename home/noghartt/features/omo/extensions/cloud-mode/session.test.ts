import { describe, expect, test } from "bun:test";
import { activeTools, legacyTarget, roleOf } from "./session.ts";

const LOCAL_ONLY = /^(lsp_.*|apply_patch)$/;

describe("roleOf", () => {
	test("a session context role or the RPC child flag marks a child", () => {
		expect(roleOf({ sessionContext: { role: "member" } }, {})).toBe("child");
		expect(roleOf({}, { OMO_SENPI_TASK_RPC_CHILD: "1" })).toBe("child");
		expect(roleOf({}, {})).toBe("top");
	});
});

describe("activeTools", () => {
	test("the top session gets the remote writers and publish", () => {
		expect(activeTools(["bash", "apply_patch", "lsp_hover"], "top", LOCAL_ONLY)).toEqual(["bash", "read", "write", "edit", "publish"]);
	});
	test("a read-only child stays read-only and never publishes", () => {
		expect(activeTools(["read", "grep", "publish", "lsp_hover"], "child", LOCAL_ONLY)).toEqual(["read", "grep"]);
	});
	test("a writing child keeps its own writers", () => {
		expect(activeTools(["read", "write", "edit", "bash"], "child", LOCAL_ONLY)).toEqual(["read", "write", "edit", "bash"]);
	});
});

describe("legacyTarget", () => {
	test("a resumed sandbox entry is blocked", () => {
		expect(legacyTarget({ spec: "mellon:/home/u/x", entry: { spec: "mellon:/home/u/x", sandbox: "x-abc123" } })).toContain("x-abc123");
	});
	test("an inherited sandbox name is blocked", () => {
		expect(legacyTarget({ spec: "mellon:/x", env: { OMO_CLOUD_SANDBOX: "box" } })).toContain("OMO_CLOUD_SANDBOX");
	});
	test("the local and exe targets are blocked", () => {
		expect(legacyTarget({ spec: "local:/repo" })).toContain("local");
		expect(legacyTarget({ spec: "exe" })).toContain("exe");
	});
	test("plain SSH targets pass", () => {
		expect(legacyTarget({ spec: "mellon", entry: { spec: "mellon:/x" }, env: {} })).toBeUndefined();
		expect(legacyTarget({ spec: "localhost:/x" })).toBeUndefined();
	});
});
