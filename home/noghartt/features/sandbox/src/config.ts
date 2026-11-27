// sbx's config: providers and kinds, written by Nix to
// $XDG_CONFIG_HOME/sbx/config.json and read-only here.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EgressPolicy, KindSpec } from "./provider.ts";

export interface ProviderConfig {
  /** Registered factory; defaults to the provider's id. */
  type?: string;
  [option: string]: unknown;
}

export interface SbxConfig {
  defaultKind: string;
  providers: Record<string, ProviderConfig>;
  kinds: Record<string, KindSpec>;
  reap: { days: number };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SBX_CONFIG || join(configHome(env), "sbx", "config.json");
}

const egressPolicies: readonly EgressPolicy[] = ["all", "integrations"];

function strings(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new ConfigError(`${where} must be a list of strings`);
  return value;
}

function positive(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !(value > 0)) throw new ConfigError(`${where} must be a positive number`);
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ConfigError(`${where} must be a string`);
  return value;
}

function kind(name: string, raw: unknown, providers: Record<string, ProviderConfig>): KindSpec {
  if (!raw || typeof raw !== "object") throw new ConfigError(`kind ${name} must be an object`);
  const k = raw as Record<string, unknown>;
  const where = `kind ${name}`;
  const provider = optionalString(k.provider, `${where}.provider`) ?? Object.keys(providers)[0];
  if (!provider || !providers[provider]) throw new ConfigError(`${where}: unknown provider ${String(k.provider)}`);
  const egress = (k.egress ?? "all") as EgressPolicy;
  if (!egressPolicies.includes(egress))
    throw new ConfigError(`${where}.egress must be one of ${egressPolicies.join(", ")}`);
  const env = k.env ?? {};
  if (typeof env !== "object" || Object.values(env).some((v) => typeof v !== "string"))
    throw new ConfigError(`${where}.env must map names to strings`);
  for (const key of Object.keys(env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ConfigError(`${where}.env: bad variable name ${key}`);
  return {
    name,
    provider,
    egress,
    cpu: positive(k.cpu, `${where}.cpu`),
    memory: positive(k.memory, `${where}.memory`),
    disk: positive(k.disk, `${where}.disk`),
    integrations: strings(k.integrations, `${where}.integrations`),
    tags: strings(k.tags, `${where}.tags`),
    setup: optionalString(k.setup, `${where}.setup`),
    image: optionalString(k.image, `${where}.image`),
    env: env as Record<string, string>,
  };
}

export function parseConfig(raw: unknown): SbxConfig {
  if (!raw || typeof raw !== "object") throw new ConfigError("config must be a JSON object");
  const c = raw as Record<string, unknown>;
  const providers = (c.providers ?? {}) as Record<string, ProviderConfig>;
  if (typeof providers !== "object" || Object.keys(providers).length === 0)
    throw new ConfigError("config declares no providers");
  const kindsRaw = (c.kinds ?? {}) as Record<string, unknown>;
  const kinds: Record<string, KindSpec> = {};
  for (const [name, k] of Object.entries(kindsRaw)) kinds[name] = kind(name, k, providers);
  if (Object.keys(kinds).length === 0) throw new ConfigError("config declares no kinds");
  const defaultKind = optionalString(c.defaultKind, "defaultKind") ?? Object.keys(kinds)[0];
  if (!kinds[defaultKind]) throw new ConfigError(`defaultKind ${defaultKind} is not a kind`);
  const reapRaw = (c.reap ?? {}) as Record<string, unknown>;
  return { defaultKind, providers, kinds, reap: { days: positive(reapRaw.days, "reap.days") ?? 7 } };
}

export function loadConfig(path = configPath()): SbxConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}
