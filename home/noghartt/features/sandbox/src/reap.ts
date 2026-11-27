// Idle sandboxes hold disk and VM slots on a fixed plan, so the hourly reaper
// removes the ones nobody used for a while. Templates are not sandboxes
// (`list` leaves them out) and `keep` exempts the rest.
import type { Sandbox } from "./provider.ts";
import type { Sbx } from "./registry.ts";

const DAY = 86_400_000;

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

export interface ReapResult {
  removed: string[];
  failed: { name: string; error: string }[];
}

export async function reap(sbx: Sbx, options: { days: number; now?: Date; dryRun?: boolean }): Promise<ReapResult> {
  const result: ReapResult = { removed: [], failed: [] };
  for (const sandbox of reapable(await sbx.list(), options.days, options.now)) {
    if (options.dryRun) {
      result.removed.push(sandbox.name);
      continue;
    }
    try {
      await sbx.providerOf(sandbox).remove(sandbox);
      result.removed.push(sandbox.name);
    } catch (error) {
      result.failed.push({ name: sandbox.name, error: (error as Error).message });
    }
  }
  return result;
}
