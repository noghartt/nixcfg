import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sandbox, SandboxInfo } from "../src/provider.ts";
import { reapable } from "../src/reap.ts";

const now = new Date("2025-06-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const box = (name: string, info: Partial<SandboxInfo>) => ({ name, info: { keep: false, ...info } }) as unknown as Sandbox;

test("reaps sandboxes idle longer than the limit, sparing kept ones", () => {
  const boxes = [
    box("fresh", { created: daysAgo(30), lastUsed: daysAgo(1) }),
    box("idle", { created: daysAgo(30), lastUsed: daysAgo(8) }),
    box("never-used-old", { created: daysAgo(9) }),
    box("never-used-new", { created: daysAgo(2) }),
    box("kept", { created: daysAgo(30), lastUsed: daysAgo(30), keep: true }),
    box("unknown", {}),
  ];
  assert.deepEqual(reapable(boxes, 7, now).map((b) => b.name), ["idle", "never-used-old"]);
  assert.deepEqual(reapable(boxes, 0.5, now).map((b) => b.name), ["fresh", "idle", "never-used-old", "never-used-new"]);
});
