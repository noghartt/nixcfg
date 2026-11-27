import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
// No key and no token: anything reaching exe.dev must fail before the network.
const env = { ...process.env, SBX_CONFIG: config, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, EXE_TOKEN: "" };
const sbx = (...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { env, encoding: "utf8" });

test("kinds lists the configured kinds", () => {
  const r = sbx("kinds", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((k: { name: string }) => k.name), ["dev", "agent"]);
  assert.match(sbx("kinds").stdout, /^dev\*\s+exe\s+all/m);
});

test("usage errors exit 2", () => {
  assert.equal(sbx().status, 2);
  assert.equal(sbx("frobnicate").status, 2);
  assert.equal(sbx("exec", "box").status, 2);
  assert.equal(sbx("create", "--bogus").status, 2);
});

test("without credentials it points at auth setup", () => {
  const r = sbx("ls");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sbx auth setup/);
  assert.equal(sbx("reap", "--if-configured").status, 0);
});
