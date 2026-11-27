// Providers are registered by type with a factory and instantiated lazily from
// the config, so commands that never touch a provider need no credentials.
import { ConfigError, type ProviderConfig, type SbxConfig } from "./config.ts";
import { type Capabilities, type KindSpec, type Sandbox, type SandboxProvider, UnsupportedError } from "./provider.ts";

export interface ProviderContext {
  /** Config id of this provider instance. */
  id: string;
  env: NodeJS.ProcessEnv;
}

export type ProviderFactory = (config: ProviderConfig, context: ProviderContext) => SandboxProvider;

const factories = new Map<string, ProviderFactory>();

export function registerProvider(type: string, factory: ProviderFactory): void {
  factories.set(type, factory);
}

export function registeredProviders(): string[] {
  return [...factories.keys()];
}

/** Why `kind` cannot run on a provider with `caps`, or undefined when it can. */
export function kindProblem(kind: KindSpec, caps: Capabilities): string | undefined {
  if (!caps.egress.includes(kind.egress)) return `egress ${kind.egress}`;
  if (kind.integrations.length > 0 && !caps.secretIntegrations) return "secret integrations";
  if ((kind.cpu || kind.memory || kind.disk) && !caps.resize) return "sizing (cpu/memory/disk)";
  return undefined;
}

export class Sbx {
  readonly config: SbxConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #instances = new Map<string, SandboxProvider>();
  readonly #factories: Map<string, ProviderFactory>;

  constructor(config: SbxConfig, options: { env?: NodeJS.ProcessEnv; factories?: Map<string, ProviderFactory> } = {}) {
    this.config = config;
    this.#env = options.env ?? process.env;
    this.#factories = options.factories ?? factories;
  }

  providerIds(): string[] {
    return Object.keys(this.config.providers);
  }

  provider(id: string): SandboxProvider {
    let instance = this.#instances.get(id);
    if (instance) return instance;
    const config = this.config.providers[id];
    if (!config) throw new ConfigError(`unknown provider ${id}`);
    const type = config.type ?? id;
    const factory = this.#factories.get(type);
    if (!factory) throw new ConfigError(`provider ${id}: no provider type ${type} (known: ${[...this.#factories.keys()].join(", ")})`);
    instance = factory(config, { id, env: this.#env });
    this.#instances.set(id, instance);
    return instance;
  }

  /** The named kind (or the default), checked against its provider's capabilities. */
  kind(name?: string): KindSpec {
    const kindName = name ?? this.config.defaultKind;
    const kind = this.config.kinds[kindName];
    if (!kind) throw new ConfigError(`unknown kind ${kindName} (kinds: ${Object.keys(this.config.kinds).join(", ")})`);
    const problem = kindProblem(kind, this.provider(kind.provider).capabilities());
    if (problem) throw new UnsupportedError(kind.provider, `${problem}, which kind ${kind.name} needs`);
    return kind;
  }

  /** Every sbx sandbox across providers. */
  async list(): Promise<Sandbox[]> {
    const all = await Promise.all(this.providerIds().map((id) => this.provider(id).list()));
    return all.flat();
  }

  /** Find a sandbox by name on any provider. */
  async find(name: string): Promise<Sandbox | undefined> {
    for (const id of this.providerIds()) {
      const found = await this.provider(id).get(name);
      if (found) return found;
    }
    return undefined;
  }

  providerOf(sandbox: Sandbox): SandboxProvider {
    return this.provider(sandbox.provider);
  }
}
