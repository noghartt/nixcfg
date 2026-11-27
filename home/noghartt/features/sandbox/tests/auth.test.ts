import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signToken } from "@exedev/sdk";
import { addKeyInstruction, keyPath, setupKey, TOKEN_COMMANDS, token, tokenPermissions } from "../src/providers/exe-auth.ts";

test("tokens expire within the hour and allow only sbx's commands", () => {
  const now = Date.UTC(2025, 0, 1);
  const p = tokenPermissions(now);
  assert.equal(p.exp, now / 1000 + 3600);
  assert.deepEqual(p.cmds, [...TOKEN_COMMANDS]);
  for (const forbidden of ["ssh-key add", "ssh-key generate-api-key", "integrations remove", "billing capacity", "share set-public"])
    assert.ok(!p.cmds.includes(forbidden), forbidden);
});

test("EXE_TOKEN overrides the key", async () => {
  const t = await token(async () => assert.fail("must not sign"), { EXE_TOKEN: "exe1.given" });
  assert.equal(t, "exe1.given");
});

test("a missing key says how to make one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbx-auth-"));
  await assert.rejects(token(signToken, { XDG_CONFIG_HOME: dir }), /sbx auth setup/);
  assert.equal(keyPath({ XDG_CONFIG_HOME: dir }), join(dir, "sbx", "exe_key"));
});

test("auth setup makes a private ed25519 key, and tokens are signed from it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbx-auth-"));
  const env = { XDG_CONFIG_HOME: dir };
  const path = keyPath(env);
  assert.deepEqual(await setupKey(path), { path, created: true });
  assert.deepEqual(await setupKey(path), { path, created: false });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(addKeyInstruction(path), /ssh exe\.dev ssh-key add < .*exe_key\.pub$/);
  const t = await token(signToken, env);
  const [scheme, payload] = t.split(".");
  assert.equal(scheme, "exe0");
  const perms = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(perms.cmds, [...TOKEN_COMMANDS]);
  assert.ok(perms.exp > Date.now() / 1000 && perms.exp <= Date.now() / 1000 + 3600);
});
