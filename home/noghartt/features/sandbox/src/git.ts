// Git plumbing for seeding sandboxes and pulling their branches back: local
// commands and the scripts run on the sandbox. seed.ts drives them.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quote } from "./shell.ts";

const run = promisify(execFile);

export const SEED_BUNDLE = ".sbx/seed.bundle";
export const PULL_BUNDLE = ".sbx/pull.bundle";
/** Printed by `pullScript` when the sandbox has nothing new. */
export const PULL_EMPTY = "SBX_EMPTY";

/** `owner/repo` from a GitHub remote URL, or undefined for other hosts. */
export function parseGithubRemote(url: string): string | undefined {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function isGithubSlug(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

/**
 * Integration name for a repository: readable, plus a hash of the exact
 * (case-folded, as GitHub's are) slug, since `a-b/c` and `a/b-c` would
 * otherwise collide.
 */
export function githubIntegrationName(github: string): string {
  const slug = github.toLowerCase();
  const readable = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `gh-${readable}-${createHash("sha256").update(slug).digest("hex").slice(0, 6)}`;
}

export interface ResolvedRepo {
  /** Local checkout to bundle from, when the source is a path. */
  local?: string;
  /** `owner/repo` on GitHub, when known. */
  github?: string;
  branch?: string;
  /** The commit to check out, when the source is local. */
  commit?: string;
  /** Local ref holding `commit`: the branch, or origin's when only origin has it. */
  ref?: string;
  /** Uncommitted changes in the source checkout, which seeding does not carry. */
  dirty: boolean;
  /** Name for metadata: `owner/repo`, else the directory. */
  label: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const hasRef = (cwd: string, ref: string) =>
  git(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).then(
    (sha) => sha,
    () => undefined,
  );

export async function resolveRepo(source: string, branch?: string, cwd = process.cwd()): Promise<ResolvedRepo> {
  const path = resolve(cwd, source);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const top = await git(path, ["rev-parse", "--show-toplevel"]).catch(() => {
      throw new Error(`${path} is not a git checkout`);
    });
    const remote = await git(top, ["remote", "get-url", "origin"]).catch(() => "");
    const github = parseGithubRemote(remote);
    const current = await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
    const b = branch ?? (current || undefined);
    if (!b) throw new Error(`${top} has a detached HEAD; pass --branch`);
    let ref = `refs/heads/${b}`;
    let commit = await hasRef(top, ref);
    if (!commit) {
      ref = `refs/remotes/origin/${b}`;
      commit = await hasRef(top, ref);
    }
    if (!commit) throw new Error(`${top} has no branch ${b}, locally or on origin`);
    const dirty = b === current && (await git(top, ["status", "--porcelain"])) !== "";
    return { local: top, github, branch: b, commit, ref, dirty, label: github ?? top.split("/").pop()! };
  }
  if (isGithubSlug(source)) return { github: source, branch, dirty: false, label: source };
  throw new Error(`repo ${source} is neither a local checkout nor owner/repo`);
}

/**
 * `git bundle create` arguments. Thin bundles carry only commits origin lacks
 * (the clone from GitHub supplies the rest); full ones carry all of `ref`'s
 * history, for sandboxes that cannot reach GitHub.
 */
export function bundleArgs(file: string, ref: string, thin: boolean): string[] {
  return ["bundle", "create", "-q", file, ref, ...(thin ? ["--not", "--remotes=origin"] : [])];
}

/** Writes a bundle; false when there is nothing to bundle (git refuses empty bundles). */
export async function createBundle(repo: string, file: string, ref: string, thin: boolean): Promise<boolean> {
  try {
    await run("git", ["-C", repo, ...bundleArgs(file, ref, thin)], { maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (/empty bundle/i.test(stderr)) return false;
    throw new Error(`git bundle failed: ${stderr.trim() || (error as Error).message}`);
  }
}

/** Exits 0 when the sandbox can read the repository at `url`. */
export function probeScript(url: string): string {
  return `GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote --exit-code ${quote(url)} HEAD >/dev/null 2>&1`;
}

export interface SeedPlan {
  /** Checkout directory, relative to home. */
  dir: string;
  branch?: string;
  /** Exact commit to check out; the script fails if it ends anywhere else. */
  commit?: string;
  /** Clone from here (credential-free GitHub access); else start empty and use the bundle. */
  cloneUrl?: string;
  /** Home-relative path of an uploaded bundle, and the ref inside it. */
  bundle?: string;
  bundleRef?: string;
  /** Where `origin` points after a bundle-only seed, so pushing works once the integration exists. */
  originUrl?: string;
}

export function seedScript(plan: SeedPlan): string {
  const dir = quote(plan.dir);
  const lines = ["set -e", `cd "$HOME"`, `if [ -e ${dir} ]; then echo "sbx: ~/${plan.dir} already exists" >&2; exit 1; fi`];
  if (plan.cloneUrl) lines.push(`GIT_TERMINAL_PROMPT=0 git clone -q ${quote(plan.cloneUrl)} ${dir}`, `cd ${dir}`);
  else {
    if (!plan.bundle || !plan.commit || !plan.branch) throw new Error("a bundle-only seed needs a bundle, a commit and a branch");
    lines.push(`git init -q ${dir}`, `cd ${dir}`);
    if (plan.originUrl) lines.push(`git remote add origin ${quote(plan.originUrl)}`);
  }
  if (plan.bundle) {
    if (!plan.bundleRef) throw new Error("a bundle needs its ref");
    lines.push(`git fetch -q "$HOME"/${quote(plan.bundle)} ${quote(`${plan.bundleRef}:refs/sbx/seed`)}`);
  }
  if (plan.branch) {
    const b = quote(plan.branch);
    const origin = quote(`refs/remotes/origin/${plan.branch}`);
    if (plan.commit) lines.push(`git checkout -q -B ${b} ${quote(plan.commit)}`);
    else lines.push(`if git rev-parse -q --verify ${origin} >/dev/null; then git checkout -q ${b}; else git checkout -q -b ${b}; fi`);
    lines.push(`if git rev-parse -q --verify ${origin} >/dev/null; then git branch -q -u origin/${b}; fi`);
  }
  if (plan.bundle) lines.push("git update-ref -d refs/sbx/seed", `rm -f "$HOME"/${quote(plan.bundle)}`);
  if (plan.commit)
    lines.push(`if [ "$(git rev-parse HEAD)" != ${quote(plan.commit)} ]; then echo "sbx: checkout is not at ${plan.commit}" >&2; exit 1; fi`);
  return lines.join("\n");
}

/**
 * Bundles branches (all when none given) of the sandbox's checkout. With a
 * base commit both sides have, only what came after it travels.
 */
export function pullScript(dir: string, branches: readonly string[], base?: string): string {
  const refs = branches.length ? branches.map((b) => quote(`refs/heads/${b}`)).join(" ") : "--branches";
  const not = base ? ` $(git cat-file -e ${quote(`${base}^{commit}`)} 2>/dev/null && echo --not ${quote(base)})` : "";
  return [
    `cd "$HOME"/${quote(dir)} || exit 1`,
    `mkdir -p "$HOME"/.sbx`,
    `if ! out=$(git bundle create -q "$HOME"/${PULL_BUNDLE} ${refs}${not} 2>&1); then`,
    `  case "$out" in *"empty bundle"*) echo ${PULL_EMPTY}; exit 0;; esac`,
    `  echo "$out" >&2; exit 1`,
    `fi`,
  ].join("\n");
}

/** Local `git fetch` arguments mapping the sandbox's branches to sbx/<name>/<branch>. */
export function pullFetchArgs(bundle: string, name: string, branches: readonly string[]): string[] {
  const specs = branches.length
    ? branches.map((b) => `+refs/heads/${b}:refs/heads/sbx/${name}/${b}`)
    : [`+refs/heads/*:refs/heads/sbx/${name}/*`];
  return ["fetch", "--no-write-fetch-head", bundle, ...specs];
}

export async function fetchBundle(repo: string, bundle: string, name: string, branches: readonly string[]): Promise<string> {
  const { stderr } = await run("git", ["-C", repo, ...pullFetchArgs(bundle, name, branches)], { maxBuffer: 64 * 1024 * 1024 });
  return stderr.trim();
}

/** Whether the local repository has `commit`, so a bundle based on it can be fetched. */
export async function hasCommit(repo: string, commit: string): Promise<boolean> {
  return (await hasRef(repo, commit)) !== undefined;
}
