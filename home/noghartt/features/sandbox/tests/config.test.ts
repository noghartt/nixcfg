import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, parseConfig } from "../src/config.ts";
import { UnsupportedError } from "../src/provider.ts";
import { kindProblem, type ProviderFactory, Sbx } from "../src/registry.ts";
import { fakeProvider } from "../src/testing.ts";

const raw = {
  defaultKind: "dev",
  providers: { exe: { type: "exe" }, local: { type: "fake" } },
  kinds: {
    dev: { provider: "exe", egress: "all", cpu: 2, memory: 4, setup: "#!/bin/sh\ntrue", env: { A: "1" } },
    agent: { provider: "exe", egress: "integrations", cpu: 2, memory: 4, integrations: ["llm"], tags: ["agents"] },
    plain: { provider: "local" },
  },
};

test("parses kinds with defaults", () => {
  const c = parseConfig(raw);
  assert.equal(c.defaultKind, "dev");
  assert.equal(c.reap.days, 7);
  assert.deepEqual(c.kinds.agent, {
    name: "agent",
    provider: "exe",
    egress: "integrations",
    cpu: 2,
    memory: 4,
    disk: undefined,
    integrations: ["llm"],
    tags: ["agents"],
    setup: undefined,
    image: undefined,
    env: {},
  });
  assert.equal(c.kinds.plain.egress, "all");
});

test("rejects bad configs clearly", () => {
  assert.throws(() => parseConfig({ kinds: {} }), /no providers/);
  assert.throws(() => parseConfig({ providers: { exe: {} }, kinds: {} }), /no kinds/);
  assert.throws(() => parseConfig({ providers: { exe: {} }, kinds: { a: { egress: "some" } } }), /egress/);
  assert.throws(() => parseConfig({ providers: { exe: {} }, kinds: { a: { provider: "nope" } } }), /unknown provider/);
  assert.throws(() => parseConfig({ providers: { exe: {} }, kinds: { a: { cpu: -1 } } }), /cpu/);
  assert.throws(() => parseConfig({ providers: { exe: {} }, kinds: { a: { env: { "BAD-NAME": "x" } } } }), /variable name/);
  assert.throws(() => parseConfig({ ...raw, defaultKind: "nope" }), ConfigError);
});

test("loads the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbx-config-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw));
  assert.equal(loadConfig(join(dir, "config.json")).kinds.dev.env.A, "1");
  assert.throws(() => loadConfig(join(dir, "missing.json")), /cannot read/);
});

test("kinds are checked against their provider's capabilities", async () => {
  const fake = await fakeProvider();
  const factories = new Map<string, ProviderFactory>([
    ["fake", () => fake],
    ["exe", () => fake],
  ]);
  const sbx = new Sbx(
    parseConfig({ ...raw, kinds: { ...raw.kinds, sized: { provider: "local", cpu: 2 }, restricted: { provider: "local", egress: "integrations" } } }),
    { factories },
  );
  assert.equal(sbx.kind("plain").name, "plain");
  assert.throws(() => sbx.kind("restricted"), (e: Error) => e instanceof UnsupportedError && /egress integrations/.test(e.message));
  assert.throws(() => sbx.kind("sized"), /sizing/);
  assert.throws(() => sbx.kind("agent"), /egress integrations/);
  assert.throws(() => sbx.kind("missing"), /unknown kind missing/);
  assert.equal(kindProblem(sbx.config.kinds.plain, fake.capabilities()), undefined);
  assert.throws(() => new Sbx(parseConfig({ providers: { x: { type: "nope" } }, kinds: { a: {} } }), { factories }).provider("x"), /no provider type nope/);
  await fake.cleanup();
});
