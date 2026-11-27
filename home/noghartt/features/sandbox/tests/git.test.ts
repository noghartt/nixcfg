import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  bundleArgs,
  fetchBundle,
  githubIntegrationName,
  integrationUrl,
  PULL_BUNDLE,
  parseGithubRemote,
  pullFetchArgs,
  pullScript,
  seedScript,
} from "../src/git.ts";
import type { KindSpec } from "../src/provider.ts";
import { exeProvider } from "../src/providers/exe.ts";
import { fakeExe } from "./fake-exe-client.ts";

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
  assert.equal(githubIntegrationName("Owner/My.Repo"), "gh-owner-my-repo");
});

test("bundles are thin only when the sandbox clones from GitHub", () => {
  assert.deepEqual(bundleArgs("f", "main", true), ["bundle", "create", "f", "refs/heads/main", "--not", "--remotes=origin"]);
  assert.deepEqual(bundleArgs("f", "main", false), ["bundle", "create", "f", "refs/heads/main"]);
});

test("seed scripts clone through the integration and keep origin there", () => {
  const s = seedScript({ dir: "repo", branch: "main", cloneUrl: "https://github.int.exe.xyz/o/repo.git", bundle: ".sbx/seed.bundle" });
  assert.match(s, /git clone -q https:\/\/github\.int\.exe\.xyz\/o\/repo\.git repo/);
  assert.match(s, /git fetch -q "\$HOME"\/\.sbx\/seed\.bundle refs\/heads\/main:refs\/sbx\/seed/);
  assert.doesNotMatch(s, /remote (set-url|remove)/);
  const b = seedScript({ dir: "repo", branch: "main", bundle: ".sbx/seed.bundle", originUrl: "https://github.int.exe.xyz/o/repo.git" });
  assert.match(b, /git clone -q -b main "\$HOME"\/\.sbx\/seed\.bundle repo/);
  assert.match(b, /git remote set-url origin https:\/\/github\.int\.exe\.xyz\/o\/repo\.git/);
  assert.match(seedScript({ dir: "repo", branch: "main", bundle: "x" }), /git remote remove origin/);
  assert.throws(() => seedScript({ dir: "repo" }));
});

test("pull maps sandbox branches under sbx/<name>/", () => {
  assert.deepEqual(pullFetchArgs("b", "box", []), ["fetch", "--no-write-fetch-head", "b", "+refs/heads/*:refs/heads/sbx/box/*"]);
  assert.deepEqual(pullFetchArgs("b", "box", ["main"]), ["fetch", "--no-write-fetch-head", "b", "+refs/heads/main:refs/heads/sbx/box/main"]);
  assert.match(pullScript("repo", []), /git bundle create -q "\$HOME"\/\.sbx\/pull\.bundle --branches/);
});

describe("seeding sandboxes from a local checkout", () => {
  const kind: KindSpec = { name: "agent", provider: "exe", egress: "integrations", integrations: [], tags: [], env: {} };
  let base: string;
  let work: string;
  let c1: string;
  let c2: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

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
    git(work, "push", "-q", bare, "main");
    git(work, "remote", "add", "origin", "https://github.com/owner/repo.git");
    git(work, "update-ref", "refs/remotes/origin/main", c1);
    git(work, "commit", "-q", "--allow-empty", "-m", "local only");
    c2 = git(work, "rev-parse", "HEAD");
  });
  after(() => rm(base, { recursive: true, force: true }));

  test("with the GitHub integration: clone from it, local commits on top", async () => {
    const client = await fakeExe();
    const provider = exeProvider({ client: async () => client, githubBase: `file://${base}/gh` });
    const box = await provider.create({ kind, name: "with-int", repo: { source: work } });
    assert.equal(box.info.repo, "owner/repo");
    assert.equal(box.info.branch, "main");
    assert.equal(box.info.workdir, "repo");
    const r = await box.exec("git rev-parse HEAD; git remote get-url origin; git rev-parse --abbrev-ref '@{u}'", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), [c2, `file://${base}/gh/owner/repo.git`, "origin/main"]);
    assert.equal((await box.exec("test -e .sbx/seed.bundle")).exitCode, 1, "the bundle is cleaned up");
    await client.cleanup();
  });

  test("without it: the bundle seeds the whole branch", async () => {
    const client = await fakeExe();
    const provider = exeProvider({ client: async () => client, githubBase: `file://${base}/missing` });
    const box = await provider.create({ kind, name: "no-int", repo: { source: work } });
    const r = await box.exec("git rev-parse HEAD HEAD~1; git remote get-url origin", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), [c2, c1, `file://${base}/missing/owner/repo.git`]);
    await client.cleanup();
  });

  test("a GitHub slug needs the integration, and a failed seed leaves no VM", async () => {
    const client = await fakeExe();
    const provider = exeProvider({ client: async () => client, githubBase: `file://${base}/missing` });
    await assert.rejects(provider.create({ kind, name: "slug", repo: { source: "owner/repo" } }), /sbx github add owner\/repo/);
    assert.equal(client.vms.size, 0);
    const ok = exeProvider({ client: async () => client, githubBase: `file://${base}/gh` });
    const box = await ok.create({ kind, name: "slug", repo: { source: "owner/repo", branch: "feature" } });
    const r = await box.exec("git rev-parse --abbrev-ref HEAD; git rev-parse HEAD", { cwd: "repo" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["feature", c1]);
    await client.cleanup();
  });

  test("pull brings sandbox branches home as sbx/<name>/<branch>", async () => {
    const client = await fakeExe();
    const provider = exeProvider({ client: async () => client, githubBase: `file://${base}/gh` });
    const box = await provider.create({ kind, name: "puller", repo: { source: work } });
    await box.exec("git checkout -q -b feature && git commit -q --allow-empty -m remote-work", { cwd: "repo" });
    const head = (await box.exec("git rev-parse HEAD", { cwd: "repo" })).stdout.trim();
    assert.equal((await box.exec(pullScript("repo", ["feature"]))).exitCode, 0);
    const bundle = join(base, "pull.bundle");
    execFileSync("sh", ["-c", 'cat > "$0"', bundle], { input: await box.readFile(PULL_BUNDLE) });
    await fetchBundle(work, bundle, box.name, ["feature"]);
    assert.equal(git(work, "rev-parse", "refs/heads/sbx/puller/feature"), head);
    await client.cleanup();
  });
});
