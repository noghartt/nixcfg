import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sbx-cli-"));
const config = join(dir, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    defaultKind: "dev",
    providers: { exe: { type: "exe" } },
    kinds: { dev: { provider: "exe", egress: "all", cpu: 2, memory: 4 }, agent: { provider: "exe", egress: "integrations", integrations: ["llm"] } },
  }),
);
// No credentials: anything reaching exe.dev must fail before the network.
const env = { ...process.env, SBX_CONFIG: config, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, EXE_TOKEN: "" };
const sbx = (args: string[], input?: string) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { env, encoding: "utf8", input });

test("kinds lists the configured kinds", () => {
  const r = sbx(["kinds", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((k: { name: string }) => k.name), ["dev", "agent"]);
  assert.match(sbx(["kinds"]).stdout, /^dev\*\s+exe\s+all/m);
});

test("usage errors exit 2, and are checked before any VM is made", () => {
  assert.equal(sbx([]).status, 2);
  assert.equal(sbx(["frobnicate"]).status, 2);
  assert.equal(sbx(["exec", "box"]).status, 2);
  assert.equal(sbx(["create", "--bogus"]).status, 2);
  const r = sbx(["run", "--timeout", "soon", "--", "true"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--timeout/);
});

test("without credentials it points at auth setup, and the reaper stays quiet", () => {
  const r = sbx(["ls"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sbx auth setup/);
  assert.equal(sbx(["reap", "--if-configured"]).status, 0);
});

test("auth setup stores a piped token and prints the integration commands", () => {
  const r = sbx(["auth", "setup"], '{"label":"sbx-x","token":"exe1.piped","namespace":"v0@exe.dev"}');
  assert.equal(r.status, 0, r.stderr);
  const path = join(dir, "sbx", "exe_token");
  assert.equal(readFileSync(path, "utf8"), "exe1.piped\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(r.stdout, /ssh exe\.dev integrations attach llm tag:sbx-kind-agent/);
  assert.equal(sbx(["auth", "setup"], "garbage").status, 1);
});

test("github add prints a tag-scoped integration command", () => {
  const r = sbx(["github", "add", "owner/repo", "--readonly"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ssh exe\.dev integrations add github --name=gh-owner-repo-[0-9a-f]{6} --repository=owner\/repo --attach=tag:sbx-gh --readonly/);
});
