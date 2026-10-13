#!/usr/bin/env bun
import { classifyHeuristic, classifyLlm, unlabeledItems } from "./classify.ts";
import { openDb } from "./db.ts";
import { exportDataset } from "./export.ts";
import { ingest } from "./ingest.ts";
import { dbPath, priorsPath, stateDir } from "./paths.ts";
import { computePriors, writePriors } from "./priors.ts";
import { replay, resolveTask } from "./replay.ts";
import { report } from "./report.ts";
import type { Dim } from "./stats.ts";
import { parseSince } from "./stats.ts";
import { runLabelUi, type View } from "./tui.ts";
import type { Source } from "./types.ts";

const USAGE = `aeval - evaluate agent sessions: ingest, label, classify, report, priors, export, replay

  aeval ingest [--force] [--source omo,pi,claude,codex] [--include-sdk] [--quiet]
      import new or changed transcripts and the orchestrator outcome log
  aeval label [--view sessions|nodes|replays]
      terminal UI to rate sessions/turns/nodes/replays, set task classes, notes and preferred answers
  aeval classify [--all] [--llm [--harness omo|pi] [--model provider/id] [--batch N] [--limit N]]
      heuristic task-class suggestions; --llm adds a print-mode model pass (cheapest pool tier by default)
  aeval report [--by model,pool,class,pool-class] [--since 30d] [--source omo] [--format md|json]
  aeval priors [--since 90d] [--min-n N] [--stdout]
      write priors.json (contract C3) from outcomes and labels
  aeval export --format sft|preference --provider openai|anthropic [--out DIR] [--include-good-sessions]
               [--system summarize|strip] [--max-example-bytes N] [--max-total-bytes N] [--max-tool-chars N] [--limit N]
  aeval replay (--node RUN/NODE | --session ID) --models m1[:thinking],m2 [--harness omo|pi]
               [--repo PATH] [--base REV] [--sandbox [--net PROFILE] [--size CLASS]] [--timeout 30m] [--dry-run]
  aeval paths

State: ${stateDir()}`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; flags: Flags; rest: string[] } {
	const [cmd = "help", ...args] = argv;
	const flags: Flags = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--")) {
			rest.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
		else if (i + 1 < args.length && !args[i + 1].startsWith("--") && !BOOLEAN.has(a.slice(2))) flags[a.slice(2)] = args[++i];
		else flags[a.slice(2)] = true;
	}
	return { cmd, flags, rest };
}

const BOOLEAN = new Set(["force", "include-sdk", "quiet", "all", "llm", "stdout", "include-good-sessions", "sandbox", "dry-run", "help"]);

const flag = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const intFlag = (f: Flags, k: string) => {
	const v = flag(f, k);
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) throw new Error(`--${k} expects a non-negative integer`);
	return n;
};
function duration(v: string | undefined): number | undefined {
	if (!v) return undefined;
	const m = /^(\d+)(s|m|h)?$/.exec(v);
	if (!m) throw new Error(`expected a duration like 90s, 30m or 2h, got ${v}`);
	return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3 }[(m[2] ?? "s") as "s" | "m" | "h"];
}
function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], name: string): T | undefined {
	if (v === undefined) return undefined;
	if (!allowed.includes(v as T)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
	return v as T;
}

async function main(argv: string[]): Promise<number> {
	const { cmd, flags } = parseArgs(argv);
	if (cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
		console.log(USAGE);
		return 0;
	}
	if (cmd === "paths") {
		console.log(JSON.stringify({ state: stateDir(), db: dbPath(), priors: priorsPath() }, null, 2));
		return 0;
	}
	const db = openDb();
	try {
		switch (cmd) {
			case "ingest": {
				const sources = flag(flags, "source")
					?.split(",")
					.map((x) => oneOf(x.trim(), ["omo", "pi", "claude", "codex"] as const, "source")!) as Source[] | undefined;
				const started = Date.now();
				const st = ingest(db, { force: !!flags.force, includeSdk: !!flags["include-sdk"], sources });
				classifyHeuristic(db, unlabeledItems(db));
				if (!flags.quiet || st.errors.length) {
					console.log(
						`scanned ${st.scanned} files: ${st.updated} updated, ${st.unchanged} unchanged, ${Object.values(st.skipped).reduce((a, b) => a + b, 0)} skipped; outcomes +${st.outcomes.added}${st.outcomes.bad ? ` (${st.outcomes.bad} invalid lines)` : ""} in ${Date.now() - started}ms`,
					);
					for (const [why, n] of Object.entries(st.skipped)) console.log(`  skipped ${n}: ${why}`);
					for (const e of st.errors.slice(0, 20)) console.error(`  error: ${e}`);
				}
				return st.errors.length ? 1 : 0;
			}
			case "label":
				await runLabelUi(db, oneOf(flag(flags, "view"), ["sessions", "nodes", "replays"] as const, "view") as View | undefined);
				return 0;
			case "classify": {
				const items = unlabeledItems(db, { all: !!flags.all });
				const n = classifyHeuristic(db, items);
				console.log(`heuristic suggestions: ${n}`);
				if (flags.llm) {
					const limit = intFlag(flags, "limit");
					const harness = oneOf(flag(flags, "harness"), ["omo", "pi"] as const, "harness") ?? "omo";
					const r = classifyLlm(db, limit ? items.slice(0, limit) : items, { harness, model: flag(flags, "model"), batch: intFlag(flags, "batch") });
					console.log(`llm suggestions: ${r.done} (failed ${r.failed}); review them with aeval label (a accepts a suggestion)`);
					for (const e of r.errors.slice(0, 5)) console.error(`  error: ${e}`);
					return r.done || !r.failed ? 0 : 1;
				}
				return 0;
			}
			case "report": {
				const by = flag(flags, "by")
					?.split(",")
					.map((x) => oneOf(x.trim(), ["model", "pool", "class", "pool-class"] as const, "by")!) as Dim[] | undefined;
				console.log(
					report(db, {
						by,
						since: parseSince(flag(flags, "since")),
						source: flag(flags, "source"),
						format: oneOf(flag(flags, "format"), ["md", "json"] as const, "format") ?? "md",
					}),
				);
				return 0;
			}
			case "priors": {
				const priors = computePriors(db, { since: parseSince(flag(flags, "since")), minN: intFlag(flags, "min-n") });
				if (flags.stdout) console.log(JSON.stringify(priors, null, 2));
				else console.log(`wrote ${writePriors(priors)} (${priors.models.length} entries)`);
				return 0;
			}
			case "export": {
				const format = oneOf(flag(flags, "format"), ["sft", "preference"] as const, "format");
				const provider = oneOf(flag(flags, "provider"), ["openai", "anthropic"] as const, "provider");
				if (!format || !provider) throw new Error("export needs --format sft|preference and --provider openai|anthropic");
				const r = exportDataset(db, {
					format,
					provider,
					out: flag(flags, "out"),
					includeGoodSessions: !!flags["include-good-sessions"],
					system: oneOf(flag(flags, "system"), ["summarize", "strip"] as const, "system"),
					maxExampleBytes: intFlag(flags, "max-example-bytes"),
					maxTotalBytes: intFlag(flags, "max-total-bytes"),
					maxToolChars: intFlag(flags, "max-tool-chars"),
					limit: intFlag(flags, "limit"),
				});
				console.log(`${r.examples} examples in ${r.dir}${Object.keys(r.skipped).length ? `; skipped ${JSON.stringify(r.skipped)}` : ""}`);
				return 0;
			}
			case "replay": {
				const models = flag(flags, "models")
					?.split(",")
					.map((m) => m.trim())
					.filter(Boolean);
				if (!models?.length) throw new Error("replay needs --models provider/id[:thinking],...");
				const task = resolveTask(db, { node: flag(flags, "node"), session: flag(flags, "session") });
				const group = replay(db, task, {
					models,
					harness: oneOf(flag(flags, "harness"), ["omo", "pi"] as const, "harness") ?? "omo",
					base: flag(flags, "base"),
					repo: flag(flags, "repo"),
					sandbox: !!flags.sandbox,
					net: flag(flags, "net"),
					size: flag(flags, "size"),
					timeoutMs: duration(flag(flags, "timeout")),
					dryRun: !!flags["dry-run"],
					log: (l) => console.log(l),
				});
				if (!flags["dry-run"]) console.log(`compare with: aeval label --view replays   (group ${group})`);
				return 0;
			}
			default:
				console.error(`unknown command: ${cmd}\n\n${USAGE}`);
				return 2;
		}
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			console.error(`aeval: ${(e as Error).message}`);
			process.exit(1);
		},
	);
}

export { main, parseArgs };
