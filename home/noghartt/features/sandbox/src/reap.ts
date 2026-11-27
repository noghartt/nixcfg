// Idle sandboxes hold disk and VM slots on a fixed plan, so the hourly reaper
// removes the ones nobody used for a while: never one with a command still
// running or someone logged in, and never before its branches are archived
// locally. It also sweeps VMs that failed operations left half-made.
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "./config.ts";
import { archiveBranches } from "./core.ts";
import type { Sandbox } from "./provider.ts";
import type { Sbx } from "./registry.ts";
import { ACTIVITY_SCRIPT } from "./shell.ts";

const DAY = 86_400_000;

export function archiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateHome(env), "sbx", "archive");
}

/** When it was last used, falling back to creation; undefined when unknown. */
export function lastActivity(sandbox: Sandbox): Date | undefined {
  return sandbox.info.lastUsed ?? sandbox.info.created;
}

export function reapable(sandboxes: readonly Sandbox[], days: number, now = new Date()): Sandbox[] {
  return sandboxes.filter((s) => {
    if (s.info.keep) return false;
    const last = lastActivity(s);
    return last !== undefined && now.getTime() - last.getTime() > days * DAY;
  });
}

/** Why the sandbox is in use right now, or undefined when it is idle. */
export async function busy(sandbox: Sandbox): Promise<string | undefined> {
  if (sandbox.status !== "running") return undefined;
  const r = await sandbox.exec(ACTIVITY_SCRIPT, { timeoutMs: 30_000 }).catch((e: Error) => ({ exitCode: -1, stdout: "", stderr: e.message }));
  const m = r.stdout.match(/runs=(\d+) users=(\d+)/);
  if (r.exitCode !== 0 || !m) return `could not check activity (${r.stderr.trim() || `exit ${r.exitCode}`})`;
  if (Number(m[1]) > 0) return `${m[1]} command(s) running`;
  if (Number(m[2]) > 0) return `${m[2]} login session(s)`;
  return undefined;
}

export interface ReapOptions {
  days: number;
  now?: Date;
  dryRun?: boolean;
  /** Where branches are archived before removal. */
  archiveDir?: string;
  /** Archives older than this many days are deleted. */
  keepArchivesDays?: number;
  /** Half-made VMs older than this are removed. */
  sweepAfterMs?: number;
  onProgress?: (message: string) => void;
}

export interface ReapResult {
  removed: string[];
  archived: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
  swept: string[];
  pruned: string[];
}

export async function reap(sbx: Sbx, o: ReapOptions): Promise<ReapResult> {
  const now = o.now ?? new Date();
  const archiveDir = o.archiveDir ?? archiveRoot();
  const result: ReapResult = { removed: [], archived: [], skipped: [], failed: [], swept: [], pruned: [] };

  if (!o.dryRun)
    for (const id of sbx.providerIds()) {
      const provider = sbx.provider(id);
      if (!provider.sweep) continue;
      try {
        result.swept.push(...(await provider.sweep({ olderThanMs: o.sweepAfterMs ?? 3_600_000 })));
      } catch (error) {
        result.failed.push({ name: `${id} sweep`, error: (error as Error).message });
      }
    }

  for (const sandbox of reapable(await sbx.list(), o.days, now)) {
    try {
      const reason = await busy(sandbox);
      if (reason) {
        result.skipped.push({ name: sandbox.name, reason });
        continue;
      }
      if (o.dryRun) {
        result.removed.push(sandbox.name);
        continue;
      }
      if (sandbox.info.workdir) {
        if (sandbox.status === "paused") await sandbox.resume();
        const dir = join(archiveDir, sandbox.name, now.toISOString().replace(/[:.]/g, "-"));
        o.onProgress?.(`archiving ${sandbox.name}'s branches to ${dir}`);
        if (await archiveBranches(sandbox, dir)) result.archived.push(sandbox.name);
      }
      await sbx.providerOf(sandbox).remove(sandbox);
      result.removed.push(sandbox.name);
    } catch (error) {
      result.failed.push({ name: sandbox.name, error: (error as Error).message });
    }
  }

  if (!o.dryRun) result.pruned = await pruneArchives(archiveDir, (o.keepArchivesDays ?? 30) * DAY, now);
  return result;
}

/** Deletes archives older than `maxAgeMs`; returns the removed `<name>/<stamp>` entries. */
export async function pruneArchives(root: string, maxAgeMs: number, now = new Date()): Promise<string[]> {
  const pruned: string[] = [];
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const dir = join(root, name);
    for (const stamp of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, stamp);
      if (now.getTime() - (await stat(path)).mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true });
        pruned.push(`${name}/${stamp}`);
      }
    }
    await rmdir(dir).catch(() => undefined);
  }
  return pruned;
}
