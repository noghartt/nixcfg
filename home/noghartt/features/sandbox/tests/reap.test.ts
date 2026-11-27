import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import type { KindSpec, Sandbox, SandboxInfo } from "../src/provider.ts";
import { exeProvider } from "../src/providers/exe.ts";
import { pruneArchives, reap, reapable } from "../src/reap.ts";
import { Sbx } from "../src/registry.ts";
import { memoryUsage } from "../src/state.ts";
import { fakeExe } from "./fake-exe-client.ts";

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

test("old archives are pruned", async () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-archive-"));
  for (const [stamp, age] of [["old", 40], ["new", 1]] as const) {
    mkdirSync(join(root, "box", stamp), { recursive: true });
    const t = daysAgo(age);
    utimesSync(join(root, "box", stamp), t, t);
  }
  assert.deepEqual(await pruneArchives(root, 30 * 86_400_000, now), ["box/old"]);
  assert.deepEqual(readdirSync(join(root, "box")), ["new"]);
});

test("the reaper skips busy sandboxes, archives branches before removing, and sweeps leaks", async () => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "sbx",
    GIT_AUTHOR_EMAIL: "sbx@example.invalid",
    GIT_COMMITTER_NAME: "sbx",
    GIT_COMMITTER_EMAIL: "sbx@example.invalid",
  });
  // A `who` the test controls: the host's own login sessions must not count.
  const bin = mkdtempSync(join(tmpdir(), "sbx-bin-"));
  writeFileSync(join(bin, "who"), '#!/bin/sh\n[ -f "$HOME/logged-in" ] && echo "user pts/0"\nexit 0\n', { mode: 0o755 });
  const kind: KindSpec = { name: "dev", provider: "exe", egress: "all", integrations: [], tags: [], env: { PATH: `${bin}:${process.env.PATH}` } };
  let clock = new Date("2025-06-01T10:00:00Z");
  const client = await fakeExe();
  const provider = exeProvider({ client: async () => client, usage: memoryUsage(), now: () => clock, retryDelayMs: 1 });
  const sbx = new Sbx(parseConfig({ providers: { exe: {} }, kinds: { dev: {} } }), { factories: new Map([["exe", () => provider]]) });

  const idle = await provider.create({ kind, name: "idle", checkout: { repo: "owner/project" } });
  await idle.exec("git init -q -b main project && cd project && git commit -q --allow-empty -m work");
  const running = await provider.create({ kind, name: "running" });
  const login = await provider.create({ kind, name: "login" });
  await login.exec("touch logged-in");
  const kept = await provider.create({ kind, name: "kept" });
  await kept.setKeep(true);
  await client.create({ name: "leak-1", tags: ["sbx", "sbx-provisioning"], egress: "all" });
  client.vms.get("leak-1")!.createdAt = "2025-06-01T00:00:00Z";
  const job = running.exec("sleep 4");

  clock = new Date("2025-06-20T10:00:00Z");
  const archiveDir = mkdtempSync(join(tmpdir(), "sbx-archive-"));
  const dry = await reap(sbx, { days: 7, now: clock, dryRun: true, archiveDir });
  assert.deepEqual(dry.removed, ["idle"]);
  assert.equal(client.vms.size, 5);

  const result = await reap(sbx, { days: 7, now: clock, archiveDir });
  assert.deepEqual(result.swept, ["leak-1"]);
  assert.deepEqual(result.removed, ["idle"]);
  assert.deepEqual(result.archived, ["idle"]);
  assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["login", "running"]);
  assert.match(result.skipped.find((s) => s.name === "running")!.reason, /1 command/);
  assert.match(result.skipped.find((s) => s.name === "login")!.reason, /login/);
  assert.deepEqual(result.failed, []);
  assert.ok(!client.vms.has(idle.id) && client.vms.has(kept.id));

  const [stamp] = readdirSync(join(archiveDir, "idle"));
  const bundle = join(archiveDir, "idle", stamp, "branches.bundle");
  assert.ok(existsSync(join(archiveDir, "idle", stamp, "sandbox.json")));
  assert.match(execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" }), /refs\/heads\/main/);
  await job;
  await client.cleanup();
});
