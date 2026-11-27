import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createSandbox, pullBranches } from "../src/core.ts";
import { bundleArgs, githubIntegrationName, parseGithubRemote, pullFetchArgs, pullScript, seedScript } from "../src/git.ts";
import type { KindSpec } from "../src/provider.ts";
import { exeProvider, integrationUrl } from "../src/providers/exe.ts";
import { fakeExe } from "./fake-exe-client.ts";
import { fakeProvider } from "../src/testing.ts";

test("GitHub remotes are recognised in every URL form", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "https://token@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ])
    assert.equal(parseGithubRemote(url), "owner/repo", url);
  assert.equal(parseGithubRemote("https://gitlab.com/owner/repo.git"), undefined);
  assert.equal(integrationUrl("owner/repo"), "https://github.int.exe.xyz/owner/repo.git");
});

test("integration names do not collide", () => {
  assert.match(githubIntegrationName("Owner/My.Repo"), /^gh-owner-my-repo-[0-9a-f]{6}$/);
  assert.notEqual(githubIntegrationName("a-b/c"), githubIntegrationName("a/b-c"));
  assert.equal(githubIntegrationName("Owner/Repo"), githubIntegrationName("owner/repo"));
});

test("bundles are thin only when the sandbox clones from GitHub", () => {
  assert.deepEqual(bundleArgs("f", "refs/heads/main", true), ["bundle", "create", "-q", "f", "refs/heads/main", "--not", "--remotes=origin"]);
  assert.deepEqual(bundleArgs("f", "refs/heads/main", false), ["bundle", "create", "-q", "f", "refs/heads/main"]);
});

test("seed scripts check out the exact commit and keep origin on the integration", () => {
  const s = seedScript({
    dir: "repo",
    branch: "main",
    commit: "abc",
    cloneUrl: "https://github.int.exe.xyz/o/repo.git",
    bundle: ".sbx/seed.bundle",
    bundleRef: "refs/heads/main",
  });
  assert.match(s, /git clone -q https:\/\/github\.int\.exe\.xyz\/o\/repo\.git repo/);
  assert.match(s, /git fetch -q "\$HOME"\/\.sbx\/seed\.bundle refs\/heads\/main:refs\/sbx\/seed/);
  assert.match(s, /git checkout -q -B main abc/);
  assert.match(s, /!= abc/);
  const b = seedScript({ dir: "repo", branch: "main", commit: "abc", bundle: "x", bundleRef: "refs/remotes/origin/main", originUrl: "https://g/o.git" });
  assert.match(b, /git init -q repo/);
  assert.match(b, /git remote add origin https:\/\/g\/o\.git/);
  assert.throws(() => seedScript({ dir: "repo" }));
});

test("pull maps sandbox branches under sbx/<name>/ and can be incremental", () => {
  assert.deepEqual(pullFetchArgs("b", "box", []), ["fetch", "--no-write-fetch-head", "b", "+refs/heads/*:refs/heads/sbx/box/*"]);
  assert.deepEqual(pullFetchArgs("b", "box", ["main"]), ["fetch", "--no-write-fetch-head", "b", "+refs/heads/main:refs/heads/sbx/box/main"]);
  assert.match(pullScript("repo", []), /--branches 2>&1/);
  assert.match(pullScript("repo", ["main"], "abc"), /refs\/heads\/main \$\(git cat-file -e 'abc\^\{commit\}' 2>\/dev\/null && echo --not abc\)/);
});

describe("seeding sandboxes from a local checkout", () => {
  const kind: KindSpec = { name: "agent", provider: "exe", egress: "integrations", integrations: [], tags: [], env: {} };
  let base: string;
  let work: string;
  let c1: string;
  let c2: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const exe = async (gh: string) => {
    const client = await fakeExe();
    return { client, provider: exeProvider({ client: async () => client, githubBase: `file://${base}/${gh}` }) };
  };

  before(async () => {
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "sbx",
      GIT_AUTHOR_EMAIL: "sbx@example.invalid",
      GIT_COMMITTER_NAME: "sbx",
      GIT_COMMITTER_EMAIL: "sbx@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    base = await mkdtemp(join(tmpdir(), "sbx-git-"));
    const bare = join(base, "gh", "owner", "repo.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    work = join(base, "work", "repo");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    git(work, "commit", "-q", "--allow-empty", "-m", "pushed");
    c1 = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "main", "main:remote-only");
    git(work, "remote", "add", "origin", "https://github.com/owner/repo.git");
    git(work, "update-ref", "refs/remotes/origin/main", c1);
    git(work, "update-ref", "refs/remotes/origin/remote-only", c1);
    git(work, "commit", "-q", "--allow-empty", "-m", "local only");
    c2 = git(work, "rev-parse", "HEAD");
  });
  after(() => rm(base, { recursive: true, force: true }));

  test("with the GitHub integration: clone from it, local commits on top", async () => {
    const { client, provider } = await exe("gh");
    const box = await createSandbox(provider, { kind, name: "with-int", repo: { source: work } });
    assert.deepEqual([box.info.repo, box.info.branch, box.info.commit, box.info.workdir], ["owner/repo", "main", c2, "repo"]);
    const r = await box.exec("git rev-parse HEAD; git remote get-url origin; git rev-parse --abbrev-ref '@{u}'", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), [c2, `file://${base}/gh/owner/repo.git`, "origin/main"]);
    assert.equal((await box.exec("test -e .sbx/seed.bundle")).exitCode, 1, "the bundle is cleaned up");
    await client.cleanup();
  });

  test("without it: the bundle seeds the whole branch", async () => {
    const { client, provider } = await exe("missing");
    const box = await createSandbox(provider, { kind, name: "no-int", repo: { source: work } });
    const r = await box.exec("git rev-parse HEAD HEAD~1; git remote get-url origin", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), [c2, c1, `file://${base}/missing/owner/repo.git`]);
    await client.cleanup();
  });

  test("providers without a git remote seed from bundles", async () => {
    const provider = await fakeProvider();
    const box = await createSandbox(provider, { kind: { ...kind, provider: "fake", egress: "all" }, name: "plain", repo: { source: work } });
    assert.equal((await box.exec("git rev-parse HEAD; git remote", { cwd: "repo" })).stdout.trim(), c2);
    // The fake keeps the checkout metadata, so consumers' tests can pull from it as from a real provider.
    assert.deepEqual([box.info.workdir, box.info.commit], ["repo", c2]);
    await box.exec("git checkout -q -b fake-work && git commit -q --allow-empty -m on-fake", { cwd: "repo" });
    assert.equal((await pullBranches(box, work, ["fake-work"])).fetched, true);
    assert.equal(git(work, "rev-parse", "refs/heads/sbx/plain/fake-work~1"), c2);
    await provider.cleanup();
  });

  test("a branch only origin has is checked out at origin's commit", async () => {
    const { client, provider } = await exe("missing");
    const box = await createSandbox(provider, { kind, name: "origin-only", repo: { source: work, branch: "remote-only" } });
    assert.equal(box.info.commit, c1);
    const r = await box.exec("git rev-parse --abbrev-ref HEAD; git rev-parse HEAD", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["remote-only", c1]);
    await assert.rejects(createSandbox(provider, { kind, name: "nope", repo: { source: work, branch: "nope" } }), /no branch nope/);
    await client.cleanup();
  });

  test("a stale origin ref falls back to a full bundle", async () => {
    const { client, provider } = await exe("gh");
    // This machine believes origin has a commit GitHub never got (or lost).
    git(work, "checkout", "-q", "-b", "ghost", c1);
    git(work, "commit", "-q", "--allow-empty", "-m", "ghost");
    git(work, "update-ref", "refs/remotes/origin/ghost", "HEAD");
    git(work, "commit", "-q", "--allow-empty", "-m", "on ghost");
    const tip = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "main");
    const progress: string[] = [];
    const box = await createSandbox(provider, { kind, name: "ghost", repo: { source: work, branch: "ghost" } }, { onProgress: (m) => progress.push(m) });
    assert.ok(progress.some((m) => /retrying with the full branch/.test(m)), progress.join("\n"));
    assert.equal((await box.exec("git rev-parse HEAD", { cwd: "repo" })).stdout.trim(), tip);
    await client.cleanup();
  });

  test("uncommitted changes are reported, not silently dropped", async () => {
    const { client, provider } = await exe("missing");
    execFileSync("sh", ["-c", `echo dirty > "${work}/file"`]);
    const progress: string[] = [];
    await createSandbox(provider, { kind, name: "dirty", repo: { source: work } }, { onProgress: (m) => progress.push(m) });
    assert.ok(progress.some((m) => /uncommitted changes/.test(m)));
    await rm(join(work, "file"));
    await client.cleanup();
  });

  test("a GitHub slug needs the integration, and a failed seed leaves no VM", async () => {
    const missing = await exe("missing");
    await assert.rejects(createSandbox(missing.provider, { kind, name: "slug", repo: { source: "owner/repo" } }), /sbx github add owner\/repo/);
    assert.equal(missing.client.vms.size, 0);
    const { client, provider } = await exe("gh");
    const box = await createSandbox(provider, { kind, name: "slug", repo: { source: "owner/repo", branch: "feature" } });
    const r = await box.exec("git rev-parse --abbrev-ref HEAD; git rev-parse HEAD", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["feature", c1]);
    await missing.client.cleanup();
    await client.cleanup();
  });

  test("pull brings sandbox branches home, incrementally from the seed commit", async () => {
    const { client, provider } = await exe("gh");
    const box = await createSandbox(provider, { kind, name: "puller", repo: { source: work } });
    assert.deepEqual(await pullBranches(box, work, ["main"]), { fetched: false, output: "" }, "nothing new yet");
    await box.exec("git checkout -q -b feature && git commit -q --allow-empty -m remote-work", { cwd: "repo" });
    const head = (await box.exec("git rev-parse HEAD", { cwd: "repo" })).stdout.trim();
    const pulled = await pullBranches(box, work, ["feature"]);
    assert.equal(pulled.fetched, true);
    assert.equal(git(work, "rev-parse", "refs/heads/sbx/puller/feature"), head);
    // The bundle was based on the seed commit: it carries just the new one.
    assert.match((await box.exec(`git rev-list --count ${c2}..feature`, { cwd: "repo" })).stdout, /^1/);
    await client.cleanup();
  });
});
