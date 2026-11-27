// The provider contract. Everything sbx does goes through these interfaces, so
// a new backend (a self-hosted runner, a local VM manager, ...) implements this
// file and passes tests/contract.ts; nothing else in sbx names a provider.

/** What a sandbox may reach on the network. */
export type EgressPolicy =
  /** The public internet. */
  | "all"
  /** No public internet: only the provider's own services and secret integrations attached to the sandbox. */
  | "integrations";

/**
 * Optional features. Callers branch on these, never on `SandboxProvider.id`;
 * a method behind a capability the provider lacks throws `UnsupportedError`.
 */
export interface Capabilities {
  /** `fork` copies a sandbox, disk included. */
  fork: boolean;
  /** `Sandbox.pause`/`resume` stop and restart it, keeping its disk. */
  pause: boolean;
  /** Kinds may set cpu, memory and disk. */
  resize: boolean;
  /** Egress policies a kind may ask for. */
  egress: readonly EgressPolicy[];
  /** Secrets live off the sandbox and are injected on the network (kind `integrations`, `github`). */
  secretIntegrations: boolean;
  /** `Sandbox.url` returns an HTTPS URL to a port of the sandbox. */
  httpsUrl: boolean;
  /** `Sandbox.sshDest` is an `ssh` destination for an interactive shell. */
  interactiveShell: boolean;
  /** `templates` prebuilds a kind's setup so `create` starts from a copy. */
  templates: boolean;
}

/** A resolved kind: everything a provider needs to make a sandbox of it. */
export interface KindSpec {
  name: string;
  /** Provider id from the config. */
  provider: string;
  egress: EgressPolicy;
  cpu?: number;
  /** GB. */
  memory?: number;
  /** GB. */
  disk?: number;
  /** Secret integrations to attach by name. */
  integrations: readonly string[];
  /** Extra provider tags, so integrations attached to a tag reach the kind. */
  tags: readonly string[];
  /** Shell script run once as the sandbox's first boot. */
  setup?: string;
  image?: string;
  /** Exported to every command. */
  env: Readonly<Record<string, string>>;
}

/** A git checkout to seed a sandbox with; seeding is core (seed.ts), on exec/writeFile. */
export interface RepoSpec {
  /** A local checkout's path, or `owner/repo` on GitHub. */
  source: string;
  branch?: string;
}

/** What the provider records about the checkout, so every machine sees it. */
export interface CheckoutMeta {
  /** `owner/repo`, or the repository's directory name. */
  repo: string;
  branch?: string;
  /** The commit the checkout was seeded at; the base for incremental pulls. */
  commit?: string;
}

export interface CreateSpec {
  kind: KindSpec;
  /** Human name, unique among sandboxes; generated when absent. */
  name?: string;
  checkout?: CheckoutMeta;
}

export interface ForkSpec {
  name?: string;
  /** The source's kind, so the copy gets the kind's integrations again. */
  kind?: KindSpec;
}

export interface OperationOptions {
  signal?: AbortSignal;
  /** Human-readable progress, for a CLI's stderr. */
  onProgress?: (message: string) => void;
}

export type SandboxStatus = "running" | "paused" | "starting" | "stopped" | "unknown";

export interface SandboxInfo {
  created?: Date;
  /** Last time sbx touched it, from any machine that recorded it. */
  lastUsed?: Date;
  /** `owner/repo` or the repository's directory name. */
  repo?: string;
  branch?: string;
  /** Commit the checkout was seeded at. */
  commit?: string;
  /** Absolute or home-relative directory holding the checkout; commands start here by default. */
  workdir?: string;
  /** The default HTTPS URL, when the provider has one. */
  url?: string;
  /** Exempt from reaping. */
  keep: boolean;
  egress?: EgressPolicy;
}

export interface ExecOptions {
  /** Directory to run in; relative to the home directory. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Aborting stops the command on the sandbox too, not only the local wait. */
  signal?: AbortSignal;
  /** Kill the command after this long; it then exits 124, like timeout(1). */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
  /** Keep output in the result (default true); false streams with bounded memory. */
  capture?: boolean;
  /**
   * Standard input, buffered: it is uploaded before the command starts (exe.dev's
   * API has no stdin), so it suits files and prompts, not interactive streams.
   * Without it, stdin is empty.
   */
  stdin?: string | Uint8Array;
}

export interface ExecResult {
  /**
   * The command's status: 128+N when killed by signal N; on `timeoutMs`, 124, or
   * 137 when it ignored SIGTERM for the 10-second grace period.
   */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** Human name. */
  readonly name: string;
  /** Provider-side identifier (a VM hostname, a container id, ...). */
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly status: SandboxStatus;
  readonly info: SandboxInfo;
  /** `ssh` destination, when `interactiveShell`. */
  readonly sshDest?: string;

  /**
   * Run a POSIX sh script in the home directory. A nonzero exit is a result, not an
   * error. Does not count as use: callers record use with `touch`.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Paths are relative to the home directory unless absolute. Binary-safe. */
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** Replaces the file and creates its directory. */
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; signal?: AbortSignal }): Promise<void>;
  upload(localPath: string, remotePath: string, options?: { exclude?: readonly string[]; signal?: AbortSignal }): Promise<void>;
  download(remotePath: string, localPath: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Needs `pause`. */
  pause(): Promise<void>;
  /** Needs `pause`. */
  resume(): Promise<void>;
  /** Needs `httpsUrl`. */
  url(port?: number): string;
  setKeep(keep: boolean): Promise<void>;
  /** Record use now, for the reaper. Commands, file operations and the reaper's own probes do not. */
  touch(): Promise<void>;
}

export interface TemplateInfo {
  kind: string;
  id: string;
  created?: Date;
  /** False when the kind's setup or image changed since the build. */
  current: boolean;
}

export interface Templates {
  build(kind: KindSpec, options?: OperationOptions): Promise<TemplateInfo>;
  /** `current` is computed for the kinds given. */
  list(kinds?: readonly KindSpec[]): Promise<TemplateInfo[]>;
  remove(kind: string): Promise<boolean>;
}

/**
 * Secret integrations are account-level grants, so sbx does not hold the right
 * to make them: these return the commands the user runs once, with their own
 * credentials, to attach integrations to sandboxes by tag.
 */
export interface Integrations {
  /** Give sandboxes of kinds tagged for it access to a GitHub repository, with no token on them. */
  githubCommands(repo: string, options?: { readonly?: boolean }): string[];
  /** Attach a kind's integrations to every sandbox of the kind. */
  kindCommands(kind: KindSpec): string[];
}

export interface SandboxProvider {
  /** Config id, e.g. "exe". For messages only. */
  readonly id: string;
  capabilities(): Capabilities;
  create(spec: CreateSpec, options?: OperationOptions): Promise<Sandbox>;
  /** By human name or provider id. */
  get(name: string): Promise<Sandbox | undefined>;
  /** Sandboxes made by sbx only. */
  list(): Promise<Sandbox[]>;
  /** Needs `fork`. */
  fork(source: string | Sandbox, spec?: ForkSpec, options?: OperationOptions): Promise<Sandbox>;
  /** False when it did not exist. */
  remove(name: string | Sandbox): Promise<boolean>;
  /** Present when `templates`. */
  readonly templates?: Templates;
  /** Present when `secretIntegrations`. */
  readonly integrations?: Integrations;
  /**
   * URL a sandbox can clone and push `owner/repo` through without credentials,
   * when the provider offers one; core seeding probes it before relying on it.
   */
  gitRemote?(github: string): string | undefined;
  /** Remove half-made sandboxes left by failed operations older than this; returns their ids. */
  sweep?(options: { olderThanMs: number }): Promise<string[]>;
}

export class UnsupportedError extends Error {
  constructor(provider: string, feature: string) {
    super(`provider ${provider} does not support ${feature}`);
    this.name = "UnsupportedError";
  }
}

export class NotFoundError extends Error {
  constructor(name: string) {
    super(`no sandbox named ${name}`);
    this.name = "NotFoundError";
  }
}
