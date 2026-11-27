// Names, tags and the metadata comment. exe.dev VM names are global DNS
// labels, and tag syntax is undocumented, so both stay within lowercase
// letters, digits and hyphens.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";

export const TAG = "sbx";
export const KEEP_TAG = "sbx-keep";
export const TEMPLATE_TAG = "sbx-tpl";
/** On VMs still being set up; the reaper removes ones a failed run left behind. */
export const PROVISIONING_TAG = "sbx-provisioning";
/** Opt-in tag GitHub integrations attach to (`sbx github add`). */
export const GITHUB_TAG = "sbx-gh";
export const TEMPLATE_PREFIX = "sbx-tpl-";
const NAME_PREFIX = "sbx-name-";
const KIND_PREFIX = "sbx-kind-";
/** Leaves room for the 7-character suffix inside a 63-byte DNS label, with margin. */
const MAX_NAME = 40;
/** exe.dev's limit on `comment`. */
export const MAX_COMMENT = 200;

/** A DNS-label-safe form of `input`: lowercase, [a-z0-9-], starting with a letter. */
export function sanitize(input: string, max = MAX_NAME): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-0-9]+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
  if (!s) s = "sbx";
  return s;
}

export function suffix(): string {
  return randomBytes(3).toString("hex");
}

/** The provider-side name for a sandbox: globally unique, recognisably ours. */
export function vmName(name: string, hex = suffix()): string {
  return `${sanitize(name)}-${hex}`;
}

export function templateVmName(kind: string, hex = suffix()): string {
  return `${TEMPLATE_PREFIX}${sanitize(kind, 24)}-${hex}`;
}

export function nameTag(name: string): string {
  return NAME_PREFIX + sanitize(name);
}

export function kindTag(kind: string): string {
  return KIND_PREFIX + sanitize(kind);
}

export function sandboxTags(name: string, kind: string, extra: readonly string[] = []): string[] {
  return [...new Set([TAG, nameTag(name), kindTag(kind), ...extra.map((t) => sanitize(t, 63))])];
}

export function templateTags(kind: string): string[] {
  return [TAG, TEMPLATE_TAG, kindTag(kind)];
}

export function tagValue(tags: readonly string[], prefix: "name" | "kind"): string | undefined {
  const p = prefix === "name" ? NAME_PREFIX : KIND_PREFIX;
  return tags.find((t) => t.startsWith(p))?.slice(p.length);
}

/** Random human name, for `create` without `--name`. */
export function randomName(): string {
  const words = ["amber", "brisk", "cedar", "dune", "ember", "fjord", "gale", "heron", "iris", "juniper", "kelp", "lumen"];
  return `${words[randomBytes(1)[0] % words.length]}-${suffix().slice(0, 4)}`;
}

/** Sandbox metadata kept on the provider, so every machine sees the same state. */
export interface Meta {
  /** Repository, `owner/repo` or a directory name. */
  r?: string;
  /** Branch. */
  b?: string;
  /** Last-used day, YYYY-MM-DD. */
  u?: string;
  /** Template fingerprint (setup + image). */
  h?: string;
  /** Commit the checkout was seeded at. */
  s?: string;
}

export function encodeMeta(meta: Meta): string {
  const m: Meta = { ...meta };
  for (const drop of ["s", "b", "r"] as const) {
    if (Buffer.byteLength(JSON.stringify(m)) <= MAX_COMMENT) break;
    delete m[drop];
  }
  const text = JSON.stringify(m);
  if (Buffer.byteLength(text) > MAX_COMMENT) throw new Error("sandbox metadata exceeds the comment limit");
  return text;
}

export function decodeMeta(comment: string | undefined): Meta {
  if (!comment) return {};
  try {
    const parsed = JSON.parse(comment);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Where a repository is checked out on the sandbox, relative to its home. */
export function workdir(repo: string): string {
  const dir = basename(repo.replace(/\/+$/, "").replace(/\.git$/, "")).replace(/[^A-Za-z0-9._-]/g, "-");
  return dir && !dir.startsWith(".") ? dir : "repo";
}
