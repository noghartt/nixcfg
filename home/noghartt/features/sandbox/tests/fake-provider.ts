// The smallest honest provider: sandboxes are local directories, commands run
// in their own process group. It exists to keep tests/contract.ts provider-
// agnostic, and as a template for writing a real provider.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  Capabilities,
  CreateSpec,
  ExecOptions,
  ExecResult,
  ForkSpec,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxStatus,
} from "../src/provider.ts";
import { NotFoundError, UnsupportedError } from "../src/provider.ts";

const CAPABILITIES: Capabilities = {
  fork: true,
  pause: true,
  resize: false,
  egress: ["all"],
  secretIntegrations: false,
  httpsUrl: false,
  interactiveShell: false,
  templates: false,
};

export async function fakeProvider(): Promise<SandboxProvider & { cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "fake-provider-"));
  const boxes = new Map<string, LocalSandbox>();
  let counter = 0;

  class LocalSandbox implements Sandbox {
    readonly provider = "fake";
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    status: SandboxStatus = "running";
    readonly dir: string;
    readonly env: Record<string, string>;
    keep = false;
    created = new Date();
    lastUsed?: Date;

    constructor(name: string, kind: string, dir: string, env: Record<string, string>) {
      this.id = `${name}-${++counter}`;
      this.name = name;
      this.kind = kind;
      this.dir = dir;
      this.env = env;
    }
    get info(): SandboxInfo {
      return { created: this.created, lastUsed: this.lastUsed, keep: this.keep };
    }
    #path(p: string) {
      if (this.status !== "running") throw new Error(`${this.name} is not running`);
      return isAbsolute(p) ? p : join(this.dir, p);
    }
    exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
      const cwd = this.#path(o.cwd ?? ".");
      return new Promise((resolve, reject) => {
        if (o.signal?.aborted) return reject(o.signal.reason);
        const child = spawn("sh", ["-c", command], {
          cwd,
          env: { ...process.env, ...this.env, ...o.env, HOME: this.dir },
          stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          detached: true,
        });
        if (o.stdin !== undefined) child.stdin!.end(o.stdin);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const kill = () => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        };
        const timer = o.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              kill();
            }, o.timeoutMs)
          : undefined;
        const onAbort = () => {
          kill();
          reject(o.signal!.reason);
        };
        o.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (c: string) => {
          if (o.capture !== false) stdout += c;
          try {
            o.onStdout?.(c);
          } catch (error) {
            kill();
            reject(error);
          }
        });
        child.stderr.setEncoding("utf8").on("data", (c: string) => {
          if (o.capture !== false) stderr += c;
          try {
            o.onStderr?.(c);
          } catch (error) {
            kill();
            reject(error);
          }
        });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
          resolve({ exitCode: timedOut ? 124 : (code ?? 137), stdout, stderr });
        });
      });
    }
    async readFile(p: string) {
      return new Uint8Array(await readFile(this.#path(p)));
    }
    async writeFile(p: string, data: string | Uint8Array, o: { mode?: number } = {}) {
      const full = this.#path(p);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data, { mode: o.mode });
    }
    async upload(local: string, remote: string) {
      await cp(local, this.#path(remote), { recursive: true });
    }
    async download(remote: string, local: string) {
      await cp(this.#path(remote), local, { recursive: true });
    }
    async pause() {
      this.status = "paused";
    }
    async resume() {
      this.status = "running";
    }
    url(): string {
      throw new UnsupportedError("fake", "httpsUrl");
    }
    async setKeep(keep: boolean) {
      this.keep = keep;
    }
    async touch() {
      this.lastUsed = new Date();
    }
  }

  const find = async (name: string) => [...boxes.values()].find((b) => b.name === name || b.id === name);

  return {
    id: "fake",
    capabilities: () => CAPABILITIES,
    async create(spec: CreateSpec) {
      const name = spec.name ?? `box-${counter + 1}`;
      if (await find(name)) throw new Error(`a sandbox named ${name} already exists`);
      const dir = join(root, `${name}-${counter + 1}`);
      await mkdir(dir);
      const box = new LocalSandbox(name, spec.kind.name, dir, { ...spec.kind.env });
      if (spec.kind.setup) {
        const r = await box.exec(spec.kind.setup);
        if (r.exitCode !== 0) throw new Error(`setup failed: ${r.stderr}`);
      }
      boxes.set(box.id, box);
      return box;
    },
    get: find,
    async list() {
      return [...boxes.values()];
    },
    async fork(source: string | Sandbox, spec: ForkSpec = {}) {
      const src = await find(typeof source === "string" ? source : source.id);
      if (!src) throw new NotFoundError(String(source));
      const name = spec.name ?? `${src.name}-fork`;
      const dir = join(root, `${name}-${counter + 1}`);
      await cp(src.dir, dir, { recursive: true });
      const box = new LocalSandbox(name, src.kind, dir, { ...src.env });
      boxes.set(box.id, box);
      return box;
    },
    async remove(source: string | Sandbox) {
      const box = await find(typeof source === "string" ? source : source.id);
      if (!box) return false;
      boxes.delete(box.id);
      await rm(box.dir, { recursive: true, force: true });
      return true;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
