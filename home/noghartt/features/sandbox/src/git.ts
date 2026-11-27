// Seeding a sandbox with a checkout, and pulling its branches back. Sandboxes
// never hold GitHub tokens: with exe.dev's GitHub integration they clone from
// the integration host and push through it; local commits that GitHub lacks
// travel as a git bundle, which also seeds sandboxes without the integration.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quote } from "./shell.ts";

const run = promisify(execFile);

export const DEFAULT_GITHUB_BASE = "https://github.int.exe.xyz";
export const SEED_BUNDLE = ".sbx/seed.bundle";
export const PULL_BUNDLE = ".sbx/pull.bundle";

/** `owner/repo` from a GitHub remote URL, or undefined for other hosts. */
export function parseGithubRemote(url: string): string | undefined {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function isGithubSlug(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

export function integrationUrl(github: string, base = DEFAULT_GITHUB_BASE): string {
  return `${base.replace(/\/+$/, "")}/${github}.git`;
}

/** exe.dev integration name sbx uses for a repository. */
export function githubIntegrationName(github: string): string {
  return `gh-${github.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export interface ResolvedRepo {
  /** Local checkout to bundle from, when the source is a path. */
  local?: string;
  /** `owner/repo` on GitHub, when known. */
  github?: string;
  branch?: string;
  /** Name for metadata: `owner/repo`, else the directory. */
  label: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

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
    return { local: top, github, branch: b, label: github ?? top.split("/").pop()! };
  }
  if (isGithubSlug(source)) return { github: source, branch, label: source };
  throw new Error(`repo ${source} is neither a local checkout nor owner/repo`);
}

/**
 * `git bundle create` arguments. Thin bundles carry only commits origin lacks
 * (the clone from the integration supplies the rest); full bundles carry the
 * branch's whole history, for sandboxes that cannot reach GitHub.
 */
export function bundleArgs(file: string, branch: string, thin: boolean): string[] {
  return ["bundle", "create", file, `refs/heads/${branch}`, ...(thin ? ["--not", "--remotes=origin"] : [])];
}

/** Writes a bundle; false when there is nothing to bundle (git refuses empty bundles). */
export async function createBundle(repo: string, file: string, branch: string, thin: boolean): Promise<boolean> {
  try {
    await run("git", ["-C", repo, ...bundleArgs(file, branch, thin)], { maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (/empty bundle/i.test(stderr)) return false;
    throw new Error(`git bundle failed: ${stderr.trim() || (error as Error).message}`);
  }
}

/** Exits 0 when the sandbox can read the repository through the integration. */
export function probeScript(url: string): string {
  return `GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote --exit-code ${quote(url)} HEAD >/dev/null 2>&1`;
}

export interface SeedPlan {
  /** Checkout directory, relative to home. */
  dir: string;
  branch?: string;
  /** Clone from the integration; else from the bundle. */
  cloneUrl?: string;
  /** Home-relative path of an uploaded bundle. */
  bundle?: string;
  /** Where `origin` points after a bundle-only seed, so pushing works once the integration exists. */
  originUrl?: string;
}

export function seedScript(plan: SeedPlan): string {
  const dir = quote(plan.dir);
  const lines = ["set -e", `cd "$HOME"`, `if [ -e ${dir} ]; then echo "sbx: ~/${plan.dir} already exists" >&2; exit 1; fi`];
  if (plan.cloneUrl) {
    lines.push(`GIT_TERMINAL_PROMPT=0 git clone -q ${quote(plan.cloneUrl)} ${dir}`, `cd ${dir}`);
    if (plan.branch) {
      const b = quote(plan.branch);
      const origin = quote(`origin/${plan.branch}`);
      if (plan.bundle) {
        lines.push(
          `git fetch -q "$HOME"/${quote(plan.bundle)} ${quote(`refs/heads/${plan.branch}:refs/sbx/seed`)}`,
          `git checkout -q -B ${b} refs/sbx/seed`,
          `git update-ref -d refs/sbx/seed`,
          `if git rev-parse -q --verify ${origin} >/dev/null; then git branch -q -u ${origin}; fi`,
        );
      } else {
        lines.push(
          `if git rev-parse -q --verify ${origin} >/dev/null; then git checkout -q ${b}; else git checkout -q -b ${b}; fi`,
        );
      }
    }
  } else {
    if (!plan.bundle || !plan.branch) throw new Error("a bundle seed needs a bundle and a branch");
    lines.push(`git clone -q -b ${quote(plan.branch)} "$HOME"/${quote(plan.bundle)} ${dir}`, `cd ${dir}`);
    lines.push(plan.originUrl ? `git remote set-url origin ${quote(plan.originUrl)}` : "git remote remove origin");
  }
  if (plan.bundle) lines.push(`rm -f "$HOME"/${quote(plan.bundle)}`);
  return lines.join("\n");
}

/** Bundles branches (all when none given) of the sandbox's checkout for `sbx pull`. */
export function pullScript(dir: string, branches: readonly string[]): string {
  const refs = branches.length ? branches.map((b) => quote(`refs/heads/${b}`)).join(" ") : "--branches";
  return [
    "set -e",
    `cd "$HOME"/${quote(dir)}`,
    `mkdir -p "$HOME"/.sbx`,
    `git bundle create -q "$HOME"/${PULL_BUNDLE} ${refs}`,
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
