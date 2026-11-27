// `pi-durable accounts`: sign extra Claude accounts in, list them with their blocks, remove them.

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createProcessLoginTerminal, type LoginTerminal } from "#pi/cli/auth-terminal.js";
import { getAgentDir, SettingsManager } from "#pi/index.js";
import { displayUrl, webUrl } from "#pi/utils/web-url.js";
import {
	accountState,
	blockText,
	extraAccountNames,
	loginAccount,
	MAIN_ACCOUNT,
	removeAccount,
	signedIn,
	validAccountName,
} from "./accounts.ts";
import { configureHarnessHttp } from "./harness-setup.ts";

export const ACCOUNTS_USAGE = `Usage: pi-durable accounts list
       pi-durable accounts login <name> [--no-browser]
       pi-durable accounts remove <name>

Claude accounts to fall back on when one hits its usage limit. "main" is the agent dir's
own login (pi auth login anthropic); each other account keeps its own auth.json under
<agent dir>/accounts/<name>/ and is tried in the order it was added. Inside pi-durable,
/accounts does the same (add, remove) and signs the agent dir in to other providers.`;

/** Login prompts and events on the terminal, as \`pi auth login\` shows them; the browser sign-in is picked unless refused. */
function interaction(terminal: LoginTerminal, browser: boolean, signal: AbortSignal): AuthInteraction {
	const select = async (prompt: Extract<AuthPrompt, { type: "select" }>, promptSignal: AbortSignal) => {
		const [first, ...others] = prompt.options;
		if (browser && first !== undefined) return first.id;
		const options = others.length > 0 ? others : prompt.options;
		if (options.length === 1) return options[0]!.id;
		terminal.write(prompt.message);
		options.forEach((option, index) => terminal.write(`  ${index + 1}. ${option.label}`));
		for (;;) {
			const answer = (await terminal.question(`Select 1-${options.length}: `, promptSignal)).trim();
			const option = /^\d+$/u.test(answer) ? options[Number(answer) - 1] : undefined;
			if (option !== undefined) return option.id;
		}
	};
	return {
		signal,
		prompt(prompt) {
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			if (prompt.type === "select") return select(prompt, promptSignal);
			const message = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
			return prompt.type === "secret" ? terminal.secret(message, promptSignal) : terminal.question(message, promptSignal);
		},
		notify(event) {
			if (event.type === "auth_url") {
				terminal.write(`Open this URL to sign in:\n  ${displayUrl(event.url)}`);
				if (event.instructions) terminal.write(event.instructions);
				const target = webUrl(event.url);
				if (target !== undefined && browser) terminal.openUrl(target);
			} else if (event.type === "device_code") {
				terminal.write(`Open ${displayUrl(event.verificationUri)} and enter code: ${event.userCode}`);
				const target = webUrl(event.verificationUri);
				if (target !== undefined && browser && event.openBrowserOnConfirm !== false) terminal.openUrl(target);
			} else {
				terminal.write(event.message);
			}
		},
	};
}

async function login(name: string, browser: boolean): Promise<number> {
	const agentDir = getAgentDir();
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	const terminal = createProcessLoginTerminal(interrupt);
	if (!terminal.interactive) {
		terminal.error("accounts login needs an interactive terminal");
		return 1;
	}
	const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	configureHarnessHttp(settings);
	process.on("SIGINT", interrupt);
	let authPath: string;
	try {
		authPath = await loginAccount(name, interaction(terminal, browser, controller.signal), {
			agentDir,
			getDeviceId: () => settings.getOrCreateDeviceId(),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		terminal.error(controller.signal.aborted || message === "Login cancelled" ? "Login cancelled." : `Login failed: ${message}`);
		return 1;
	} finally {
		process.off("SIGINT", interrupt);
	}
	terminal.write(`Signed Claude account "${name}" in; credentials saved to ${authPath}`);
	return 0;
}

function list(): number {
	const agentDir = getAgentDir();
	const blocks = accountState(agentDir).read();
	const now = Date.now();
	const names = [MAIN_ACCOUNT, ...extraAccountNames(agentDir)];
	for (const name of names) {
		const state = blockText(blocks[name], now) ?? "free";
		console.log(`${name.padEnd(16)} ${(signedIn(name, agentDir) ? "signed in" : "not signed in").padEnd(14)} ${state}`);
	}
	if (names.length === 1) console.log(`\nNo extra accounts; add one with pi-durable accounts login <name>.`);
	return 0;
}

function remove(name: string): number {
	if (name === MAIN_ACCOUNT) {
		console.error(`"main" is the agent dir's own login; sign it out with pi auth logout anthropic.`);
		return 1;
	}
	removeAccount(name);
	console.log(`Removed Claude account "${name}".`);
	return 0;
}

export async function runAccounts(args: readonly string[]): Promise<number> {
	const [command, name, ...rest] = args;
	if (command === "list" && name === undefined) return list();
	if ((command === "login" || command === "remove") && name !== undefined) {
		if (!validAccountName(name)) {
			console.error(`Account names are lowercase letters, digits, - and _ (up to 32): ${name}`);
			return 2;
		}
		if (command === "remove" && rest.length === 0) return remove(name);
		if (command === "login" && rest.every((arg) => arg === "--no-browser")) return login(name, rest.length === 0);
	}
	const help = command === undefined || command === "--help" || command === "-h";
	(help ? console.log : console.error)(ACCOUNTS_USAGE);
	return help ? 0 : 2;
}
