// The provider contract: every SandboxProvider must pass this suite. Run it
// with a factory that returns a fresh provider and a kind it can create
// (see contract-*.test.ts, and live.test.ts for the real exe.dev).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { KindSpec, Sandbox, SandboxProvider } from "../src/provider.ts";

export interface ContractSetup {
  provider: SandboxProvider;
  /** A kind the provider can create; its env must include SBX_CONTRACT=kind. */
  kind: KindSpec;
  cleanup?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function providerContract(label: string, setup: () => Promise<ContractSetup>, options: { timeoutMs?: number } = {}) {
  describe(`provider contract: ${label}`, { timeout: options.timeoutMs ?? 120_000 }, () => {
    let provider: SandboxProvider;
    let kind: KindSpec;
    let cleanup: (() => Promise<void>) | undefined;
    let box: Sandbox;
    // Names carry this run's id, so cleanup never touches another run's sandboxes.
    const run = `c${randomBytes(3).toString("hex")}`;
    const name = `${run}-main`;

    before(async () => {
      ({ provider, kind, cleanup } = await setup());
      box = await provider.create({ kind, name });
    });
    after(async () => {
      for (const s of await provider.list()) if (s.name.startsWith(run)) await provider.remove(s);
      await cleanup?.();
    });

    it("declares its capabilities", () => {
      const caps = provider.capabilities();
      for (const key of ["fork", "pause", "resize", "secretIntegrations", "httpsUrl", "interactiveShell", "templates"] as const)
        assert.equal(typeof caps[key], "boolean", key);
      assert.ok(caps.egress.includes(kind.egress));
      assert.equal(!!provider.templates, caps.templates);
      assert.equal(!!provider.integrations, caps.secretIntegrations);
    });

    it("creates a findable sandbox", async () => {
      assert.equal(box.name, name);
      assert.equal(box.kind, kind.name);
      assert.equal(box.provider, provider.id);
      assert.equal(box.status, "running");
      assert.equal((await provider.get(name))?.id, box.id);
      assert.equal((await provider.get(box.id))?.name, name);
      assert.ok((await provider.list()).some((s) => s.id === box.id));
      assert.equal(await provider.get(`${run}-missing`), undefined);
    });

    it("refuses a duplicate name", async () => {
      await assert.rejects(provider.create({ kind, name }), /already exists/);
    });

    it("runs commands with exit codes, output, env and cwd", async () => {
      const r = await box.exec("echo out; echo err >&2; exit 3");
      assert.deepEqual([r.exitCode, r.stdout, r.stderr], [3, "out\n", "err\n"]);
      const env = await box.exec('printf "%s %s" "$SBX_CONTRACT" "$EXTRA"', { env: { EXTRA: "a b'c" } });
      assert.equal(env.stdout, "kind a b'c");
      await box.exec("mkdir -p sub/dir");
      const cwd = await box.exec("pwd", { cwd: "sub/dir" });
      assert.match(cwd.stdout.trim(), /\/sub\/dir$/);
    });

    it("streams output, and can skip capturing it", async () => {
      const chunks: string[] = [];
      const r = await box.exec("for i in 1 2 3; do echo $i; done; echo e >&2", {
        capture: false,
        onStdout: (c) => void chunks.push(c),
        onStderr: (c) => void chunks.push(`!${c}`),
      });
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, "");
      assert.equal(chunks.filter((c) => !c.startsWith("!")).join(""), "1\n2\n3\n");
      assert.ok(chunks.includes("!e\n"));
    });

    it("takes buffered stdin, and gives an empty one otherwise", async () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 10]);
      const r = await box.exec("od -An -tu1 | tr -s ' ' ' '", { stdin: bytes });
      assert.equal(r.stdout.trim(), "0 1 2 255 10");
      assert.equal((await box.exec("wc -c | tr -d ' '", { stdin: "abc" })).stdout.trim(), "3");
      assert.equal((await box.exec("wc -c | tr -d ' '")).stdout.trim(), "0");
    });

    it("records use only when touched", async () => {
      const before = (await provider.get(name))!.info.lastUsed;
      await sleep(20);
      await box.exec("true");
      assert.deepEqual((await provider.get(name))!.info.lastUsed, before, "exec is not use");
      await box.touch();
      const after = (await provider.get(name))!.info.lastUsed;
      assert.ok(after && (!before || after >= before));
    });

    it("times commands out on the sandbox", async () => {
      const r = await box.exec("sleep 30", { timeoutMs: 1000 });
      assert.equal(r.exitCode, 124);
    });

    it("cancels the remote command, not only the wait", async () => {
      await box.exec("rm -f cancelled-marker");
      const controller = new AbortController();
      const started = Date.now();
      const running = box.exec("sleep 3; echo late > cancelled-marker", { signal: controller.signal });
      await sleep(500);
      controller.abort(new Error("stop"));
      await assert.rejects(running, /stop/);
      assert.ok(Date.now() - started < 3000, "abort returns before the command would finish");
      await sleep(3500);
      const r = await box.exec("test -e cancelled-marker");
      assert.equal(r.exitCode, 1, "the command was stopped on the sandbox");
    });

    it("stops the remote command when a callback fails", async () => {
      await box.exec("rm -f callback-marker");
      const running = box.exec("echo start; sleep 3; echo late > callback-marker", {
        onStdout: () => {
          throw new Error("callback broke");
        },
      });
      await assert.rejects(running, /callback broke/);
      await sleep(3500);
      assert.equal((await box.exec("test -e callback-marker")).exitCode, 1);
    });

    it("round-trips binary files", async () => {
      const bytes = new Uint8Array(256).map((_, i) => i);
      await box.writeFile("files/deep/all.bin", bytes);
      assert.deepEqual(await box.readFile("files/deep/all.bin"), bytes);
      await box.writeFile("files/text.txt", "héllo\n");
      assert.equal((await box.exec("cat files/text.txt")).stdout, "héllo\n");
      await assert.rejects(box.readFile("files/missing"));
    });

    it("uploads and downloads directories", async () => {
      const local = await mkdtemp(join(tmpdir(), "contract-"));
      try {
        await mkdir(join(local, "up", "nested"), { recursive: true });
        await writeFile(join(local, "up", "nested", "a.txt"), "A");
        await box.upload(join(local, "up"), "uploaded");
        assert.equal((await box.exec("cat uploaded/nested/a.txt")).stdout, "A");
        await box.download("uploaded", join(local, "down"));
        assert.equal(await readFile(join(local, "down", "nested", "a.txt"), "utf8"), "A");
      } finally {
        await rm(local, { recursive: true, force: true });
      }
    });

    it("marks sandboxes to keep", async () => {
      await box.setKeep(true);
      assert.equal((await provider.get(name))?.info.keep, true);
      await box.setKeep(false);
      assert.equal((await provider.get(name))?.info.keep, false);
    });

    it("forks when it can", async (t) => {
      if (!provider.capabilities().fork) return t.skip("no fork");
      await box.writeFile("fork-me", "1");
      const copy = await provider.fork(box, { name: `${run}-fork`, kind });
      assert.equal(copy.kind, box.kind);
      assert.notEqual(copy.id, box.id);
      assert.equal(new TextDecoder().decode(await copy.readFile("fork-me")), "1");
      await copy.writeFile("fork-me", "2");
      assert.equal(new TextDecoder().decode(await box.readFile("fork-me")), "1");
      assert.equal(await provider.remove(copy), true);
    });

    it("pauses and resumes when it can", async (t) => {
      if (!provider.capabilities().pause) return t.skip("no pause");
      await box.pause();
      assert.equal((await provider.get(name))?.status, "paused");
      await box.resume();
      assert.equal((await provider.get(name))?.status, "running");
      assert.equal((await box.exec("true")).exitCode, 0);
    });

    it("gives URLs when it can", async (t) => {
      if (!provider.capabilities().httpsUrl) return t.skip("no httpsUrl");
      assert.match(box.url(), /^https:\/\//);
      assert.match(box.url(3000), /^https:\/\/[^/]+:3000$/);
      assert.throws(() => box.url(22));
    });

    it("removes sandboxes", async () => {
      const gone = await provider.create({ kind, name: `${run}-rm` });
      assert.equal(await provider.remove(gone.name), true);
      assert.equal(await provider.get(gone.name), undefined);
      assert.equal(await provider.remove(gone.name), false);
    });
  });
}
