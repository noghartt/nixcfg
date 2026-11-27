import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMeta } from "../src/names.ts";
import type { KindSpec } from "../src/provider.ts";
import { exeProvider, exeUrl, fingerprint } from "../src/providers/exe.ts";
import { memoryUsage } from "../src/state.ts";
import { fakeExe } from "./fake-exe-client.ts";

const dev: KindSpec = {
  name: "dev",
  provider: "exe",
  egress: "all",
  cpu: 2,
  memory: 4,
  integrations: ["llm"],
  tags: ["sbx-gh"],
  setup: "echo built > setup-ran",
  env: { ROLE: "dev" },
};
const agent: KindSpec = { ...dev, name: "agent", egress: "integrations", env: { ROLE: "agent" } };

async function setup(now = () => new Date()) {
  const client = await fakeExe();
  const usage = memoryUsage();
  const provider = exeProvider({ client: async () => client, usage, now, retryDelayMs: 1 });
  return { client, provider, usage };
}

test("create makes a tagged VM with the kind's egress, size and setup, and no per-VM integrations", async () => {
  const { client, provider } = await setup();
  const box = await provider.create({ kind: dev, name: "Fix Login", checkout: { repo: "o/r", branch: "main", commit: "c".repeat(40) } });
  assert.equal(box.name, "fix-login");
  assert.match(box.id, /^fix-login-[0-9a-f]{6}$/);
  assert.deepEqual(client.calls.filter((c) => c.startsWith("new")), [`new ${box.id} egress=all`]);
  assert.ok(client.calls.includes(`tag -d ${box.id} sbx-provisioning`), "provisioning ends with the tag removed");
  assert.ok(!client.calls.some((c) => c.startsWith("integrations")));
  const vm = client.vms.get(box.id)!;
  assert.deepEqual(vm.tags, ["sbx", "sbx-name-fix-login", "sbx-kind-dev", "sbx-gh"]);
  assert.deepEqual(decodeMeta(vm.comment).s, "c".repeat(40));
  assert.equal(box.info.commit, "c".repeat(40));
  assert.equal((await box.exec("cat setup-ran; echo $ROLE")).stdout, "built\ndev\n");
  await client.cleanup();
});

test("only sbx's own, finished VMs are sandboxes", async () => {
  const { client, provider } = await setup();
  await client.create({ name: "personal-vm", tags: [], egress: "all" });
  await client.create({ name: "half-made", tags: ["sbx", "sbx-name-half", "sbx-provisioning"], egress: "all" });
  const shared = await client.create({ name: "shared-with-me", tags: ["sbx", "sbx-name-shared"], egress: "all" });
  client.vms.get(shared.name)!.egress = undefined;
  await provider.create({ kind: dev, name: "mine" });
  await provider.templates!.build(dev);
  assert.deepEqual((await provider.list()).map((s) => s.name), ["mine"]);
  assert.equal(await provider.get("personal-vm"), undefined);
  assert.equal(await provider.get("shared"), undefined);
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
  assert.deepEqual(vm.tags.sort(), ["sbx", "sbx-gh", "sbx-kind-agent", "sbx-name-fast"]);
  assert.equal((await box.exec("cat setup-ran; echo $ROLE")).stdout, "built\nagent\n");
  assert.deepEqual((await provider.templates!.list([agent])).map((t) => [t.kind, t.current]), [["agent", true]]);
  await client.cleanup();
});

test("restricted kinds with a setup script start only from a current template", async () => {
  const { client, provider } = await setup();
  await assert.rejects(provider.create({ kind: agent, name: "nope" }), /sbx template build agent/);
  await provider.templates!.build(agent);
  await assert.rejects(provider.create({ kind: { ...agent, setup: "echo v2" }, name: "stale" }), /template build/);
  client.failCopy = true;
  await assert.rejects(provider.create({ kind: agent, name: "nocopy" }), /copy refused/);
  assert.ok(!client.calls.some((c) => c.startsWith("new nocopy")), "never a fresh VM without internet for setup");
  assert.deepEqual((await provider.list()).map((s) => s.name), []);
  await client.cleanup();
});

test("unrestricted kinds fall back to a fresh VM from a stale or uncopyable template", async () => {
  const { client, provider } = await setup();
  const old = await provider.templates!.build(dev);
  const changed = { ...dev, setup: "echo v2 > setup-ran" };
  assert.notEqual(fingerprint(changed), fingerprint(dev));
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
  assert.equal(await provider.templates!.remove("dev"), true);
  assert.deepEqual(await provider.templates!.list(), []);
  await client.cleanup();
});

test("a failed setup script leaves no VM behind", async () => {
  const { client, provider } = await setup();
  await assert.rejects(provider.create({ kind: { ...dev, setup: "exit 3" }, name: "broken" }), /setup/);
  assert.equal(client.vms.size, 0);
  await client.cleanup();
});

test("removal is checked and retried rather than assumed", async () => {
  const { client, provider } = await setup();
  const a = await provider.create({ kind: dev, name: "a" });
  client.failRemoves = 1;
  client.removeAnyway = true;
  assert.equal(await provider.remove(a), true, "the request failed but the VM is gone");
  const b = await provider.create({ kind: dev, name: "b" });
  client.failRemoves = 1;
  client.removeAnyway = false;
  assert.equal(await provider.remove(b), true, "retried");
  assert.ok(!client.vms.has(b.id));
  const c = await provider.create({ kind: dev, name: "c" });
  client.failRemoves = 10;
  await assert.rejects(provider.remove(c), new RegExp(`ssh exe.dev rm ${c.id}`));
  client.failRemoves = 0;
  await client.cleanup();
});

test("the sweep removes half-made VMs once they are old enough", async () => {
  let clock = new Date();
  const { client, provider } = await setup(() => clock);
  const keep = await provider.create({ kind: dev, name: "fine" });
  const tpl = await provider.templates!.build(dev);
  await client.create({ name: "provisioning-1", tags: ["sbx", "sbx-name-p", "sbx-provisioning"], egress: "all" });
  await client.create({ name: "untagged-copy-1", tags: ["sbx", "sbx-tpl", "sbx-kind-dev"], egress: "all" });
  await client.create({ name: "nameless-1", tags: ["sbx"], egress: "all" });
  assert.deepEqual(await provider.sweep!({ olderThanMs: 3_600_000 }), [], "too young");
  clock = new Date(Date.now() + 2 * 3_600_000);
  assert.deepEqual((await provider.sweep!({ olderThanMs: 3_600_000 })).sort(), ["nameless-1", "provisioning-1", "untagged-copy-1"]);
  assert.ok(client.vms.has(keep.id) && client.vms.has(tpl.id));
  await client.cleanup();
});

test("use is stamped on exe.dev once a day and read as the day's end", async () => {
  let clock = new Date("2025-06-01T10:00:00Z");
  const { client, provider } = await setup(() => clock);
  const box = await provider.create({ kind: dev, name: "worker" });
  const comments = () => client.calls.filter((c) => c === `comment ${box.id}`).length;
  await box.exec("true");
  await box.touch();
  assert.equal(comments(), 0, "same day as creation: no remote write");
  clock = new Date("2025-06-03T10:00:00Z");
  await box.exec("true");
  assert.equal(comments(), 0, "commands are not use");
  await box.touch();
  await box.touch();
  assert.equal(comments(), 1);
  const elsewhere = exeProvider({ client: async () => client, usage: memoryUsage() });
  assert.equal((await elsewhere.get("worker"))!.info.lastUsed?.toISOString(), "2025-06-03T23:59:59.999Z");
  await client.cleanup();
});

test("forks get a fresh name, lose keep, and keep the kind", async () => {
  const { client, provider } = await setup();
  const src = await provider.create({ kind: dev, name: "src" });
  await src.setKeep(true);
  const copy = await provider.fork(src, { kind: dev });
  assert.match(copy.name, /^src-[0-9a-f]{4}$/);
  assert.equal(copy.kind, "dev");
  assert.equal(copy.info.keep, false);
  assert.deepEqual(client.vms.get(copy.id)!.tags.sort(), ["sbx", "sbx-gh", "sbx-kind-dev", `sbx-name-${copy.name}`]);
  assert.deepEqual((await provider.list()).map((s) => s.name).sort(), ["src", copy.name]);
  await assert.rejects(provider.fork("missing"), /no sandbox named missing/);
  await client.cleanup();
});

test("integrations are printed for the user to attach by tag", async () => {
  const { client, provider } = await setup();
  const [gh] = provider.integrations!.githubCommands("Owner/Repo", { readonly: true });
  assert.match(gh, /^ssh exe\.dev integrations add github --name=gh-owner-repo-[0-9a-f]{6} --repository=Owner\/Repo --attach=tag:sbx-gh --readonly$/);
  assert.deepEqual(provider.integrations!.kindCommands(dev), ["ssh exe.dev integrations attach llm tag:sbx-kind-dev"]);
  await client.cleanup();
});

test("URLs use exe.dev's proxy ports", () => {
  const vm = { name: "a-123456", tags: [], httpsUrl: "https://a-123456.exe.xyz" };
  assert.equal(exeUrl(vm), "https://a-123456.exe.xyz");
  assert.equal(exeUrl(vm, 8080), "https://a-123456.exe.xyz:8080");
  assert.throws(() => exeUrl(vm, 443), /3000-9999/);
  assert.equal(exeUrl({ name: "b", tags: [] }), "https://b.exe.xyz");
});
