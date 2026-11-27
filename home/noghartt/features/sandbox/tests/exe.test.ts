import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { decodeMeta } from "../src/names.ts";
import type { KindSpec } from "../src/provider.ts";
import { exeProvider, exeUrl, fingerprint } from "../src/providers/exe.ts";
import { reap } from "../src/reap.ts";
import { Sbx } from "../src/registry.ts";
import { memoryUsage } from "../src/state.ts";
import { fakeExe } from "./fake-exe-client.ts";

const agent: KindSpec = {
  name: "agent",
  provider: "exe",
  egress: "integrations",
  cpu: 2,
  memory: 4,
  integrations: ["llm", "gh-owner-repo"],
  tags: ["agents"],
  setup: "echo built > setup-ran",
  env: { ROLE: "agent" },
};

async function setup(now = () => new Date()) {
  const client = await fakeExe();
  const usage = memoryUsage();
  const provider = exeProvider({ client: async () => client, usage, now });
  return { client, provider, usage };
}

test("create makes a tagged VM with the kind's egress, size, integrations and setup", async () => {
  const { client, provider } = await setup();
  const box = await provider.create({ kind: agent, name: "Fix Login" });
  assert.equal(box.name, "fix-login");
  assert.match(box.id, /^fix-login-[0-9a-f]{6}$/);
  assert.deepEqual(client.calls.filter((c) => c.startsWith("new")), [`new ${box.id} egress=integrations`]);
  const vm = client.vms.get(box.id)!;
  assert.deepEqual(vm.tags, ["sbx", "sbx-name-fix-login", "sbx-kind-agent", "agents"]);
  assert.deepEqual(vm.integrations, ["llm", "gh-owner-repo"]);
  assert.ok(decodeMeta(vm.comment).u);
  assert.equal((await box.exec("cat setup-ran; echo $ROLE")).stdout, "built\nagent\n");
  assert.equal(box.info.egress, "integrations");
  await client.cleanup();
});

test("only sbx's own VMs are sandboxes", async () => {
  const { client, provider } = await setup();
  await client.create({ name: "personal-vm", tags: [], egress: "all" });
  await provider.create({ kind: agent, name: "mine" });
  await provider.templates!.build(agent);
  assert.deepEqual((await provider.list()).map((s) => s.name), ["mine"]);
  assert.equal(await provider.get("personal-vm"), undefined);
  assert.equal(await provider.remove("personal-vm"), false);
  assert.ok(client.vms.has("personal-vm"));
  await client.cleanup();
});

test("templates are built with internet, paused, and copied with the kind's egress", async () => {
  const { client, provider } = await setup();
  const tpl = await provider.templates!.build(agent);
  const tvm = client.vms.get(tpl.id)!;
  assert.match(tpl.id, /^sbx-tpl-agent-[0-9a-f]{6}$/);
  assert.equal(tvm.status, "paused");
  assert.equal(tvm.egress, "all");
  assert.deepEqual(tvm.tags, ["sbx", "sbx-tpl", "sbx-kind-agent"]);
  client.calls.length = 0;
  const box = await provider.create({ kind: agent, name: "fast" });
  assert.ok(client.calls.includes(`cp ${tpl.id} ${box.id} egress=integrations`));
  assert.ok(!client.calls.some((c) => c.startsWith("new")));
  const vm = client.vms.get(box.id)!;
  assert.equal(vm.egress, "integrations");
  assert.deepEqual(vm.tags, ["sbx", "sbx-name-fast", "sbx-kind-agent", "agents"]);
  assert.deepEqual(vm.integrations, ["llm", "gh-owner-repo"]);
  assert.equal((await box.exec("cat setup-ran; echo $ROLE")).stdout, "built\nagent\n");
  assert.deepEqual((await provider.templates!.list([agent])).map((t) => [t.kind, t.current]), [["agent", true]]);
  await client.cleanup();
});

test("a stale or uncopyable template falls back to a fresh VM", async () => {
  const { client, provider } = await setup();
  const old = await provider.templates!.build(agent);
  const changed = { ...agent, setup: "echo v2 > setup-ran" };
  assert.notEqual(fingerprint(changed), fingerprint(agent));
  assert.deepEqual((await provider.templates!.list([changed])).map((t) => t.current), [false]);
  const progress: string[] = [];
  const box = await provider.create({ kind: changed, name: "stale" }, { onProgress: (m) => progress.push(m) });
  assert.ok(progress.some((m) => /stale/.test(m)));
  assert.equal((await box.exec("cat setup-ran")).stdout, "v2\n");

  const rebuilt = await provider.templates!.build(changed);
  assert.ok(!client.vms.has(old.id), "the previous template is removed");
  client.failCopy = true;
  const fallback = await provider.create({ kind: changed, name: "nocopy" });
  assert.equal(fallback.status, "running");
  assert.ok(client.vms.has(rebuilt.id));
  assert.equal(await provider.templates!.remove("agent"), true);
  assert.deepEqual(await provider.templates!.list(), []);
  await client.cleanup();
});

test("a failed setup script leaves no VM behind", async () => {
  const { client, provider } = await setup();
  await assert.rejects(provider.create({ kind: { ...agent, setup: "exit 3" }, name: "broken" }), /setup/);
  assert.equal(client.vms.size, 0);
  await client.cleanup();
});

test("use is stamped on exe.dev once a day, and the reaper respects it", async () => {
  let clock = new Date("2025-06-01T10:00:00Z");
  const { client, provider, usage } = await setup(() => clock);
  const box = await provider.create({ kind: agent, name: "worker" });
  const kept = await provider.create({ kind: agent, name: "pinned" });
  await kept.setKeep(true);
  const comments = () => client.calls.filter((c) => c === `comment ${box.id}`).length;
  await box.exec("true");
  await box.exec("true");
  assert.equal(comments(), 0, "same day: no remote write");
  clock = new Date("2025-06-03T10:00:00Z");
  await box.exec("true");
  assert.equal(comments(), 1);
  assert.equal(decodeMeta(client.vms.get(box.id)!.comment).u, "2025-06-03");

  // Another machine has no local record but sees the remote stamp.
  const elsewhere = exeProvider({ client: async () => client, usage: memoryUsage() });
  assert.equal((await elsewhere.get("worker"))!.info.lastUsed?.toISOString(), "2025-06-03T00:00:00.000Z");
  assert.ok(usage.get(box.id));

  const sbx = new Sbx(parseConfig({ providers: { exe: {} }, kinds: { agent: { egress: "integrations" } } }), {
    factories: new Map([["exe", () => elsewhere]]),
  });
  assert.deepEqual(await reap(sbx, { days: 7, now: new Date("2025-06-05T00:00:00Z") }), { removed: [], failed: [] });
  assert.deepEqual(await reap(sbx, { days: 7, now: new Date("2025-06-20T00:00:00Z"), dryRun: true }), { removed: ["worker"], failed: [] });
  assert.ok(client.vms.has(box.id));
  assert.deepEqual(await reap(sbx, { days: 7, now: new Date("2025-06-20T00:00:00Z") }), { removed: ["worker"], failed: [] });
  assert.ok(!client.vms.has(box.id));
  assert.ok(client.vms.has(kept.id));
  await client.cleanup();
});

test("forks keep the kind and get a fresh name", async () => {
  const { client, provider } = await setup();
  const src = await provider.create({ kind: agent, name: "src" });
  await src.setKeep(true);
  const copy = await provider.fork(src, { kind: agent });
  assert.match(copy.name, /^src-[0-9a-f]{4}$/);
  assert.equal(copy.kind, "agent");
  assert.equal(copy.info.keep, false);
  assert.deepEqual(client.vms.get(copy.id)!.integrations, ["llm", "gh-owner-repo"]);
  await assert.rejects(provider.fork("missing"), /no sandbox named missing/);
  await client.cleanup();
});

test("github add attaches a per-repo integration to every sbx VM", async () => {
  const { client, provider } = await setup();
  assert.equal(await provider.integrations!.addGithub("Owner/Repo", { readonly: true }), "gh-owner-repo");
  assert.deepEqual(client.githubIntegrations, [{ name: "gh-owner-repo", repository: "Owner/Repo", readonly: true, attach: "tag:sbx" }]);
  await client.cleanup();
});

test("URLs use exe.dev's proxy ports", () => {
  const vm = { name: "a-123456", tags: [], httpsUrl: "https://a-123456.exe.xyz" };
  assert.equal(exeUrl(vm), "https://a-123456.exe.xyz");
  assert.equal(exeUrl(vm, 8080), "https://a-123456.exe.xyz:8080");
  assert.throws(() => exeUrl(vm, 443), /3000-9999/);
  assert.equal(exeUrl({ name: "b", tags: [] }), "https://b.exe.xyz");
});
