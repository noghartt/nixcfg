import { describe, expect, test } from "bun:test";
import { defaultPlacement, guardPlacement, type PlacementInput, placementMenu, resolveMode, type WorkersConfig } from "./placement.ts";

const workers: WorkersConfig = {
	placement: "auto",
	envAllowed: { GH_TOKEN: "read-only gh token" },
	allowOpenNet: false,
	net: "dev",
	size: "medium",
};
const isolated: PlacementInput = { kind: "work", isolated: true, leaderCloud: false, mode: "sandbox" };

describe("resolveMode", () => {
	test("auto uses sandboxes only with agentbox and OmO", () => {
		expect(resolveMode("auto", true, "omo").mode).toBe("sandbox");
		expect(resolveMode("auto", false, "omo").mode).toBe("worktree");
		expect(resolveMode("auto", true, "pi").mode).toBe("worktree");
	});
	test("an explicit setting cannot force sandboxes onto Pi or a host without agentbox", () => {
		expect(resolveMode("sandbox", true, "pi").mode).toBe("worktree");
		expect(resolveMode("sandbox", false, "omo").mode).toBe("worktree");
		expect(resolveMode("worktree", true, "omo").mode).toBe("worktree");
	});
});

describe("placementMenu", () => {
	test("isolated nodes choose between a sandbox and a worktree on a sandbox host", () => {
		expect(placementMenu(isolated)).toEqual(["sandbox", "worktree"]);
		expect(placementMenu({ ...isolated, mode: "worktree" })).toEqual(["worktree"]);
	});
	test("a cloud-mode leader keeps every isolated node in a sandbox", () => {
		expect(placementMenu({ ...isolated, leaderCloud: true, mode: "worktree" })).toEqual(["sandbox"]);
	});
	test("shared-checkout nodes stay shared", () => {
		expect(placementMenu({ ...isolated, isolated: false })).toEqual(["shared"]);
	});
	test("review nodes share the reviewed checkout, even a sandbox", () => {
		expect(placementMenu({ ...isolated, kind: "review", upstream: { sandbox: true } })).toEqual(["shared"]);
	});
	test("work on a sandbox upstream may branch into its own sandbox", () => {
		expect(placementMenu({ ...isolated, upstream: { sandbox: true } })).toEqual(["shared", "sandbox"]);
		expect(placementMenu({ ...isolated, upstream: { sandbox: false } })).toEqual(["shared"]);
	});
});

describe("guardPlacement", () => {
	test("without a proposal it returns the defaults with every allowed key", () => {
		expect(guardPlacement({}, isolated, workers, ["GH_TOKEN"])).toEqual({
			mode: "sandbox",
			net: "dev",
			size: "medium",
			env: ["GH_TOKEN"],
			overridden: [],
		});
	});
	test("refuses open network unless the config allows it", () => {
		const refused = guardPlacement({ net: "open" }, isolated, workers, []);
		expect(refused.net).toBe("dev");
		expect(refused.overridden).toHaveLength(1);
		expect(guardPlacement({ net: "open" }, isolated, { ...workers, allowOpenNet: true }, []).net).toBe("open");
	});
	test("a default of open is downgraded when open is not allowed", () => {
		expect(defaultPlacement(isolated, { ...workers, net: "open" }, []).net).toBe("dev");
	});
	test("never gives env keys beyond the allowed list", () => {
		const guarded = guardPlacement({ env: ["GH_TOKEN", "AWS_SECRET", "GH_TOKEN"] }, isolated, workers, ["GH_TOKEN"]);
		expect(guarded.env).toEqual(["GH_TOKEN"]);
		expect(guarded.overridden.join()).toContain("AWS_SECRET");
	});
	test("an empty env proposal clears the keys", () => {
		expect(guardPlacement({ env: [] }, isolated, workers, ["GH_TOKEN"]).env).toEqual([]);
	});
	test("a placement outside the menu keeps the default", () => {
		const review = guardPlacement({ mode: "sandbox" }, { ...isolated, kind: "review", upstream: { sandbox: true } }, workers, []);
		expect(review.mode).toBe("shared");
		expect(review.overridden).toHaveLength(1);
		expect(guardPlacement({ mode: "worktree" }, isolated, workers, []).mode).toBe("worktree");
	});
	test("unknown net and size values keep the defaults", () => {
		const guarded = guardPlacement({ net: "lan", size: "huge" }, isolated, workers, []);
		expect([guarded.net, guarded.size]).toEqual(["dev", "medium"]);
		expect(guarded.overridden).toHaveLength(2);
	});
});
