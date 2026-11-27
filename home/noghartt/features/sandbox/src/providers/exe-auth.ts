// exe.dev credentials. sbx holds only a token scoped to the `sbx` tag: it sees
// and manages sbx's VMs and nothing else, and the VMs it creates get the tag.
// The user makes it once with their own exe.dev key (which sbx never touches).
// A per-machine key added with `ssh-key add --tag=sbx` is the fallback, for
// short-lived tokens signed locally.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { configHome } from "../config.ts";
import { TAG } from "../names.ts";

/** The exe.dev commands sbx runs; tokens can run nothing else. */
export const TOKEN_COMMANDS = ["new", "ls", "cp", "rm", "ssh", "tag", "comment", "pause", "resume"] as const;

export const TOKEN_LIFETIME_S = 3600;

export function tokenPermissions(now = Date.now()): { exp: number; cmds: string[] } {
  return { exp: Math.floor(now / 1000) + TOKEN_LIFETIME_S, cmds: [...TOKEN_COMMANDS] };
}

export interface AuthPaths {
  token: string;
  key: string;
}

export function authPaths(env: NodeJS.ProcessEnv = process.env, configured: { token?: string; key?: string } = {}): AuthPaths {
  const dir = join(configHome(env), "sbx");
  return { token: configured.token || join(dir, "exe_token"), key: configured.key || join(dir, "exe_key") };
}

/** Whether any credential is present, without reading it. */
export function configured(env: NodeJS.ProcessEnv, paths: AuthPaths): boolean {
  return !!env.EXE_TOKEN || existsSync(paths.token) || existsSync(paths.key);
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type Signer = (options: { privateKey: string; permissions: { exp: number; cmds: string[] } }) => Promise<string>;

/** `EXE_TOKEN`, else the stored tag-scoped token, else one signed from the fallback key. */
export async function token(signer: Signer, env: NodeJS.ProcessEnv, paths: AuthPaths): Promise<string> {
  if (env.EXE_TOKEN) return env.EXE_TOKEN;
  if (existsSync(paths.token)) {
    const t = readFileSync(paths.token, "utf8").trim();
    if (t) return t;
  }
  if (existsSync(paths.key)) return signer({ privateKey: readFileSync(paths.key, "utf8"), permissions: tokenPermissions() });
  throw new AuthError(`no exe.dev credentials (${paths.token}); run \`sbx auth setup\``);
}

/** The command the user runs with their own exe.dev key to make sbx's token. */
export function generateCommand(host = hostname()): string {
  const label = `sbx-${host.split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
  return `ssh exe.dev ssh-key generate-api-key --label=${label} --tag=${TAG} --exp=90d --cmds=${TOKEN_COMMANDS.join(",")} --json`;
}

/** The token in `generate-api-key` output: its JSON, or a bare token. */
export function parseToken(input: string): string {
  const text = input.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {}
  const match = text.match(/\bexe[01]\.[A-Za-z0-9._~+/=-]+/);
  if (!match) throw new AuthError("no exe.dev token in the input (expected exe0.… or exe1.…, or generate-api-key --json output)");
  return match[0];
}

export async function storeToken(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Generates the fallback key if missing; returns whether it is new. */
export async function setupKey(path: string): Promise<{ path: string; created: boolean }> {
  if (existsSync(path)) return { path, created: false };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `sbx@${hostname().split(".")[0]}`, "-f", path]);
  return { path, created: true };
}

export function addKeyInstruction(path: string): string {
  return `ssh exe.dev ssh-key add --tag=${TAG} < ${path}.pub`;
}
