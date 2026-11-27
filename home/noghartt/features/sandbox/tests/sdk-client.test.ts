// The real SDK adapter against a stubbed fetch: the exact exe.dev command
// lines sbx sends, and never a metered (standalone) or pool placement.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KindSpec } from "../src/provider.ts";
import { exeProvider } from "../src/providers/exe.ts";
import { sdkClient } from "../src/providers/exe-client.ts";
import { memoryUsage } from "../src/state.ts";

const kind: KindSpec = { name: "dev", provider: "exe", egress: "integrations", cpu: 2, memory: 4, integrations: [], tags: ["sbx-gh"], env: {} };

function stub() {
  const sent: string[] = [];
  const vms = new Map<string, { tags: string[]; comment?: string; status: string }>();
  const record = (name: string) => ({
    vm_name: name,
    ssh_dest: `${name}.exe.xyz`,
    https_url: `https://${name}.exe.xyz`,
    status: vms.get(name)!.status,
    region: "lax",
    region_display: "Los Angeles",
    tags: vms.get(name)!.tags,
    comment: vms.get(name)!.comment,
    created_at: "2025-06-01T00:00:00Z",
    egress_policy: "integrations",
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const line = String(init!.body);
    sent.push(line);
    const words = line.split(" ");
    switch (words[0]) {
      case "ls":
        return json({ vms: [...vms.keys()].map(record) });
      case "new": {
        const name = /--name=(\S+)/.exec(line)![1];
        const tags = [...line.matchAll(/--tag=(\S+)/g)].map((m) => m[1]);
        vms.set(name, { tags, comment: /--comment='([^']*)'/.exec(line)?.[1], status: "running" });
        return json({ ...record(name), ssh_command: "", ssh_host: "", ssh_port: 22, proxy_port: 80, tags });
      }
      case "cp": {
        const [, source, name] = words;
        vms.set(name, { ...vms.get(source)!, status: "running" });
        return json({ name, state: "starting", source, ssh: `${name}.exe.xyz`, ssh_host: "", https_url: "", tags: vms.get(name)!.tags, egress_policy: "integrations", elapsed: 1 });
      }
      case "tag": {
        // The SDK spells the flag --d; exe.dev parses flags Go-style, where that is -d.
        const remove = words[1] === "--d";
        const [name, ...tags] = words.slice(remove ? 2 : 1);
        const vm = vms.get(name)!;
        vm.tags = remove ? vm.tags.filter((t) => !tags.includes(t)) : [...new Set([...vm.tags, ...tags])];
        return json({ vm_name: name, tags: vm.tags });
      }
      case "comment":
        vms.get(words[1])!.comment = words.slice(2).join(" ");
        return json({ vm_name: words[1], comment: "" });
      case "pause":
        vms.get(words[1])!.status = "paused";
        return json({ vm_name: words[1], status: "paused" });
      case "resume":
        vms.get(words[1])!.status = "running";
        return json({ vm_name: words[1], status: "running", cold_booted: "false" });
      case "rm":
        vms.delete(words[1]);
        return json({ deleted: [words[1]], failed: [] });
      case "ssh":
        return new Response('{"stdout":"aGkK"}\n{"exit_code":0}\n', { headers: { "Content-Type": "application/x-ndjson" } });
      default:
        return json({ error: `unexpected ${line}` });
    }
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

test("sbx sends exactly these exe.dev commands", async () => {
  const { sent, fetch } = stub();
  const provider = exeProvider({ client: () => sdkClient({ token: async () => "exe1.test", fetch }), usage: memoryUsage() });
  const box = await provider.create({ kind, name: "web" });
  const id = box.id;
  assert.match(id, /^web-[0-9a-f]{6}$/);
  assert.equal((await box.exec("echo hi")).stdout, "hi\n");
  await box.pause();
  await box.resume();
  await box.setKeep(true);
  const copy = await provider.fork(box, { name: "web2" });
  await provider.remove(copy);

  const lines = sent.filter((l) => !l.startsWith("ls"));
  const at = (prefix: string) => lines.filter((l) => l.startsWith(prefix));
  assert.match(
    at("new")[0],
    new RegExp(`^new --name=${id} --tag=sbx --tag=sbx-name-web --tag=sbx-kind-dev --tag=sbx-gh --tag=sbx-provisioning --comment='\\{"u":"\\d{4}-\\d\\d-\\d\\d"\\}' --cpu=2 --memory=4GB --egress=integrations --no-email$`),
  );
  assert.ok(lines.includes(`tag --d ${id} sbx-provisioning`));
  assert.ok(at(`ssh ${id} 'sh -c `).length >= 1, "commands go through the sh -c wrapper");
  assert.ok(lines.includes(`pause ${id}`) && lines.includes(`resume ${id}`));
  assert.ok(lines.includes(`tag ${id} sbx-keep`));
  const cp = at("cp")[0];
  assert.match(cp, new RegExp(`^cp ${id} web2-[0-9a-f]{6}$`), "copies keep tags (the default), for a tag-scoped token");
  assert.ok(at("rm").length === 1 && /^rm web2-[0-9a-f]{6}$/.test(at("rm")[0]));
  for (const l of sent) assert.doesNotMatch(l, /--(standalone|sandbox|pool|no-pool)\b/, l);
  const used = new Set(sent.map((l) => l.split(" ")[0]));
  for (const c of used) assert.ok(["new", "ls", "cp", "rm", "ssh", "tag", "comment", "pause", "resume"].includes(c), c);
});
