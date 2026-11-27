import { describe, expect, test } from "bun:test";
import { type PlacementInput, placementMode } from "./placement.ts";

const isolated: PlacementInput = { isolated: true, upstream: false, leaderCloud: false };

describe("placementMode", () => {
	test("isolated nodes get a worktree", () => {
		expect(placementMode(isolated)).toBe("worktree");
	});
	test("shared-checkout nodes stay shared", () => {
		expect(placementMode({ ...isolated, isolated: false })).toBe("shared");
		expect(placementMode({ ...isolated, isolated: false, leaderCloud: true })).toBe("shared");
	});
	test("nodes with an upstream work in its checkout", () => {
		expect(placementMode({ ...isolated, upstream: true })).toBe("shared");
		expect(placementMode({ ...isolated, isolated: false, upstream: true })).toBe("shared");
	});
	test("a cloud-mode leader cannot give a node its own worktree", () => {
		expect(() => placementMode({ ...isolated, leaderCloud: true })).toThrow("cloud mode");
	});
});
