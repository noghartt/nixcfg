// A stand-in for exe.dev: each VM is a temporary directory used as $HOME, and
// `ssh` runs the command with the local sh. Like the SDK, aborting `ssh`
// rejects the call but leaves the command running, so the provider's own
// cancellation is what stops it.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExeClient, ExeVM } from "../src/providers/exe-client.ts";

interface FakeVM extends ExeVM {
  dir: string;
  env: Record<string, string>;
  integrations: string[];
}

export interface FakeExe extends ExeClient {
  vms: Map<string, FakeVM>;
  calls: string[];
  githubIntegrations: { name: string; repository: string; readonly: boolean; attach: string }[];
  failCopy: boolean;
  cleanup(): Promise<void>;
}

function sh(command: string, vm: FakeVM, options: { signal?: AbortSignal; onStdout?: (c: string) => unknown; onStderr?: (c: string) => unknown; capture?: boolean } = {}) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason);
    const child = spawn("sh", ["-c", command], { cwd: vm.dir, env: { ...process.env, ...vm.env, HOME: vm.dir }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      if (options.capture !== false) stdout += c;
      options.onStdout?.(c);
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      if (options.capture !== false) stderr += c;
      options.onStderr?.(c);
    });
    const onAbort = () => reject(options.signal!.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code ?? 128 + (signal === "SIGKILL" ? 9 : 15), stdout, stderr });
    });
  });
}

export async function fakeExe(): Promise<FakeExe> {
  const root = await mkdtemp(join(tmpdir(), "fake-exe-"));
  const vms = new Map<string, FakeVM>();
  const calls: string[] = [];
  const githubIntegrations: FakeExe["githubIntegrations"] = [];
  const vm = (name: string) => {
    const found = vms.get(name);
    if (!found) throw Object.assign(new Error(`VM ${name} not found`), { status: 404 });
    return found;
  };
  const running = (name: string) => {
    const v = vm(name);
    if (v.status !== "running") throw new Error(`VM "${name}" is not running`);
    return v;
  };
  const path = (v: FakeVM, p: string) => (isAbsolute(p) ? p : join(v.dir, p));
  const record = (v: FakeVM): ExeVM => ({
    name: v.name,
    tags: [...v.tags],
    sshDest: v.sshDest,
    httpsUrl: v.httpsUrl,
    status: v.status,
    comment: v.comment,
    createdAt: v.createdAt,
    egress: v.egress,
  });
  const client: FakeExe = {
    vms,
    calls,
    githubIntegrations,
    failCopy: false,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    async list() {
      calls.push("ls");
      return [...vms.values()].map(record);
    },
    async create(o) {
      calls.push(`new ${o.name} egress=${o.egress}`);
      if (vms.has(o.name)) throw new Error(`VM name ${o.name} is taken`);
      const dir = join(root, o.name);
      await mkdir(dir);
      const v: FakeVM = {
        name: o.name,
        tags: [...o.tags],
        sshDest: `${o.name}.exe.xyz`,
        httpsUrl: `https://${o.name}.exe.xyz`,
        status: "running",
        comment: o.comment,
        createdAt: new Date().toISOString(),
        egress: o.egress,
        dir,
        env: Object.fromEntries((o.env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])),
        integrations: [...(o.integrations ?? [])],
      };
      vms.set(o.name, v);
      if (o.setupScript) {
        const r = await sh(o.setupScript, v);
        if (r.exitCode !== 0) throw new Error(`setup script failed: ${r.stderr}`);
      }
      return record(v);
    },
    async copy(source, o) {
      calls.push(`cp ${source} ${o.name} egress=${o.egress ?? "inherit"}`);
      if (client.failCopy) throw new Error("copy refused");
      const src = vm(source);
      const dir = join(root, o.name);
      await cp(src.dir, dir, { recursive: true });
      const v: FakeVM = {
        ...src,
        name: o.name,
        tags: [],
        sshDest: `${o.name}.exe.xyz`,
        httpsUrl: `https://${o.name}.exe.xyz`,
        status: "running",
        createdAt: new Date().toISOString(),
        egress: o.egress ?? src.egress,
        dir,
        integrations: [],
      };
      vms.set(o.name, v);
      return record(v);
    },
    async remove(name) {
      calls.push(`rm ${name}`);
      const v = vms.get(name);
      if (!v) return false;
      vms.delete(name);
      await rm(v.dir, { recursive: true, force: true });
      return true;
    },
    async tag(name, tags, remove) {
      calls.push(`tag ${remove ? "-d " : ""}${name} ${tags.join(" ")}`);
      const v = vm(name);
      v.tags = remove ? v.tags.filter((t) => !tags.includes(t)) : [...new Set([...v.tags, ...tags])];
    },
    async comment(name, text) {
      calls.push(`comment ${name}`);
      if (Buffer.byteLength(text) > 200) throw new Error("comment too long");
      vm(name).comment = text;
    },
    async pause(name) {
      calls.push(`pause ${name}`);
      vm(name).status = "paused";
    },
    async resume(name) {
      calls.push(`resume ${name}`);
      vm(name).status = "running";
    },
    async ssh(name, command, o) {
      return sh(command, running(name), o);
    },
    async readFile(name, p) {
      return new Uint8Array(await readFile(path(running(name), p)));
    },
    async writeFile(name, p, data, o) {
      const full = path(running(name), p);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data, { mode: o?.mode });
    },
    async upload(name, local, remote) {
      await cp(local, path(running(name), remote), { recursive: true });
    },
    async download(name, remote, local) {
      await cp(path(running(name), remote), local, { recursive: true });
    },
    async attachIntegration(name, spec) {
      calls.push(`integrations attach ${name} ${spec}`);
      if (spec.startsWith("vm:")) vm(spec.slice(3)).integrations.push(name);
    },
    async addGithubIntegration(o) {
      calls.push(`integrations add github ${o.name}`);
      githubIntegrations.push(o);
    },
  };
  return client;
}
