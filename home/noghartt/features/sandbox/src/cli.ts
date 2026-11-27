// `sbx`: the command-line face of the library. Provider-agnostic: it branches
// on capabilities only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm as rmPath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import "./builtin.ts";
import { configPath, loadConfig } from "./config.ts";
import { fetchBundle, PULL_BUNDLE, pullScript } from "./git.ts";
import { addKeyInstruction, keyPath, setupKey } from "./providers/exe-auth.ts";
import { type Sandbox, type SandboxProvider, NotFoundError, UnsupportedError } from "./provider.ts";
import { reap } from "./reap.ts";
import { Sbx } from "./registry.ts";
import { commandLine, quote } from "./shell.ts";

const USAGE = `usage: sbx <command> [options]

  auth setup                         create this machine's exe.dev key
  kinds [--json]                     list sandbox kinds
  create [--kind k] [--name n] [--repo path|owner/repo] [--branch b] [--json]
  ls [--json]                        list sandboxes
  exec <name> [--cwd d] [--timeout s] -- <cmd...>
  shell <name> [-- <cmd...>]         interactive ssh
  fork <name> [--name n] [--json]
  pause|resume|rm <name>
  keep <name>                        toggle exemption from reaping
  url <name> [port]
  pull <name> [branch...] [--repo path]
                                     fetch branches as sbx/<name>/<branch>
  github add <owner/repo> [--readonly]
  template build <kind> | ls [--json] | rm <kind>
  run [--kind job] [--repo r] [--branch b] [--artifacts path] [--out dir] [--keep] [--timeout s] -- <cmd...>
  reap [--days n] [--dry-run] [--json]

config: ${configPath()}`;

class UsageError extends Error {}

function die(message: string, code = 1): never {
  process.stderr.write(`sbx: ${message}\n`);
  process.exit(code);
}

const progress = (message: string) => process.stderr.write(`sbx: ${message}\n`);
const print = (text: string) => process.stdout.write(`${text}\n`);
const json = (value: unknown) => (print(JSON.stringify(value, null, 2)), 0);

/** Ctrl-C aborts the operation (and the remote command); a second one exits at once. */
function interruptible(): AbortSignal {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    progress("interrupted; stopping the remote command (Ctrl-C again to quit now)");
    controller.abort(new Error("interrupted"));
  });
  return controller.signal;
}

function describe(s: Sandbox) {
  return {
    name: s.name,
    id: s.id,
    provider: s.provider,
    kind: s.kind,
    status: s.status,
    sshDest: s.sshDest,
    ...s.info,
  };
}

function age(date: Date | undefined): string {
  if (!date) return "-";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

function split(argv: string[]): { args: string[]; rest: string[] } {
  const i = argv.indexOf("--");
  return i < 0 ? { args: argv, rest: [] } : { args: argv.slice(0, i), rest: argv.slice(i + 1) };
}

function parse<T extends Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0)) throw new UsageError(`--timeout must be a positive number of seconds`);
  return n * 1000;
}

async function sandbox(sbx: Sbx, name: string | undefined): Promise<Sandbox> {
  if (!name) throw new UsageError("missing sandbox name");
  const found = await sbx.find(name);
  if (!found) throw new NotFoundError(name);
  return found;
}

function need(provider: SandboxProvider, feature: keyof ReturnType<SandboxProvider["capabilities"]>) {
  if (!provider.capabilities()[feature]) throw new UnsupportedError(provider.id, feature);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return command ? 0 : 2;
  }
  const { args, rest: after } = split(rest);

  if (command === "auth") {
    const [sub] = args;
    if (sub !== "setup") throw new UsageError("usage: sbx auth setup");
    const sbx = new Sbx(loadConfig());
    const exeConfig = Object.values(sbx.config.providers).find((p) => (p.type ?? "exe") === "exe");
    const { path, created } = await setupKey(keyPath(process.env, exeConfig?.key as string | undefined));
    print(created ? `created ${path}` : `${path} already exists`);
    print(`register it with exe.dev once (uses your normal exe.dev key):\n  ${addKeyInstruction(path)}`);
    return 0;
  }

  const sbx = new Sbx(loadConfig());

  switch (command) {
    case "kinds": {
      const { values } = parse(args, { json: { type: "boolean" } });
      const kinds = Object.values(sbx.config.kinds);
      if (values.json) return json(kinds);
      print(
        table([
          ["KIND", "PROVIDER", "EGRESS", "CPU", "MEMORY", "INTEGRATIONS"],
          ...kinds.map((k) => [
            k.name + (k.name === sbx.config.defaultKind ? "*" : ""),
            k.provider,
            k.egress,
            String(k.cpu ?? "-"),
            k.memory ? `${k.memory}GB` : "-",
            k.integrations.join(",") || "-",
          ]),
        ]),
      );
      return 0;
    }

    case "create": {
      const { values } = parse(args, {
        kind: { type: "string" },
        name: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        json: { type: "boolean" },
      });
      const kind = sbx.kind(values.kind);
      const s = await sbx.provider(kind.provider).create(
        {
          kind,
          name: values.name,
          repo: values.repo ? { source: values.repo, branch: values.branch } : undefined,
        },
        { onProgress: progress, signal: interruptible() },
      );
      if (values.json) json(describe(s));
      else print(`${s.name}  ${s.sshDest ?? ""}  ${s.info.url ?? ""}`.trimEnd());
      return 0;
    }

    case "ls": {
      const { values } = parse(args, { json: { type: "boolean" } });
      const list = await sbx.list();
      if (values.json) return json(list.map(describe));
      if (!list.length) return 0;
      print(
        table([
          ["NAME", "KIND", "STATUS", "REPO", "BRANCH", "USED", "KEEP", "ID"],
          ...list.map((s) => [
            s.name,
            s.kind,
            s.status,
            s.info.repo ?? "-",
            s.info.branch ?? "-",
            age(s.info.lastUsed),
            s.info.keep ? "yes" : "",
            s.id,
          ]),
        ]),
      );
      return 0;
    }

    case "exec": {
      const { values, positionals } = parse(args, { cwd: { type: "string" }, timeout: { type: "string" } });
      if (!after.length) throw new UsageError("usage: sbx exec <name> [--cwd d] -- <cmd...>");
      const s = await sandbox(sbx, positionals[0]);
      const result = await s.exec(commandLine(after), {
        cwd: values.cwd ?? s.info.workdir,
        timeoutMs: seconds(values.timeout),
        signal: interruptible(),
        capture: false,
        onStdout: (c) => void process.stdout.write(c),
        onStderr: (c) => void process.stderr.write(c),
      });
      return result.exitCode;
    }

    case "shell": {
      const s = await sandbox(sbx, args[0]);
      need(sbx.providerOf(s), "interactiveShell");
      if (!s.sshDest) throw new UnsupportedError(s.provider, "interactiveShell");
      const remote = after.length
        ? commandLine(after)
        : s.info.workdir
          ? `cd ${quote(s.info.workdir)} 2>/dev/null; exec "$SHELL" -l`
          : undefined;
      const r = spawnSync("ssh", ["-t", s.sshDest, ...(remote ? [remote] : [])], { stdio: "inherit" });
      return r.status ?? 1;
    }

    case "fork": {
      const { values, positionals } = parse(args, { name: { type: "string" }, json: { type: "boolean" } });
      const s = await sandbox(sbx, positionals[0]);
      const provider = sbx.providerOf(s);
      need(provider, "fork");
      const copy = await provider.fork(s, { name: values.name, kind: sbx.config.kinds[s.kind] }, { onProgress: progress });
      if (values.json) json(describe(copy));
      else print(copy.name);
      return 0;
    }

    case "pause":
    case "resume": {
      const s = await sandbox(sbx, args[0]);
      need(sbx.providerOf(s), "pause");
      await (command === "pause" ? s.pause() : s.resume());
      return 0;
    }

    case "rm": {
      if (!args.length) throw new UsageError("usage: sbx rm <name...>");
      for (const name of args) {
        const s = await sandbox(sbx, name);
        await sbx.providerOf(s).remove(s);
        print(`removed ${s.name}`);
      }
      return 0;
    }

    case "keep": {
      const s = await sandbox(sbx, args[0]);
      await s.setKeep(!s.info.keep);
      print(`${s.name}: ${s.info.keep ? "kept" : "reapable"}`);
      return 0;
    }

    case "url": {
      const s = await sandbox(sbx, args[0]);
      need(sbx.providerOf(s), "httpsUrl");
      print(s.url(args[1] === undefined ? undefined : Number(args[1])));
      return 0;
    }

    case "pull": {
      const { values, positionals } = parse(args, { repo: { type: "string" } });
      const [name, ...branches] = positionals;
      const s = await sandbox(sbx, name);
      if (!s.info.workdir) throw new Error(`${s.name} has no checkout`);
      const repo = resolve(values.repo ?? ".");
      const made = await s.exec(pullScript(s.info.workdir, branches));
      if (made.exitCode !== 0) throw new Error(`bundling on ${s.name} failed: ${made.stderr.trim()}`);
      const dir = await mkdtemp(join(tmpdir(), "sbx-"));
      try {
        const bundle = join(dir, "pull.bundle");
        await writeFile(bundle, await s.readFile(PULL_BUNDLE));
        const out = await fetchBundle(repo, bundle, s.name, branches);
        if (out) process.stderr.write(`${out}\n`);
      } finally {
        await rmPath(dir, { recursive: true, force: true });
        await s.exec(`rm -f ${PULL_BUNDLE}`).catch(() => undefined);
      }
      return 0;
    }

    case "github": {
      const { values, positionals } = parse(args, { readonly: { type: "boolean" } });
      const [sub, repo] = positionals;
      if (sub !== "add" || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo))
        throw new UsageError("usage: sbx github add <owner/repo> [--readonly]");
      const provider = sbx.provider(sbx.kind().provider);
      need(provider, "secretIntegrations");
      const name = await provider.integrations!.addGithub(repo, { readonly: values.readonly });
      print(`added integration ${name}, attached to every sbx sandbox`);
      print("(link your GitHub account once on exe.dev's Integrations page if this failed)");
      return 0;
    }

    case "template": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      const [sub, kindName] = positionals;
      if (sub === "build" || sub === "rm") {
        if (!kindName) throw new UsageError(`usage: sbx template ${sub} <kind>`);
        const kind = sbx.kind(kindName);
        const provider = sbx.provider(kind.provider);
        need(provider, "templates");
        if (sub === "rm") {
          print((await provider.templates!.remove(kind.name)) ? `removed template ${kind.name}` : `no template for ${kind.name}`);
          return 0;
        }
        const t = await provider.templates!.build(kind, { onProgress: progress, signal: interruptible() });
        print(`built ${t.id}`);
        return 0;
      }
      if (sub === "ls") {
        const kinds = Object.values(sbx.config.kinds);
        const all = [];
        for (const id of sbx.providerIds()) {
          const p = sbx.provider(id);
          if (p.capabilities().templates) all.push(...(await p.templates!.list(kinds.filter((k) => k.provider === id))));
        }
        if (values.json) return json(all);
        if (all.length)
          print(table([["KIND", "ID", "AGE", "CURRENT"], ...all.map((t) => [t.kind, t.id, age(t.created), t.current ? "yes" : "stale"])]));
        return 0;
      }
      throw new UsageError("usage: sbx template build|ls|rm");
    }

    case "run": {
      const { values } = parse(args, {
        kind: { type: "string" },
        name: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },
        artifacts: { type: "string", multiple: true },
        out: { type: "string" },
        keep: { type: "boolean" },
        timeout: { type: "string" },
      });
      if (!after.length) throw new UsageError("usage: sbx run [--kind job] -- <cmd...>");
      const kind = sbx.kind(values.kind ?? (sbx.config.kinds.job ? "job" : undefined));
      const provider = sbx.provider(kind.provider);
      const signal = interruptible();
      const s = await provider.create(
        { kind, name: values.name, repo: values.repo ? { source: values.repo, branch: values.branch } : undefined },
        { onProgress: progress, signal },
      );
      let code = 1;
      try {
        progress(`running on ${s.name}`);
        const result = await s.exec(commandLine(after), {
          cwd: s.info.workdir,
          timeoutMs: seconds(values.timeout),
          signal,
          capture: false,
          onStdout: (c) => void process.stdout.write(c),
          onStderr: (c) => void process.stderr.write(c),
        });
        code = result.exitCode;
        for (const path of values.artifacts ?? []) {
          const remote = path.startsWith("/") || !s.info.workdir ? path : `${s.info.workdir}/${path}`;
          const local = join(resolve(values.out ?? "sbx-artifacts"), s.name, path.replace(/^\/+/, ""));
          progress(`downloading ${remote} to ${local}`);
          await s.download(remote, local).catch((error) => progress(`could not download ${remote}: ${(error as Error).message}`));
        }
      } finally {
        if (values.keep) progress(`kept ${s.name}`);
        else {
          progress(`removing ${s.name}`);
          await provider.remove(s);
        }
      }
      return code;
    }

    case "reap": {
      const { values } = parse(args, {
        days: { type: "string" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        "if-configured": { type: "boolean" },
      });
      // The scheduled reaper runs on machines that may never have set sbx up.
      if (values["if-configured"] && !process.env.EXE_TOKEN && !existsSync(keyPath())) return 0;
      const days = values.days ? Number(values.days) : sbx.config.reap.days;
      if (!(days > 0)) throw new UsageError("--days must be positive");
      const result = await reap(sbx, { days, dryRun: values["dry-run"] });
      if (values.json) json(result);
      else {
        for (const name of result.removed) print(`${values["dry-run"] ? "would remove" : "removed"} ${name}`);
        for (const f of result.failed) progress(`could not remove ${f.name}: ${f.error}`);
      }
      return result.failed.length ? 1 : 0;
    }

    default:
      throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof UsageError) die(error.message, 2);
    die(error instanceof Error ? error.message : String(error));
  },
);
