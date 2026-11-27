// exe.dev provider: sandboxes are VMs in the account's shared pool (never
// standalone/metered VMs). All metadata is on exe.dev (tags and the comment),
// so every machine sees the same sandboxes; see docs/sandbox.md.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderConfig, stateHome } from "../config.ts";
import {
  createBundle,
  DEFAULT_GITHUB_BASE,
  githubIntegrationName,
  integrationUrl,
  probeScript,
  type ResolvedRepo,
  resolveRepo,
  SEED_BUNDLE,
  seedScript,
} from "../git.ts";
import {
  decodeMeta,
  encodeMeta,
  KEEP_TAG,
  kindTag,
  type Meta,
  nameTag,
  randomName,
  sandboxTags,
  sanitize,
  suffix,
  TAG,
  TEMPLATE_TAG,
  tagValue,
  templateTags,
  templateVmName,
  vmName,
  workdir,
} from "../names.ts";
import {
  type Capabilities,
  type CreateSpec,
  type ExecOptions,
  type ExecResult,
  type ForkSpec,
  type KindSpec,
  NotFoundError,
  type OperationOptions,
  type Sandbox,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxStatus,
  type TemplateInfo,
} from "../provider.ts";
import type { ProviderContext } from "../registry.ts";
import { cancelScript, ENV_FILE, envFile, wrapCommand } from "../shell.ts";
import { day, fileUsage, memoryUsage, type UsageStore } from "../state.ts";
import { keyPath, token } from "./exe-auth.ts";
import { type ExeClient, type ExeVM, sdkClient } from "./exe-client.ts";

export interface ExeProviderOptions {
  id?: string;
  /** Created on first use, so commands that never reach exe.dev need no key. */
  client: () => Promise<ExeClient>;
  usage?: UsageStore;
  /** Where the GitHub integration serves repositories; tests point it at local repos. */
  githubBase?: string;
  now?: () => Date;
}

const CAPABILITIES: Capabilities = {
  fork: true,
  pause: true,
  resize: true,
  egress: ["all", "integrations"],
  secretIntegrations: true,
  httpsUrl: true,
  interactiveShell: true,
  templates: true,
};

function status(s: string | undefined): SandboxStatus {
  switch (s) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "starting":
    case "creating":
      return "starting";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

/** Template identity: a copy is only as good as the setup that built it. */
export function fingerprint(kind: KindSpec): string {
  return createHash("sha256")
    .update(JSON.stringify([kind.setup ?? "", kind.image ?? "", kind.env]))
    .digest("hex")
    .slice(0, 12);
}

function size(gb: number | undefined): string | undefined {
  return gb ? `${gb}GB` : undefined;
}

export function exeUrl(vm: ExeVM, port?: number): string {
  const url = new URL(vm.httpsUrl || `https://${vm.name}.exe.xyz`);
  if (port !== undefined) {
    // exe.dev proxies only these to the VM, behind its login.
    if (!Number.isInteger(port) || port < 3000 || port > 9999) throw new Error(`port ${port}: exe.dev proxies ports 3000-9999 only`);
    url.port = String(port);
  }
  return url.toString().replace(/\/$/, "");
}

export function exeProvider(options: ExeProviderOptions): SandboxProvider {
  const id = options.id ?? "exe";
  const usage = options.usage ?? memoryUsage();
  const now = options.now ?? (() => new Date());
  const githubBase = options.githubBase ?? DEFAULT_GITHUB_BASE;
  let clientPromise: Promise<ExeClient> | undefined;
  const client = () => (clientPromise ??= options.client());

  class ExeSandbox implements Sandbox {
    readonly provider = id;
    #vm: ExeVM;
    #meta: Meta;

    constructor(vm: ExeVM) {
      this.#vm = vm;
      this.#meta = decodeMeta(vm.comment);
    }
    get id() {
      return this.#vm.name;
    }
    get name() {
      return tagValue(this.#vm.tags, "name") ?? this.#vm.name;
    }
    get kind() {
      return tagValue(this.#vm.tags, "kind") ?? "unknown";
    }
    get status() {
      return status(this.#vm.status);
    }
    get sshDest() {
      return this.#vm.sshDest ?? `${this.#vm.name}.exe.xyz`;
    }
    get info(): SandboxInfo {
      const local = usage.get(this.#vm.name);
      const remote = this.#meta.u ? new Date(`${this.#meta.u}T00:00:00Z`) : undefined;
      const lastUsed = local && remote ? (local > remote ? local : remote) : (local ?? remote);
      return {
        created: this.#vm.createdAt ? new Date(this.#vm.createdAt) : undefined,
        lastUsed,
        repo: this.#meta.r,
        branch: this.#meta.b,
        workdir: this.#meta.r ? workdir(this.#meta.r) : undefined,
        url: exeUrl(this.#vm),
        keep: this.#vm.tags.includes(KEEP_TAG),
        egress: this.#vm.egress,
      };
    }

    /** Records use locally, and on exe.dev at most once a day. */
    async touch(): Promise<void> {
      const when = now();
      usage.touch(this.#vm.name, when);
      if (this.#meta.u === day(when)) return;
      const meta = { ...this.#meta, u: day(when) };
      try {
        await (await client()).comment(this.#vm.name, encodeMeta(meta));
        this.#meta = meta;
      } catch {
        // Best effort: a missed stamp only makes the reaper's view older.
      }
    }

    async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
      o.signal?.throwIfAborted();
      await this.touch();
      const c = await client();
      const run = randomBytes(8).toString("hex");
      const script = wrapCommand(command, { id: run, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs });
      const local = new AbortController();
      let cancelled: Promise<unknown> | undefined;
      const onAbort = () => {
        local.abort(o.signal?.reason);
        cancelled = c.ssh(this.#vm.name, cancelScript(run)).catch(() => undefined);
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await c.ssh(this.#vm.name, script, {
          signal: local.signal,
          onStdout: o.onStdout,
          onStderr: o.onStderr,
          capture: o.capture,
        });
      } catch (error) {
        if (o.signal?.aborted) {
          await cancelled;
          throw o.signal.reason;
        }
        throw error;
      } finally {
        o.signal?.removeEventListener("abort", onAbort);
      }
    }
    async readFile(path: string, o: { signal?: AbortSignal } = {}) {
      await this.touch();
      return (await client()).readFile(this.#vm.name, path, o.signal);
    }
    async writeFile(path: string, data: string | Uint8Array, o: { mode?: number; signal?: AbortSignal } = {}) {
      await this.touch();
      return (await client()).writeFile(this.#vm.name, path, data, o);
    }
    async upload(localPath: string, remotePath: string, o: { exclude?: readonly string[]; signal?: AbortSignal } = {}) {
      await this.touch();
      return (await client()).upload(this.#vm.name, localPath, remotePath, o);
    }
    async download(remotePath: string, localPath: string, o: { signal?: AbortSignal } = {}) {
      await this.touch();
      return (await client()).download(this.#vm.name, remotePath, localPath, o.signal);
    }
    async pause() {
      await (await client()).pause(this.#vm.name);
      this.#vm = { ...this.#vm, status: "paused" };
    }
    async resume() {
      await (await client()).resume(this.#vm.name);
      this.#vm = { ...this.#vm, status: "running" };
      await this.touch();
    }
    url(port?: number) {
      return exeUrl(this.#vm, port);
    }
    async setKeep(keep: boolean) {
      await (await client()).tag(this.#vm.name, [KEEP_TAG], !keep);
      const tags = this.#vm.tags.filter((t) => t !== KEEP_TAG);
      this.#vm = { ...this.#vm, tags: keep ? [...tags, KEEP_TAG] : tags };
    }
  }

  const all = async () => (await (await client()).list()).filter((vm) => vm.tags.includes(TAG));
  const sandboxes = async () => (await all()).filter((vm) => !vm.tags.includes(TEMPLATE_TAG)).map((vm) => new ExeSandbox(vm));
  const templateVMs = async () => (await all()).filter((vm) => vm.tags.includes(TEMPLATE_TAG));

  async function find(name: string): Promise<ExeSandbox | undefined> {
    const list = await sandboxes();
    return list.find((s) => s.id === name) ?? list.find((s) => s.name === sanitize(name));
  }
  async function resolve(source: string | Sandbox): Promise<ExeSandbox> {
    const name = typeof source === "string" ? source : source.id;
    const found = await find(name);
    if (!found) throw new NotFoundError(name);
    return found;
  }

  /** Copies a VM and makes the copy ours: tags, metadata, integrations. */
  async function adopt(c: ExeClient, vm: ExeVM, tags: string[], meta: Meta, integrations: readonly string[]): Promise<ExeVM> {
    await c.tag(vm.name, tags);
    const comment = encodeMeta(meta);
    await c.comment(vm.name, comment);
    // Integrations attached with `new --integration` are per VM; a copy starts without them.
    for (const integration of integrations) await c.attachIntegration(integration, `vm:${vm.name}`);
    return { ...vm, tags, comment };
  }

  async function seed(sandbox: ExeSandbox, repo: ResolvedRepo, progress: (m: string) => void, signal?: AbortSignal) {
    const c = await client();
    const url = repo.github ? integrationUrl(repo.github, githubBase) : undefined;
    const viaIntegration = url ? (await c.ssh(sandbox.id, probeScript(url), { signal })).exitCode === 0 : false;
    if (!viaIntegration && !repo.local)
      throw new Error(`the sandbox cannot read ${repo.github} through exe.dev's GitHub integration; run \`sbx github add ${repo.github}\``);
    progress(viaIntegration ? `cloning ${repo.github} through the GitHub integration` : `seeding ${repo.label} from a bundle`);
    let bundle: string | undefined;
    if (repo.local && repo.branch) {
      const dir = await mkdtemp(join(tmpdir(), "sbx-"));
      try {
        const file = join(dir, "seed.bundle");
        if (await createBundle(repo.local, file, repo.branch, viaIntegration)) {
          await c.writeFile(sandbox.id, SEED_BUNDLE, await readFile(file), { signal });
          bundle = SEED_BUNDLE;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const script = seedScript({
      dir: workdir(repo.label),
      branch: repo.branch,
      cloneUrl: viaIntegration ? url : undefined,
      bundle,
      originUrl: url,
    });
    const result = await c.ssh(sandbox.id, script, { signal });
    if (result.exitCode !== 0) throw new Error(`seeding the checkout failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  async function currentTemplate(kind: KindSpec): Promise<{ vm?: ExeVM; stale: boolean }> {
    const tpl = (await templateVMs()).filter((vm) => vm.tags.includes(kindTag(kind.name)));
    const vm = tpl.find((t) => decodeMeta(t.comment).h === fingerprint(kind));
    return { vm, stale: !vm && tpl.length > 0 };
  }

  const provider: SandboxProvider = {
    id,
    capabilities: () => CAPABILITIES,

    async create(spec: CreateSpec, o: OperationOptions = {}) {
      const progress = o.onProgress ?? (() => {});
      const kind = spec.kind;
      const name = sanitize(spec.name ?? randomName());
      if (await find(name)) throw new Error(`a sandbox named ${name} already exists`);
      const repo = spec.repo ? await resolveRepo(spec.repo.source, spec.repo.branch) : undefined;
      const c = await client();
      const tags = sandboxTags(name, kind.name, kind.tags);
      const meta: Meta = { r: repo?.label, b: repo?.branch, u: day(now()) };
      const target = vmName(name);
      let vm: ExeVM | undefined;
      try {
        const { vm: template, stale } = await currentTemplate(kind);
        if (stale) progress(`template for ${kind.name} is stale; run \`sbx template build ${kind.name}\``);
        if (template) {
          progress(`copying template ${template.name} to ${target}`);
          try {
            vm = await c.copy(template.name, {
              name: target,
              cpu: kind.cpu,
              memory: size(kind.memory),
              disk: size(kind.disk),
              egress: kind.egress,
              signal: o.signal,
            });
          } catch (error) {
            progress(`copying the template failed (${(error as Error).message}); creating from scratch`);
            await c.remove(target).catch(() => false);
          }
          if (vm) vm = await adopt(c, vm, tags, meta, kind.integrations);
        }
        if (!vm) {
          progress(`creating ${target}${kind.setup ? " and running its setup script" : ""}`);
          vm = await c.create({
            name: target,
            tags,
            comment: encodeMeta(meta),
            cpu: kind.cpu,
            memory: size(kind.memory),
            disk: size(kind.disk),
            egress: kind.egress,
            env: Object.entries(kind.env).map(([k, v]) => `${k}=${v}`),
            image: kind.image,
            integrations: kind.integrations,
            setupScript: kind.setup,
            signal: o.signal,
          });
        }
        const sandbox = new ExeSandbox(vm);
        // Commands read the kind's env from here, so copies of templates get it too.
        if (Object.keys(kind.env).length) await c.writeFile(vm.name, ENV_FILE, envFile(kind.env), { signal: o.signal });
        if (repo) await seed(sandbox, repo, progress, o.signal);
        usage.touch(vm.name, now());
        return sandbox;
      } catch (error) {
        // A half-made sandbox would only leak capacity.
        await c.remove(vm?.name ?? target).catch(() => false);
        throw error;
      }
    },

    get: find,
    list: sandboxes,

    async fork(source: string | Sandbox, spec: ForkSpec = {}, o: OperationOptions = {}) {
      const src = await resolve(source);
      const name = sanitize(spec.name ?? `${src.name}-${suffix().slice(0, 4)}`);
      if (await find(name)) throw new Error(`a sandbox named ${name} already exists`);
      const c = await client();
      const target = vmName(name);
      o.onProgress?.(`copying ${src.id} to ${target}`);
      const srcVM = (await c.list()).find((vm) => vm.name === src.id)!;
      try {
        const copy = await c.copy(src.id, { name: target, signal: o.signal });
        const tags = [
          ...sandboxTags(name, src.kind),
          ...srcVM.tags.filter((t) => t !== KEEP_TAG && t !== nameTag(src.name) && !t.startsWith("sbx")),
        ];
        const meta = { ...decodeMeta(srcVM.comment), u: day(now()) };
        const vm = await adopt(c, copy, [...new Set(tags)], meta, spec.kind?.integrations ?? []);
        usage.touch(vm.name, now());
        return new ExeSandbox(vm);
      } catch (error) {
        await c.remove(target).catch(() => false);
        throw error;
      }
    },

    async remove(source: string | Sandbox) {
      const found = await find(typeof source === "string" ? source : source.id);
      if (!found) return false;
      const removed = await (await client()).remove(found.id);
      usage.forget(found.id);
      return removed;
    },

    templates: {
      async build(kind: KindSpec, o: OperationOptions = {}): Promise<TemplateInfo> {
        const c = await client();
        const old = (await templateVMs()).filter((vm) => vm.tags.includes(kindTag(kind.name)));
        const name = templateVmName(kind.name);
        o.onProgress?.(`creating ${name}${kind.setup ? " and running the setup script" : ""}`);
        let vm: ExeVM | undefined;
        try {
          // Templates run only the trusted setup script, so they get the internet even for
          // restricted kinds; each copy gets the kind's egress when it is made.
          vm = await c.create({
            name,
            tags: templateTags(kind.name),
            comment: encodeMeta({ h: fingerprint(kind) }),
            cpu: kind.cpu,
            memory: size(kind.memory),
            disk: size(kind.disk),
            egress: "all",
            env: Object.entries(kind.env).map(([k, v]) => `${k}=${v}`),
            image: kind.image,
            setupScript: kind.setup,
            signal: o.signal,
          });
          o.onProgress?.(`pausing ${name}`);
          await c.pause(name);
        } catch (error) {
          await c.remove(name).catch(() => false);
          throw error;
        }
        for (const t of old) await c.remove(t.name);
        return { kind: kind.name, id: vm.name, created: vm.createdAt ? new Date(vm.createdAt) : undefined, current: true };
      },
      async list(kinds: readonly KindSpec[] = []): Promise<TemplateInfo[]> {
        return (await templateVMs()).map((vm) => {
          const kind = tagValue(vm.tags, "kind") ?? "unknown";
          const spec = kinds.find((k) => sanitize(k.name) === kind);
          return {
            kind,
            id: vm.name,
            created: vm.createdAt ? new Date(vm.createdAt) : undefined,
            current: spec ? decodeMeta(vm.comment).h === fingerprint(spec) : true,
          };
        });
      },
      async remove(kind: string) {
        const c = await client();
        const tpl = (await templateVMs()).filter((vm) => vm.tags.includes(kindTag(kind)));
        for (const t of tpl) await c.remove(t.name);
        return tpl.length > 0;
      },
    },

    integrations: {
      async addGithub(repo: string, o: { readonly?: boolean } = {}) {
        const name = githubIntegrationName(repo);
        await (await client()).addGithubIntegration({ name, repository: repo, readonly: !!o.readonly, attach: `tag:${TAG}` });
        return name;
      },
    },
  };
  return provider;
}

/** Registry factory: config `{ type: "exe", key?, baseURL?, githubBase? }`. */
export function exeFactory(config: ProviderConfig, context: ProviderContext): SandboxProvider {
  const key = typeof config.key === "string" ? config.key : undefined;
  return exeProvider({
    id: context.id,
    usage: fileUsage(join(stateHome(context.env), "sbx", "last-used.json")),
    githubBase: typeof config.githubBase === "string" ? config.githubBase : undefined,
    client: async () => {
      const { signToken } = await import("@exedev/sdk");
      return sdkClient({
        token: () => token(signToken, context.env, keyPath(context.env, key)),
        baseURL: typeof config.baseURL === "string" ? config.baseURL : undefined,
        userAgent: "sbx/0.1",
      });
    },
  });
}
