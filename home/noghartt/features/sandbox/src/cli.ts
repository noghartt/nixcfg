// `sbx`: the command-line face of the library. Provider-agnostic: it branches
// on capabilities only (auth setup is exe.dev's, the one provider so far).
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import "./builtin.ts";
import { configPath, loadConfig } from "./config.ts";
import { createSandbox, pullBranches } from "./core.ts";
import { addKeyInstruction, authPaths, configured, generateCommand, parseToken, setupKey, storeToken } from "./providers/exe-auth.ts";
import { type Sandbox, type SandboxProvider, NotFoundError, UnsupportedError } from "./provider.ts";
import { reap } from "./reap.ts";
import { Sbx } from "./registry.ts";
import { commandLine, quote } from "./shell.ts";

const USAGE = `usage: sbx <command> [options]

  auth setup [--key]                 store the exe.dev token (or make a signing key)
  kinds [--json]                     list sandbox kinds
  integrations                       print the commands attaching kinds' integrations
  create [--kind k] [--name n] [--repo path|owner/repo] [--branch b] [--json]
  ls [--json]                        list sandboxes
  exec <name> [--cwd d] [--timeout s] [--stdin] -- <cmd...>
  shell <name> [-- <cmd...>]         interactive ssh
  fork <name> [--name n] [--json]
  pause|resume|rm <name>
  keep <name>                        toggle exemption from reaping
  url <name> [port]
  pull <name> [branch...] [--repo path]
                                     fetch branches as sbx/<name>/<branch>
  github add <owner/repo> [--readonly]
                                     print the command giving sandboxes the repo
  template build <kind> | ls [--json] | rm <kind>
  run [--kind job] [--repo r] [--branch b] [--artifacts path] [--out dir] [--keep] [--timeout s] -- <cmd...>
  reap [--days n] [--dry-run] [--json] [--if-configured]

config: ${configPath()}`;

class UsageError extends Error {}

const err = (message: string) => void process.stderr.write(`sbx: ${message}\n`);
const progress = err;

// One controller for the process: Ctrl-C, SIGTERM, SIGHUP and a closed stdout
// all cancel the operation (and the remote command), so cleanup runs.
const controller = new AbortController();
/** A sandbox `run` still has to remove, reported if a second signal forces an exit. */
let pending: Sandbox | undefined;
let stdoutClosed = false;
const closed = new Promise<void>((resolve) => {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    stdoutClosed = true;
    controller.abort(new Error("stdout closed"));
    resolve();
  });
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    if (controller.signal.aborted) {
      if (pending) err(`${pending.name} (${pending.id}) was not removed; run: sbx rm ${pending.name}`);
      process.exit(130);
    }
    if (sig === "SIGINT") err("interrupted; stopping (Ctrl-C again to quit now)");
    controller.abort(new Error(`interrupted by ${sig}`));
  });

/** Writes with backpressure: the remote stream waits while the terminal or pipe is full. */
function writer(stream: NodeJS.WriteStream) {
  return (chunk: string): void | Promise<void> => {
    if (stream === process.stdout && stdoutClosed) return;
    if (stream.write(chunk)) return;
    return Promise.race([once(stream, "drain").then(() => undefined), closed]);
  };
}
const print = (line: string) => void writer(process.stdout)(`${line}\n`);
const json = (value: unknown) => (print(JSON.stringify(value, null, 2)), 0);

function describe(s: Sandbox) {
  return { name: s.name, id: s.id, provider: s.provider, kind: s.kind, status: s.status, sshDest: s.sshDest, ...s.info };
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
  if (!(n > 0)) throw new UsageError("--timeout must be a positive number of seconds");
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

const streams = { onStdout: writer(process.stdout), onStderr: writer(process.stderr) };

function exeAuthPaths(sbx: Sbx) {
  const exe = Object.values(sbx.config.providers).find((p) => (p.type ?? "exe") === "exe") ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return authPaths(process.env, { token: str(exe.token), key: str(exe.key) });
}

function integrationCommands(sbx: Sbx): string[] {
  const commands: string[] = [];
  for (const kind of Object.values(sbx.config.kinds)) {
    const provider = sbx.provider(kind.provider);
    if (provider.capabilities().secretIntegrations && kind.integrations.length) commands.push(...provider.integrations!.kindCommands(kind));
  }
  return commands;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return command ? 0 : 2;
  }
  const { args, rest: after } = split(rest);
  const sbx = new Sbx(loadConfig());
  const signal = controller.signal;

  switch (command) {
    case "auth": {
      const { values, positionals } = parse(args, { key: { type: "boolean" } });
      if (positionals[0] !== "setup") throw new UsageError("usage: sbx auth setup [--key]");
      const paths = exeAuthPaths(sbx);
      if (values.key) {
        const { created } = await setupKey(paths.key);
        print(created ? `created ${paths.key}` : `${paths.key} already exists`);
        print(`register it once, scoped to sbx's VMs (with your own exe.dev key):\n  ${addKeyInstruction(paths.key)}`);
      } else {
        const generate = generateCommand();
        if (process.stdin.isTTY) {
          print(`make sbx's token with your own exe.dev key, scoped to sbx's VMs:\n  ${generate}`);
          print("then paste the token (or the JSON it printed) and press Enter, or pipe it:");
          print(`  ${generate} | sbx auth setup`);
          const [line] = (await once(process.stdin.setEncoding("utf8"), "data")) as [string];
          process.stdin.pause();
          await storeToken(paths.token, parseToken(line));
        } else await storeToken(paths.token, parseToken(await text(process.stdin)));
        print(`stored the token in ${paths.token}`);
      }
      const commands = integrationCommands(sbx);
      if (commands.length) print(`attach the kinds' integrations once:\n${commands.map((c) => `  ${c}`).join("\n")}`);
      return 0;
    }

    case "integrations": {
      for (const c of integrationCommands(sbx)) print(c);
      return 0;
    }

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
      const s = await createSandbox(
        sbx.provider(kind.provider),
        { kind, name: values.name, repo: values.repo ? { source: values.repo, branch: values.branch } : undefined },
        { onProgress: progress, signal },
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
      const { values, positionals } = parse(args, { cwd: { type: "string" }, timeout: { type: "string" }, stdin: { type: "boolean" } });
      if (!after.length) throw new UsageError("usage: sbx exec <name> [--cwd d] -- <cmd...>");
      const timeoutMs = seconds(values.timeout);
      const s = await sandbox(sbx, positionals[0]);
      const stdin = values.stdin ? new Uint8Array(Buffer.from(await text(process.stdin))) : undefined;
      await s.touch();
      const result = await s.exec(commandLine(after), {
        cwd: values.cwd ?? s.info.workdir,
        timeoutMs,
        signal,
        capture: false,
        stdin,
        ...streams,
      });
      return result.exitCode;
    }

    case "shell": {
      const s = await sandbox(sbx, args[0]);
      need(sbx.providerOf(s), "interactiveShell");
      if (!s.sshDest) throw new UnsupportedError(s.provider, "interactiveShell");
      await s.touch();
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
      const copy = await provider.fork(s, { name: values.name, kind: sbx.config.kinds[s.kind] }, { onProgress: progress, signal });
      if (values.json) json(describe(copy));
      else print(copy.name);
      return 0;
    }

    case "pause":
    case "resume": {
      const s = await sandbox(sbx, args[0]);
      need(sbx.providerOf(s), "pause");
      await (command === "pause" ? s.pause() : s.resume());
      if (command === "resume") await s.touch();
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
      await s.touch();
      const { fetched, output } = await pullBranches(s, resolve(values.repo ?? "."), branches, { signal });
      if (output) err(output);
      if (!fetched) err(`${s.name} has nothing new`);
      return 0;
    }

    case "github": {
      const { values, positionals } = parse(args, { readonly: { type: "boolean" } });
      const [sub, repo] = positionals;
      if (sub !== "add" || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo))
        throw new UsageError("usage: sbx github add <owner/repo> [--readonly]");
      const provider = sbx.provider(sbx.kind().provider);
      need(provider, "secretIntegrations");
      print("run once with your own exe.dev key (link GitHub on exe.dev's Integrations page first):");
      for (const c of provider.integrations!.githubCommands(repo, { readonly: values.readonly })) print(`  ${c}`);
      return 0;
    }

    case "template": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      const [sub, kindName] = positionals;
      const withTemplates = sbx.providerIds().map((id) => sbx.provider(id)).filter((p) => p.capabilities().templates);
      if (sub === "build") {
        if (!kindName) throw new UsageError("usage: sbx template build <kind>");
        const kind = sbx.kind(kindName);
        const provider = sbx.provider(kind.provider);
        need(provider, "templates");
        const t = await provider.templates!.build(kind, { onProgress: progress, signal });
        print(`built ${t.id}`);
        return 0;
      }
      if (sub === "rm") {
        // By name, so templates of kinds since removed from the config can go too.
        if (!kindName) throw new UsageError("usage: sbx template rm <kind>");
        let removed = false;
        for (const p of withTemplates) removed = (await p.templates!.remove(kindName)) || removed;
        print(removed ? `removed template ${kindName}` : `no template for ${kindName}`);
        return 0;
      }
      if (sub === "ls") {
        const kinds = Object.values(sbx.config.kinds);
        const all = [];
        for (const p of withTemplates) all.push(...(await p.templates!.list(kinds)));
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
      const timeoutMs = seconds(values.timeout);
      const kind = sbx.kind(values.kind ?? (sbx.config.kinds.job ? "job" : undefined));
      const provider = sbx.provider(kind.provider);
      const s = await createSandbox(
        provider,
        { kind, name: values.name, repo: values.repo ? { source: values.repo, branch: values.branch } : undefined },
        { onProgress: progress, signal },
      );
      pending = values.keep ? undefined : s;
      let code = 1;
      try {
        progress(`running on ${s.name}`);
        const result = await s.exec(commandLine(after), { cwd: s.info.workdir, timeoutMs, signal, capture: false, ...streams });
        code = result.exitCode;
        for (const path of values.artifacts ?? []) {
          const remote = path.startsWith("/") || !s.info.workdir ? path : `${s.info.workdir}/${path}`;
          const local = join(resolve(values.out ?? "sbx-artifacts"), s.name, path.replace(/^\/+/, ""));
          progress(`downloading ${remote} to ${local}`);
          await s.download(remote, local, { signal }).catch((e) => progress(`could not download ${remote}: ${(e as Error).message}`));
        }
      } finally {
        if (values.keep) progress(`kept ${s.name}`);
        else {
          progress(`removing ${s.name}`);
          await provider.remove(s);
          pending = undefined;
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
      if (values["if-configured"] && !configured(process.env, exeAuthPaths(sbx))) return 0;
      const days = values.days ? Number(values.days) : sbx.config.reap.days;
      if (!(days > 0)) throw new UsageError("--days must be positive");
      const result = await reap(sbx, { days, dryRun: values["dry-run"], onProgress: progress });
      if (values.json) json(result);
      else {
        for (const name of result.swept) print(`swept half-made VM ${name}`);
        for (const name of result.removed) print(`${values["dry-run"] ? "would remove" : "removed"} ${name}`);
        for (const s of result.skipped) print(`kept ${s.name}: ${s.reason}`);
        for (const f of result.failed) err(`could not remove ${f.name}: ${f.error}`);
      }
      return result.failed.length ? 1 : 0;
    }

    default:
      throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
  }
}

// exitCode, not exit(): output still queued for a slow pipe gets written.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    err(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : controller.signal.aborted ? 130 : 1;
  },
);
