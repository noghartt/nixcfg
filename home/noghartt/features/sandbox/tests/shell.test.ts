import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cancelScript, commandLine, envFile, quote, wrapCommand } from "../src/shell.ts";

const run = (script: string, home: string) => spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });

test("quote makes one shell word", () => {
  for (const s of ["plain", "", "a b", "it's", "$(rm -rf /)", "line\nbreak", "*"]) {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${quote(s)}`], { encoding: "utf8" }), s);
  }
});

test("commandLine takes one argument as a script and quotes several", () => {
  assert.equal(commandLine(["echo a | wc -c"]), "echo a | wc -c");
  assert.equal(commandLine(["echo", "a b", "$x"]), "echo 'a b' '$x'");
});

test("the wrapper runs in home with the env file, env and cwd, and keeps the exit code", () => {
  const home = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
  run(`cd "$HOME" && mkdir -p .sbx d && printf '%s' ${quote(envFile({ FROM_FILE: "f'1" }))} > .sbx/env`, home);
  const r = run(wrapCommand('printf "%s %s %s" "$FROM_FILE" "$X" "$(basename "$PWD")"; exit 7', { id: "abc", cwd: "d", env: { X: "x y" } }), home);
  assert.equal(r.stdout, "f'1 x y d");
  assert.equal(r.status, 7);
  assert.throws(() => readFileSync(join(home, ".sbx/run/abc")), "the pid file is cleaned up");
});

test("the wrapper enforces timeouts with timeout(1)", () => {
  const home = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
  assert.equal(run(wrapCommand("sleep 10", { id: "t", timeoutMs: 1000 }), home).status, 124);
});

test("run ids are validated", () => {
  assert.throws(() => wrapCommand("true", { id: "../x" }));
  assert.throws(() => cancelScript("a b"));
  assert.throws(() => wrapCommand("true", { id: "a", env: { "A-B": "1" } }));
});
