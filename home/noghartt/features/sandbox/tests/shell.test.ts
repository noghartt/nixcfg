import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTIVITY_SCRIPT, cancelScript, commandLine, envFile, exportLine, quote, wrapCommand } from "../src/shell.ts";

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

test("the wrapper reads buffered stdin and removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
  run(`cd "$HOME" && mkdir -p .sbx/in && printf 'in put' > .sbx/in/x`, home);
  const r = run(wrapCommand("cat", { id: "s", stdinFile: ".sbx/in/x" }), home);
  assert.equal(r.stdout, "in put");
  assert.throws(() => readFileSync(join(home, ".sbx/in/x")));
  assert.equal(run(wrapCommand("wc -c | tr -d ' '", { id: "e" }), home).stdout.trim(), "0");
});

test("a dying connection takes the command with it", async () => {
  const home = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
  const child = spawn("sh", ["-c", `exec ${wrapCommand("sleep 2; touch late", { id: "h" })}`], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGHUP");
  const [code] = await once(child, "exit");
  assert.equal(code, 129);
  await new Promise((r) => setTimeout(r, 2500));
  assert.throws(() => readFileSync(join(home, "late")), "the command was stopped");
});

test("the activity probe counts other live runs, not itself", () => {
  const home = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
  run(`cd "$HOME" && mkdir -p .sbx/run && echo $$ > .sbx/run/live && echo 999999 > .sbx/run/dead`, home);
  const r = run(wrapCommand(ACTIVITY_SCRIPT, { id: "probe" }), home);
  assert.match(r.stdout, /^runs=0 users=\d+$/m, "the probing shell is gone, the dead pid does not count");
  const sleeper = spawn("sleep", ["5"]);
  run(`echo ${sleeper.pid} > "$HOME"/.sbx/run/busy`, home);
  assert.match(run(wrapCommand(ACTIVITY_SCRIPT, { id: "probe2" }), home).stdout, /^runs=1 /m);
  sleeper.kill();
});

test("env names are validated wherever env is written", () => {
  assert.throws(() => envFile({ "A B": "1" }), /bad environment variable name/);
  assert.equal(exportLine("A", "x y"), "export A='x y'");
});
