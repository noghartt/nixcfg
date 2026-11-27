// The only local state: when this machine last used each sandbox. Everything
// else lives on the provider so machines agree; the provider also keeps a
// day-granular stamp, so reaping on one machine respects use on another.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateHome } from "./config.ts";

export interface UsageStore {
  get(id: string): Date | undefined;
  touch(id: string, when?: Date): void;
  forget(id: string): void;
}

export function memoryUsage(): UsageStore {
  const map = new Map<string, Date>();
  return {
    get: (id) => map.get(id),
    touch: (id, when = new Date()) => void map.set(id, when),
    forget: (id) => void map.delete(id),
  };
}

export function fileUsage(path = join(stateHome(), "sbx", "last-used.json")): UsageStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  };
  return {
    get(id) {
      const v = read()[id];
      return v ? new Date(v) : undefined;
    },
    touch(id, when = new Date()) {
      write({ ...read(), [id]: when.toISOString() });
    },
    forget(id) {
      const data = read();
      delete data[id];
      write(data);
    },
  };
}

export function day(when: Date): string {
  return when.toISOString().slice(0, 10);
}
