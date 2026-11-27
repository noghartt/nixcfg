// The slice of exe.dev the provider uses, so tests can substitute a fake.
// `sdkClient` adapts @exedev/sdk to it.
import type { EgressPolicy } from "../provider.ts";

export interface ExeVM {
  name: string;
  tags: readonly string[];
  sshDest?: string;
  httpsUrl?: string;
  status?: string;
  comment?: string;
  createdAt?: string;
  egress?: EgressPolicy;
}

export interface ExeNewOptions {
  name: string;
  tags: readonly string[];
  comment?: string;
  cpu?: number;
  memory?: string;
  disk?: string;
  egress: EgressPolicy;
  env?: readonly string[];
  image?: string;
  integrations?: readonly string[];
  setupScript?: string;
  signal?: AbortSignal;
}

export interface ExeCopyOptions {
  name: string;
  cpu?: number;
  memory?: string;
  disk?: string;
  egress?: EgressPolicy;
  signal?: AbortSignal;
}

export interface ExeSSHOptions {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
  capture?: boolean;
}

export interface ExeClient {
  list(signal?: AbortSignal): Promise<ExeVM[]>;
  /** Resolves once SSH works, and the setup script finished when there is one. */
  create(options: ExeNewOptions): Promise<ExeVM>;
  /** Without the source's tags; resolves once SSH works. */
  copy(source: string, options: ExeCopyOptions): Promise<ExeVM>;
  /** False when the VM did not exist. */
  remove(name: string): Promise<boolean>;
  tag(vm: string, tags: readonly string[], remove?: boolean): Promise<void>;
  comment(vm: string, text: string): Promise<void>;
  pause(vm: string): Promise<void>;
  resume(vm: string): Promise<void>;
  /** Like the SDK: aborting stops the local wait, not necessarily the command. */
  ssh(vm: string, command: string, options?: ExeSSHOptions): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(vm: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
  writeFile(vm: string, path: string, data: string | Uint8Array, options?: { mode?: number; signal?: AbortSignal }): Promise<void>;
  upload(vm: string, local: string, remote: string, options?: { exclude?: readonly string[]; signal?: AbortSignal }): Promise<void>;
  download(vm: string, remote: string, local: string, signal?: AbortSignal): Promise<void>;
  attachIntegration(name: string, spec: string): Promise<void>;
  addGithubIntegration(options: { name: string; repository: string; readonly: boolean; attach: string }): Promise<void>;
}

/** Wraps the SDK. Imported lazily so the rest of sbx loads without it. */
export async function sdkClient(options: { token: () => Promise<string>; baseURL?: string; userAgent?: string }): Promise<ExeClient> {
  const sdk = await import("@exedev/sdk");
  // Tokens live an hour; re-sign well before, so long `sbx run`s can still clean up.
  let client: ReturnType<typeof sdk.exedev> | undefined;
  let issued = 0;
  const api = async () => {
    if (!client || Date.now() - issued > 30 * 60_000) {
      client = sdk.exedev({ token: await options.token(), baseURL: options.baseURL, userAgent: options.userAgent });
      issued = Date.now();
    }
    return client;
  };
  const toVM = (vm: InstanceType<typeof sdk.VM>): ExeVM => ({
    name: vm.name,
    tags: vm.tags,
    sshDest: vm.sshDest,
    httpsUrl: vm.httpsUrl,
    status: vm.info.status,
    comment: vm.info.comment,
    createdAt: vm.info.createdAt,
    egress: vm.info.egressPolicy,
  });
  const isNotFound = (error: unknown) => error instanceof sdk.ExeAPIError && error.status === 404;
  return {
    async list(signal) {
      return (await (await api()).ls(undefined, { signal })).map(toVM);
    },
    async create(o) {
      const vm = await (await api()).new({
        name: o.name,
        tag: o.tags,
        comment: o.comment,
        cpu: o.cpu,
        memory: o.memory,
        disk: o.disk,
        egress: o.egress,
        env: o.env?.length ? o.env : undefined,
        image: o.image,
        integration: o.integrations?.length ? o.integrations : undefined,
        "setup-script": o.setupScript,
        "no-email": true,
        waitUntil: o.setupScript ? "setup" : "ssh",
        signal: o.signal,
      });
      return toVM(vm);
    },
    async copy(source, o) {
      const vm = await (await api()).vm(source).cp({
        name: o.name,
        "copy-tags": false,
        cpu: o.cpu,
        memory: o.memory,
        disk: o.disk,
        egress: o.egress,
        signal: o.signal,
      });
      return toVM(vm);
    },
    async remove(name) {
      try {
        await (await api()).vm(name).rm();
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async tag(vm, tags, remove) {
      await (await api()).vm(vm).tag(tags, { d: remove || undefined });
    },
    async comment(vm, text) {
      await (await api()).vm(vm).comment(text);
    },
    async pause(vm) {
      await (await api()).vm(vm).pause();
    },
    async resume(vm) {
      await (await api()).vm(vm).resume();
    },
    async ssh(vm, command, o = {}) {
      const r = await (await api()).vm(vm).ssh(command, o);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    readFile: async (vm, path, signal) => (await api()).vm(vm).readFile(path, { signal }),
    writeFile: async (vm, path, data, o) => (await api()).vm(vm).writeFile(path, data, o),
    upload: async (vm, local, remote, o) => (await api()).vm(vm).upload(local, remote, o),
    download: async (vm, remote, local, signal) => (await api()).vm(vm).download(remote, local, { signal }),
    async attachIntegration(name, spec) {
      await (await api()).integrationsAttach(name, spec);
    },
    async addGithubIntegration(o) {
      await (await api()).integrationsAdd("github", {
        name: o.name,
        repository: o.repository,
        readonly: o.readonly || undefined,
        attach: o.attach,
      });
    },
  };
}
