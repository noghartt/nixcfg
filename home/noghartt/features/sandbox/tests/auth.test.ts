import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signToken } from "@exedev/sdk";
import {
  addKeyInstruction,
  authPaths,
  configured,
  generateCommand,
  parseToken,
  setupKey,
  storeToken,
  TOKEN_COMMANDS,
  token,
  tokenPermissions,
} from "../src/providers/exe-auth.ts";

test("sbx's token may run only the VM commands it uses", () => {
  assert.deepEqual([...TOKEN_COMMANDS], ["new", "ls", "cp", "rm", "ssh", "tag", "comment", "pause", "resume"]);
  const now = Date.UTC(2025, 0, 1);
  assert.equal(tokenPermissions(now).exp, now / 1000 + 3600);
});

test("auth setup prints a tag-scoped generate-api-key command", () => {
  assert.equal(
    generateCommand("My-Mac.local"),
    "ssh exe.dev ssh-key generate-api-key --label=sbx-my-mac --tag=sbx --exp=90d --cmds=new,ls,cp,rm,ssh,tag,comment,pause,resume --json",
  );
  assert.equal(addKeyInstruction("/k"), "ssh exe.dev ssh-key add --tag=sbx < /k.pub");
});

test("tokens are read from generate-api-key JSON or as bare tokens", () => {
  assert.equal(parseToken('{"label":"sbx","token":"exe1.abc","namespace":"v0@exe.dev"}\n'), "exe1.abc");
  assert.equal(parseToken("  exe0.eyJ4Ijox.c2ln-_  \n"), "exe0.eyJ4Ijox.c2ln-_");
  assert.throws(() => parseToken("nope"), /no exe.dev token/);
});

test("EXE_TOKEN, then the stored token, then the fallback key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sbx-auth-"));
  const env = { XDG_CONFIG_HOME: dir };
  const paths = authPaths(env);
  assert.equal(paths.token, join(dir, "sbx", "exe_token"));
  assert.equal(configured(env, paths), false);
  await assert.rejects(token(signToken, env, paths), /sbx auth setup/);

  await setupKey(paths.key);
  assert.equal(statSync(paths.key).mode & 0o777, 0o600);
  assert.equal(configured(env, paths), true);
  const signed = await token(signToken, env, paths);
  const [scheme, payload] = signed.split(".");
  assert.equal(scheme, "exe0");
  const perms = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(perms.cmds, [...TOKEN_COMMANDS]);
  assert.ok(perms.exp > Date.now() / 1000 && perms.exp <= Date.now() / 1000 + 3600);

  await storeToken(paths.token, "exe1.stored");
  assert.equal(statSync(paths.token).mode & 0o777, 0o600);
  assert.equal(await token(signToken, env, paths), "exe1.stored");
  assert.equal(await token(async () => assert.fail("must not sign"), { ...env, EXE_TOKEN: "exe1.env" }, paths), "exe1.env");

  writeFileSync(paths.token, "\n");
  assert.match(await token(signToken, env, paths), /^exe0\./, "an empty token file falls through to the key");
  assert.equal(readFileSync(paths.token, "utf8"), "\n");
});
