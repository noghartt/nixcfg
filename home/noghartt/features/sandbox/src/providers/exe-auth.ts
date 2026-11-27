// exe.dev credentials. sbx signs short-lived tokens locally with its own
// per-machine key, never the user's main exe.dev key (which stays in the
// 1Password agent); removing the key from exe.dev revokes every token at once.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { configHome } from "../config.ts";

/** The exe.dev commands sbx runs; tokens can run nothing else. */
export const TOKEN_COMMANDS = [
  "whoami",
  "ls",
  "new",
  "cp",
  "rm",
  "ssh",
  "tag",
  "comment",
  "pause",
  "resume",
  "integrations list",
  "integrations add",
  "integrations attach",
] as const;

export const TOKEN_LIFETIME_S = 3600;

export function tokenPermissions(now = Date.now()): { exp: number; cmds: string[] } {
  return { exp: Math.floor(now / 1000) + TOKEN_LIFETIME_S, cmds: [...TOKEN_COMMANDS] };
}

export function keyPath(env: NodeJS.ProcessEnv = process.env, configured?: string): string {
  return configured || join(configHome(env), "sbx", "exe_key");
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type Signer = (options: { privateKey: string; permissions: { exp: number; cmds: string[] } }) => Promise<string>;

/** `EXE_TOKEN` if set, else a token signed from the sbx key. */
export async function token(signer: Signer, env: NodeJS.ProcessEnv = process.env, configuredKey?: string): Promise<string> {
  if (env.EXE_TOKEN) return env.EXE_TOKEN;
  const path = keyPath(env, configuredKey);
  if (!existsSync(path)) throw new AuthError(`no exe.dev key at ${path}; run \`sbx auth setup\``);
  return signer({ privateKey: readFileSync(path, "utf8"), permissions: tokenPermissions() });
}

/** Generates the key if missing; returns its path and whether it is new. */
export async function setupKey(path: string): Promise<{ path: string; created: boolean }> {
  if (existsSync(path)) return { path, created: false };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `sbx@${hostname().split(".")[0]}`, "-f", path]);
  return { path, created: true };
}

export function addKeyInstruction(path: string): string {
  return `ssh exe.dev ssh-key add < ${path}.pub`;
}
