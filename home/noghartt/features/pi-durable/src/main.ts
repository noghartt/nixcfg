#!/usr/bin/env node
// pi-durable: a durable coding agent on the Durable library inside the installed Pi package, with pi's TUI pieces,
// settings, skills, and prompt templates. See docs/pi-durable.md.

import { VERSION } from "#pi/index.js";
import { runAccounts } from "./accounts-cli.ts";
import { type OpenDurableResult, openDurable } from "./runtime.ts";
import type { SessionTarget } from "./sessions.ts";
import { runDashboard, runDurableTui } from "./tui.ts";

const USAGE = `Usage: pi-durable [--continue | --session <dir>]
       pi-durable agents
       pi-durable accounts list | login <name> | remove <name>

A durable coding agent on @earendil-works/pi-durable ${VERSION}: every partial answer,
tool call, and queued message is committed to SQLite, so a killed process resumes
where it stopped. Shares pi's agent dir (auth, settings, models, AGENTS.md, skills,
prompt templates); Pi extensions are not loaded.

  -c, --continue        Reopen the newest session for the current directory
  -s, --session <dir>   Open the session in <dir> (as /resume lists them)
  agents                Every session and its agents, by project; enter opens one
  accounts              Claude accounts to fall back on at a usage limit (accounts --help)
  -h, --help            Show this help
  -v, --version         Show the Pi/Durable version`;

function parseArgs(argv: readonly string[]): SessionTarget | "agents" {
	if (argv[0] === "agents" || argv[0] === "--dashboard") return "agents";
	let target: SessionTarget = { kind: "new" };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--continue" || arg === "-c") target = { kind: "continue" };
		else if (arg === "--session" || arg === "-s") {
			const directory = argv[++index];
			if (directory === undefined) {
				console.error(`${arg} needs a session directory\n\n${USAGE}`);
				process.exit(2);
			}
			target = { kind: "open", directory };
		} else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else if (arg === "--version" || arg === "-v") {
			console.log(VERSION);
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
			process.exit(2);
		}
	}
	return target;
}

let durable: OpenDurableResult | undefined;
// A closed terminal or a kill still releases the session lock; unfinished work resumes with --continue.
for (const signal of ["SIGHUP", "SIGTERM"] as const) {
	process.once(signal, () => {
		void (durable?.close() ?? Promise.resolve()).finally(() => process.exit(128 + (signal === "SIGHUP" ? 1 : 15)));
	});
}

if (process.argv[2] === "accounts") process.exit(await runAccounts(process.argv.slice(3)));

// /new and /resume end the TUI with the session to open next; the open one closes first, its work kept for later.
const parsed = parseArgs(process.argv.slice(2));
let target: SessionTarget | undefined = parsed === "agents" ? await runDashboard() : parsed;
while (target !== undefined) {
	durable = await openDurable({ target });
	try {
		target = await runDurableTui(durable);
	} finally {
		await durable.close();
		durable = undefined;
	}
}
