import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMeta, encodeMeta, kindTag, sandboxTags, sanitize, tagValue, templateTags, templateVmName, vmName, workdir } from "../src/names.ts";

test("sanitize keeps DNS-label-safe names", () => {
  assert.equal(sanitize("My Feature_Branch!"), "my-feature-branch");
  assert.equal(sanitize("--42abc--"), "abc");
  assert.equal(sanitize("___"), "sbx");
  assert.equal(sanitize("a".repeat(80)).length, 40);
  assert.equal(sanitize(`${"a".repeat(39)}-b`), "a".repeat(39));
});

test("vm names carry a 6-hex suffix inside a DNS label", () => {
  const name = vmName("Fix Login");
  assert.match(name, /^fix-login-[0-9a-f]{6}$/);
  assert.ok(vmName("x".repeat(100)).length <= 63);
  assert.match(templateVmName("Agent"), /^sbx-tpl-agent-[0-9a-f]{6}$/);
});

test("tags identify sbx, the name and the kind", () => {
  const tags = sandboxTags("Fix Login", "dev", ["Team GPU", "sbx"]);
  assert.deepEqual(tags, ["sbx", "sbx-name-fix-login", "sbx-kind-dev", "team-gpu"]);
  for (const t of tags) assert.match(t, /^[a-z][a-z0-9-]*$/);
  assert.equal(tagValue(tags, "name"), "fix-login");
  assert.equal(tagValue(tags, "kind"), "dev");
  assert.deepEqual(templateTags("job"), ["sbx", "sbx-tpl", kindTag("job")]);
});

test("metadata fits exe.dev's 200-byte comment", () => {
  const meta = { r: "owner/repo", b: "main", u: "2025-01-02" };
  assert.deepEqual(decodeMeta(encodeMeta(meta)), meta);
  const long = encodeMeta({ r: "o/" + "r".repeat(150), b: "b".repeat(150), u: "2025-01-02" });
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.equal(decodeMeta(long).u, "2025-01-02");
  assert.deepEqual(decodeMeta("not json"), {});
  assert.deepEqual(decodeMeta(undefined), {});
});

test("workdir is the repository's directory name", () => {
  assert.equal(workdir("noghartt/nixcfg"), "nixcfg");
  assert.equal(workdir("/home/me/My Repo/"), "My-Repo");
  assert.equal(workdir("owner/thing.git"), "thing");
  assert.equal(workdir(".."), "repo");
});
