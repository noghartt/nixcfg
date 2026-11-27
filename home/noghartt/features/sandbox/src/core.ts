// Provider-independent operations built on the Sandbox interface: creating a
// sandbox with a checkout, and bringing its branches back. Sandboxes never
// hold GitHub credentials: a provider may offer a credential-free git remote
// (`gitRemote`), and local commits travel as git bundles either way.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBundle,
  fetchBundle,
  hasCommit,
  PULL_BUNDLE,
  PULL_EMPTY,
  probeScript,
  type ResolvedRepo,
  resolveRepo,
  SEED_BUNDLE,
  seedScript,
  pullScript,
} from "./git.ts";
import { workdir } from "./names.ts";
import type { KindSpec, OperationOptions, RepoSpec, Sandbox, SandboxProvider } from "./provider.ts";
import { quote } from "./shell.ts";

export interface CreateOptions {
  kind: KindSpec;
  name?: string;
  repo?: RepoSpec;
}

/** Creates a sandbox and seeds its checkout; a failed seed removes the sandbox. */
export async function createSandbox(provider: SandboxProvider, spec: CreateOptions, o: OperationOptions = {}): Promise<Sandbox> {
  const repo = spec.repo ? await resolveRepo(spec.repo.source, spec.repo.branch) : undefined;
  const box = await provider.create(
    {
      kind: spec.kind,
      name: spec.name,
      checkout: repo ? { repo: repo.label, branch: repo.branch, commit: repo.commit } : undefined,
    },
    o,
  );
  if (!repo) return box;
  try {
    await seedCheckout(box, repo, { ...o, gitRemote: provider.gitRemote?.bind(provider) });
    return box;
  } catch (error) {
    await provider.remove(box).catch((e) => o.onProgress?.((e as Error).message));
    throw error;
  }
}

async function check(box: Sandbox, script: string, what: string, signal?: AbortSignal) {
  const r = await box.exec(script, { signal });
  if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
  return r;
}

export async function seedCheckout(
  box: Sandbox,
  repo: ResolvedRepo,
  o: OperationOptions & { gitRemote?: (github: string) => string | undefined } = {},
): Promise<void> {
  const progress = o.onProgress ?? (() => {});
  const dir = workdir(repo.label);
  const url = repo.github ? o.gitRemote?.(repo.github) : undefined;
  const viaRemote = url ? (await box.exec(probeScript(url), { signal: o.signal })).exitCode === 0 : false;
  if (!viaRemote && !repo.local)
    throw new Error(`the sandbox cannot read ${repo.github}; give it access with \`sbx github add ${repo.github}\``);
  if (repo.dirty) progress(`warning: uncommitted changes in ${repo.local} stay behind; only commits are seeded`);
  progress(viaRemote ? `cloning ${repo.github} through its git remote` : `seeding ${repo.label} from a bundle`);

  const attempt = async (thin: boolean) => {
    let bundle: string | undefined;
    if (repo.local && repo.ref) {
      const tmp = await mkdtemp(join(tmpdir(), "sbx-"));
      try {
        const file = join(tmp, "seed.bundle");
        if (await createBundle(repo.local, file, repo.ref, thin)) {
          await box.writeFile(SEED_BUNDLE, await readFile(file), { signal: o.signal });
          bundle = SEED_BUNDLE;
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    const script = seedScript({
      dir,
      branch: repo.branch,
      commit: repo.commit,
      cloneUrl: viaRemote ? url : undefined,
      bundle,
      bundleRef: repo.ref,
      originUrl: url,
    });
    return box.exec(script, { signal: o.signal });
  };

  let r = await attempt(viaRemote);
  if (r.exitCode !== 0 && viaRemote && repo.local) {
    // A thin bundle needs commits origin had when this machine last fetched; if
    // GitHub lost them (a force-push), ship the branch's whole history instead.
    progress(`seeding with a thin bundle failed (${r.stderr.trim()}); retrying with the full branch`);
    await box.exec(`rm -rf "$HOME"/${quote(dir)}`, { signal: o.signal });
    r = await attempt(false);
  }
  if (r.exitCode !== 0) throw new Error(`seeding the checkout failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

/** Bundles the sandbox's branches into a local file; false when there is nothing new. */
async function bundleBranches(box: Sandbox, file: string, branches: readonly string[], base?: string, signal?: AbortSignal) {
  if (!box.info.workdir) throw new Error(`${box.name} has no checkout`);
  const r = await check(box, pullScript(box.info.workdir, branches, base), `bundling on ${box.name}`, signal);
  if (r.stdout.includes(PULL_EMPTY)) return false;
  try {
    await writeFile(file, await box.readFile(PULL_BUNDLE, { signal }));
  } finally {
    await box.exec(`rm -f "$HOME"/${PULL_BUNDLE}`).catch(() => undefined);
  }
  return true;
}

/**
 * Fetches the sandbox's branches into `localRepo` as sbx/<name>/<branch>. Only
 * commits after the seed commit travel when this repository has that commit.
 */
export async function pullBranches(box: Sandbox, localRepo: string, branches: readonly string[] = [], o: OperationOptions = {}) {
  const base = box.info.commit && (await hasCommit(localRepo, box.info.commit)) ? box.info.commit : undefined;
  const tmp = await mkdtemp(join(tmpdir(), "sbx-"));
  try {
    const file = join(tmp, "pull.bundle");
    if (!(await bundleBranches(box, file, branches, base, o.signal))) return { fetched: false, output: "" };
    return { fetched: true, output: await fetchBundle(localRepo, file, box.name, branches) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Saves all of the sandbox's branches as a self-contained bundle in `dir`; false without a checkout. */
export async function archiveBranches(box: Sandbox, dir: string, signal?: AbortSignal): Promise<boolean> {
  if (!box.info.workdir) return false;
  await mkdir(dir, { recursive: true });
  const saved = await bundleBranches(box, join(dir, "branches.bundle"), [], undefined, signal);
  await writeFile(
    join(dir, "sandbox.json"),
    JSON.stringify({ name: box.name, id: box.id, provider: box.provider, kind: box.kind, ...box.info }, null, 2),
  );
  return saved;
}
