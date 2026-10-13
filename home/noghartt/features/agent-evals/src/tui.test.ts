import { describe, expect, test } from "bun:test";
import { classifyHeuristic, unlabeledItems } from "./classify.ts";
import { getLabel, turnTarget } from "./labels.ts";
import { fixtureDb } from "./testutil.ts";
import { createState, decodeKeys, handleKey, render } from "./tui.ts";

const keys = (db: Parameters<typeof handleKey>[0], s: Parameters<typeof handleKey>[1], ...ks: string[]) => {
	for (const k of ks) handleKey(db, s, k);
};

describe("label ui", () => {
	test("rates a session, sets a class and a note from the keyboard", () => {
		const { db } = fixtureDb();
		const s = createState(db);
		expect(s.items.length).toBe(4);
		const id = s.items[s.cursor].id;
		keys(db, s, "g", "c", "b");
		expect(getLabel(db, "session", id)).toMatchObject({ rating: "good", task_class: "bugfix" });
		keys(db, s, "e", ..."flaky env".split(""), "enter");
		expect(getLabel(db, "session", id)?.notes).toBe("flaky env");
		keys(db, s, "u");
		expect(s.items.some((i) => i.id === id)).toBe(false);
	});

	test("turn mode rates assistant turns and requests an editor for the preferred answer", () => {
		const { db } = fixtureDb();
		const s = createState(db);
		keys(db, s, "/", ..."Fix the".split(""), "enter");
		expect(s.items).toHaveLength(1);
		keys(db, s, "enter");
		expect(s.focus).toBe("turns");
		expect(s.turns[s.turnCursor].role).toBe("assistant");
		keys(db, s, "b", "p");
		expect(s.editRequest).not.toBeNull();
		s.editRequest!.commit("Run nix build with the right attribute first.\n");
		s.editRequest = null;
		const label = getLabel(db, "turn", turnTarget("omo:omo-sess-1", s.turns[s.turnCursor].uid));
		expect(label).toMatchObject({ rating: "bad", preferred: "Run nix build with the right attribute first." });
		keys(db, s, "k");
		expect(s.message).toContain("bad");
		keys(db, s, "g");
		expect(s.message).toBe("only assistant turns are rated");
	});

	test("accepts a suggestion and switches views; render fits the terminal", () => {
		const { db } = fixtureDb();
		classifyHeuristic(db, unlabeledItems(db));
		const s = createState(db);
		keys(db, s, "tab");
		expect(s.view).toBe("nodes");
		expect(s.items).toHaveLength(4);
		keys(db, s, "a");
		expect(s.message).toMatch(/^accepted heuristic class /);
		const lines = render(db, s, 100, 20);
		expect(lines).toHaveLength(20);
		const plain = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
		for (const l of plain) expect(l.length).toBeLessThanOrEqual(100);
		keys(db, s, "tab", "tab", "q");
		expect(s.view).toBe("sessions");
		expect(s.quit).toBe(true);
	});

	test("decodes terminal input", () => {
		expect(decodeKeys("\x1b[A")).toEqual(["up"]);
		expect(decodeKeys("jk\r")).toEqual(["j", "k", "enter"]);
		expect(decodeKeys("\x7f\x1b\t")).toEqual(["backspace", "esc", "tab"]);
	});
});
