// exe.dev provider: sandboxes are VMs in the account's shared pool (never
// standalone/metered VMs). All metadata is on exe.dev (tags and the comment),
// so every machine sees the same sandboxes; see docs/sandbox.md.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { type ProviderConfig, stateHome } from "../config.ts";
import { githubIntegrationName } from "../git.ts";
import {
  decodeMeta,
  encodeMeta,
  GITHUB_TAG,
  KEEP_TAG,
  kindTag,
  type Meta,
  nameTag,
  PROVISIONING_TAG,
  randomName,
  sandboxTags,
  sanitize,
  suffix,
  TAG,
  TEMPLATE_PREFIX,
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
import { cancelScript, ENV_FILE, envFile, quote, STDIN_DIR, wrapCommand } from "../shell.ts";
import { day, fileUsage, memoryUsage, type UsageStore } from "../state.ts";
import { authPaths, token } from "./exe-auth.ts";
import { type ExeClient, type ExeVM, sdkClient } from "./exe-client.ts";

export const DEFAULT_GITHUB_BASE = "https://github.int.exe.xyz";

export interface ExeProviderOptions {
  id?: string;
  /** Created on first use, so commands that never reach exe.dev need no credentials. */
  client: () => Promise<ExeClient>;
  usage?: UsageStore;
  /** Where the GitHub integration serves repositories; tests point it at local repos. */
  githubBase?: string;
  now?: () => Date;
  /** Pause between checks after a failed `rm`. */
  retryDelayMs?: number;
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

export function integrationUrl(github: string, base = DEFAULT_GITHUB_BASE): string {
  return `${base.replace(/\/+$/, "")}/${github}.git`;
}

const isTemplate = (vm: ExeVM) => vm.tags.includes(TEMPLATE_TAG) && vm.name.startsWith(TEMPLATE_PREFIX);
/** Ours and finished: VMs shared with us carry no egress policy. */
const owned = (vm: ExeVM) => vm.tags.includes(TAG) && vm.egress !== undefined;
const ready = (vm: ExeVM) => owned(vm) && !vm.tags.includes(PROVISIONING_TAG);

export function exeProvider(options: ExeProviderOptions): SandboxProvider {
  const id = options.id ?? "exe";
  const usage = options.usage ?? memoryUsage();
  const now = options.now ?? (() => new Date());
  const githubBase = options.githubBase ?? DEFAULT_GITHUB_BASE;
  const retryDelay = options.retryDelayMs ?? 2000;
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
      // The stamp is a day; read it as that day's end so the reaper never acts early.
      const remote = this.#meta.u ? new Date(`${this.#meta.u}T23:59:59.999Z`) : undefined;
      const lastUsed = local && remote ? (local > remote ? local : remote) : (local ?? remote);
      return {
        created: this.#vm.createdAt ? new Date(this.#vm.createdAt) : undefined,
        lastUsed,
        repo: this.#meta.r,
        branch: this.#meta.b,
        commit: this.#meta.s,
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
        // Best effort: a missed stamp only makes other machines' view older.
      }
    }

    async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
      o.signal?.throwIfAborted();
      const c = await client();
      const run = randomBytes(8).toString("hex");
      const stdinFile = o.stdin !== undefined ? `${STDIN_DIR}/${run}` : undefined;
      if (stdinFile) await c.writeFile(this.#vm.name, stdinFile, o.stdin!, { signal: o.signal });
      const script = wrapCommand(command, { id: run, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, stdinFile });
      const local = new AbortController();
      const onAbort = () => local.abort(o.signal?.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await c.ssh(this.#vm.name, script, {
          signal: local.signal,
          onStdout: o.onStdout,
          onStderr: o.onStderr,
          capture: o.capture,
        });
      } catch (error) {
        // Whatever failed (cancellation, a dropped stream, a throwing callback), the
        // command may still run on the VM: stop it before reporting.
        await c.ssh(this.#vm.name, cancelScript(run, o.signal?.aborted ? 5 : 2)).catch(() => undefined);
        throw o.signal?.aborted ? o.signal.reason : error;
      } finally {
        o.signal?.removeEventListener("abort", onAbort);
      }
    }
    async readFile(path: string, o: { signal?: AbortSignal } = {}) {
      return (await client()).readFile(this.#vm.name, path, o.signal);
    }
    async writeFile(path: string, data: string | Uint8Array, o: { mode?: number; signal?: AbortSignal } = {}) {
      return (await client()).writeFile(this.#vm.name, path, data, o);
    }
    async upload(localPath: string, remotePath: string, o: { exclude?: readonly string[]; signal?: AbortSignal } = {}) {
      return (await client()).upload(this.#vm.name, localPath, remotePath, o);
    }
    async download(remotePath: string, localPath: string, o: { signal?: AbortSignal } = {}) {
      return (await client()).download(this.#vm.name, remotePath, localPath, o.signal);
    }
    async pause() {
      await (await client()).pause(this.#vm.name);
      this.#vm = { ...this.#vm, status: "paused" };
    }
    async resume() {
      await (await client()).resume(this.#vm.name);
      this.#vm = { ...this.#vm, status: "running" };
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

  const all = async () => (await (await client()).list()).filter(owned);
  const sandboxes = async () => (await all()).filter((vm) => ready(vm) && !isTemplate(vm)).map((vm) => new ExeSandbox(vm));
  const templateVMs = async () => (await all()).filter((vm) => ready(vm) && isTemplate(vm));

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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * `rm`, checked: a failed request may still have removed the VM, and one
   * that did not is retried, so failures do not leak VMs silently.
   */
  async function removeVM(c: ExeClient, name: string): Promise<boolean> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await c.remove(name);
      } catch (error) {
        last = error;
        await sleep(retryDelay);
        const still = await c.list().then(
          (vms) => vms.some((vm) => vm.name === name),
          () => true,
        );
        if (!still) return true;
      }
    }
    throw new Error(`could not remove VM ${name} (${(last as Error).message}); remove it with \`ssh exe.dev rm ${name}\``);
  }

  /** Makes a copy ours: its own name and kind tags, no template or keep tags, its metadata. */
  async function adopt(c: ExeClient, vm: ExeVM, tags: string[], meta: Meta): Promise<ExeVM> {
    await c.tag(vm.name, [...tags, PROVISIONING_TAG]);
    const stale = vm.tags.filter((t) => !tags.includes(t) && t !== TAG);
    if (stale.length) await c.tag(vm.name, stale, true);
    const comment = encodeMeta(meta);
    await c.comment(vm.name, comment);
    await c.tag(vm.name, [PROVISIONING_TAG], true);
    return { ...vm, tags, comment };
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
      // A setup script cannot run without the internet, so restricted kinds only start from templates.
      const templateOnly = kind.egress !== "all" && !!kind.setup;
      const { vm: template, stale } = await currentTemplate(kind);
      if (templateOnly && !template)
        throw new Error(
          `kind ${kind.name} has no internet for its setup script; build its template first: sbx template build ${kind.name}`,
        );
      if (stale) progress(`template for ${kind.name} is stale; run \`sbx template build ${kind.name}\``);
      const c = await client();
      const tags = sandboxTags(name, kind.name, kind.tags);
      const meta: Meta = { r: spec.checkout?.repo, b: spec.checkout?.branch, s: spec.checkout?.commit, u: day(now()) };
      const target = vmName(name);
      let vm: ExeVM | undefined;
      try {
        if (template) {
          progress(`copying template ${template.name} to ${target}`);
          try {
            const copy = await c.copy(template.name, {
              name: target,
              cpu: kind.cpu,
              memory: size(kind.memory),
              disk: size(kind.disk),
              egress: kind.egress,
              signal: o.signal,
            });
            vm = await adopt(c, copy, tags, meta);
          } catch (error) {
            if (templateOnly || o.signal?.aborted) throw error;
            progress(`copying the template failed (${(error as Error).message}); creating from scratch`);
            await removeVM(c, target);
            vm = undefined;
          }
        }
        if (!vm) {
          progress(`creating ${target}${kind.setup ? " and running its setup script" : ""}`);
          vm = await c.create({
            name: target,
            tags: [...tags, PROVISIONING_TAG],
            comment: encodeMeta(meta),
            cpu: kind.cpu,
            memory: size(kind.memory),
            disk: size(kind.disk),
            egress: kind.egress,
            env: Object.entries(kind.env).map(([k, v]) => `${k}=${v}`),
            image: kind.image,
            setupScript: kind.setup,
            signal: o.signal,
          });
          await c.tag(target, [PROVISIONING_TAG], true);
          vm = { ...vm, tags };
        }
        // Commands read the kind's env from here, so copies of templates get it too.
        if (Object.keys(kind.env).length) await c.writeFile(target, ENV_FILE, envFile(kind.env), { signal: o.signal });
        usage.touch(target, now());
        return new ExeSandbox(vm);
      } catch (error) {
        // A half-made sandbox would only hold capacity; the reaper sweeps what this misses.
        await removeVM(c, target).catch((e) => progress((e as Error).message));
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
      const srcVM = (await all()).find((vm) => vm.name === src.id)!;
      try {
        const copy = await c.copy(src.id, { name: target, signal: o.signal });
        const extra = srcVM.tags.filter((t) => t !== KEEP_TAG && t !== nameTag(src.name) && !t.startsWith("sbx-name-") && !t.startsWith("sbx-kind-"));
        const tags = [...new Set([...sandboxTags(name, src.kind), ...extra])];
        const vm = await adopt(c, copy, tags, { ...decodeMeta(srcVM.comment), u: day(now()) });
        usage.touch(vm.name, now());
        return new ExeSandbox(vm);
      } catch (error) {
        await removeVM(c, target).catch((e) => o.onProgress?.((e as Error).message));
        throw error;
      }
    },

    async remove(source: string | Sandbox) {
      const found = await find(typeof source === "string" ? source : source.id);
      if (!found) return false;
      const removed = await removeVM(await client(), found.id);
      usage.forget(found.id);
      return removed;
    },

    async sweep({ olderThanMs }) {
      const c = await client();
      const cutoff = now().getTime() - olderThanMs;
      const leaked = (await all()).filter((vm) => {
        if (!vm.createdAt || new Date(vm.createdAt).getTime() > cutoff) return false;
        if (vm.tags.includes(PROVISIONING_TAG)) return true;
        // A copy that never got its own tags still wears its template's.
        if (vm.tags.includes(TEMPLATE_TAG)) return !vm.name.startsWith(TEMPLATE_PREFIX);
        return !tagValue(vm.tags, "name");
      });
      const removed: string[] = [];
      for (const vm of leaked) {
        await removeVM(c, vm.name);
        usage.forget(vm.name);
        removed.push(vm.name);
      }
      return removed;
    },

    gitRemote: (github: string) => integrationUrl(github, githubBase),

    templates: {
      async build(kind: KindSpec, o: OperationOptions = {}): Promise<TemplateInfo> {
        const c = await client();
        const old = (await templateVMs()).filter((vm) => vm.tags.includes(kindTag(kind.name)));
        const name = templateVmName(kind.name);
        o.onProgress?.(`creating ${name}${kind.setup ? " and running the setup script" : ""}`);
        let vm: ExeVM;
        try {
          // Templates run only the trusted setup script, so they get the internet even for
          // restricted kinds; each copy gets the kind's egress when it is made.
          vm = await c.create({
            name,
            tags: [...templateTags(kind.name), PROVISIONING_TAG],
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
          if (Object.keys(kind.env).length) await c.writeFile(name, ENV_FILE, envFile(kind.env), { signal: o.signal });
          o.onProgress?.(`pausing ${name}`);
          await c.pause(name);
          await c.tag(name, [PROVISIONING_TAG], true);
        } catch (error) {
          await removeVM(c, name).catch((e) => o.onProgress?.((e as Error).message));
          throw error;
        }
        for (const t of old) await removeVM(c, t.name);
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
        for (const t of tpl) await removeVM(c, t.name);
        return tpl.length > 0;
      },
    },

    integrations: {
      githubCommands(repo: string, o: { readonly?: boolean } = {}) {
        const flags = [
          `--name=${githubIntegrationName(repo)}`,
          `--repository=${quote(repo)}`,
          `--attach=tag:${GITHUB_TAG}`,
          ...(o.readonly ? ["--readonly"] : []),
        ];
        return [`ssh exe.dev integrations add github ${flags.join(" ")}`];
      },
      kindCommands(kind: KindSpec) {
        return kind.integrations.map((i) => `ssh exe.dev integrations attach ${quote(i)} tag:${kindTag(kind.name)}`);
      },
    },
  };
  return provider;
}

/** Registry factory: config `{ type: "exe", token?, key?, baseURL?, githubBase? }`. */
export function exeFactory(config: ProviderConfig, context: ProviderContext): SandboxProvider {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const paths = authPaths(context.env, { token: str(config.token), key: str(config.key) });
  return exeProvider({
    id: context.id,
    usage: fileUsage(join(stateHome(context.env), "sbx", "last-used.json")),
    githubBase: str(config.githubBase),
    client: async () => {
      const { signToken } = await import("@exedev/sdk");
      return sdkClient({
        token: () => token(signToken, context.env, paths),
        baseURL: str(config.baseURL),
        userAgent: "sbx/0.1",
      });
    },
  });
}
