// /accounts in the TUI: every login by provider with its email and block, argument completions, and pi's login dialog
// wired to an AuthInteraction. The sign-in itself is shared with `pi-durable accounts` (src/accounts.ts).

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { LoginDialogComponent } from "#pi/index.js";
import { theme } from "#pi/modes/interactive/theme/theme.js";
import { type AccountRow, accountsOverview, blockText, MAIN_ACCOUNT, type OverviewInput, type ProviderAccounts } from "./accounts.ts";
import { authFileEmails } from "./limits.ts";

export interface AccountView extends AccountRow {
	readonly email?: string;
}

export interface ProviderAccountsView extends Omit<ProviderAccounts, "accounts"> {
	readonly accounts: readonly AccountView[];
}

/** A provider pi can sign in to through OAuth, which `/accounts login` offers. */
export interface LoginProvider {
	readonly id: string;
	readonly name: string;
}

/**
 * The overview with each login's email, read the way /status and the statusline read them (`authFileEmails`, sharing
 * their per-token profile cache). `emails` replaces that lookup in tests.
 */
export async function loadAccounts(
	input: OverviewInput,
	emails: (authPath: string) => Promise<Record<string, string>> = (path) => authFileEmails(path),
): Promise<ProviderAccountsView[]> {
	const groups = accountsOverview(input);
	const files = new Map<string, Promise<Record<string, string>>>();
	const emailsOf = (path: string) => {
		let found = files.get(path);
		if (found === undefined) {
			found = emails(path).catch(() => ({}));
			files.set(path, found);
		}
		return found;
	};
	return Promise.all(
		groups.map(async (group) => ({
			...group,
			accounts: await Promise.all(
				group.accounts.map(async (row): Promise<AccountView> => {
					if (!row.signedIn) return row;
					const email = (await emailsOf(row.authPath))[row.provider];
					return email === undefined ? row : { ...row, email };
				}),
			),
		})),
	);
}

/** The /accounts panel's text. */
export function accountsLines(groups: readonly ProviderAccountsView[], now = Date.now()): string[] {
	const lines: string[] = [];
	for (const group of groups) {
		if (lines.length > 0) lines.push("");
		const pooled = group.accounts.some((row) => row.pooled);
		const title = group.name === group.id ? group.id : `${group.name} ${theme.fg("dim", `(${group.id})`)}`;
		lines.push(`${theme.bold(title)}${pooled ? theme.fg("dim", ` · ${group.accounts.length} accounts, falling back in this order`) : ""}`);
		for (const row of group.accounts) {
			const state = !row.signedIn
				? theme.fg("warning", "not signed in")
				: theme.fg("success", row.type === "api_key" ? "API key" : "signed in");
			const block = blockText(row.block, now);
			const parts = [
				state,
				row.email === undefined ? undefined : theme.fg("muted", row.email),
				row.pooled ? (block === undefined ? theme.fg("success", "free") : theme.fg("warning", block)) : undefined,
			].filter(Boolean);
			lines.push(`  ${row.active ? theme.fg("accent", "▸") : " "} ${row.name.padEnd(16)} ${parts.join(theme.fg("dim", " · "))}`);
		}
	}
	return lines;
}

export const ACCOUNTS_HINT = "/accounts add <name> · login <provider> · remove <name>";

export interface CompletionSources {
	/** The extra Claude accounts (not `main`). */
	accounts(): readonly string[];
	providers(): readonly LoginProvider[];
}

const SUBCOMMANDS: readonly AutocompleteItem[] = [
	{ value: "add ", label: "add", description: "Add a Claude account to fall back on at a usage limit (sign in)" },
	{ value: "login ", label: "login", description: "Sign this agent dir in to a provider (OAuth)" },
	{ value: "remove ", label: "remove", description: "Remove an extra Claude account" },
];

/** Completions for the text after `/accounts `: the subcommand, then a provider or an account name. */
export function accountsCompletions(argument: string, sources: CompletionSources): AutocompleteItem[] {
	const space = argument.indexOf(" ");
	if (space === -1) return SUBCOMMANDS.filter((item) => item.label.startsWith(argument));
	const command = argument.slice(0, space);
	const rest = argument.slice(space + 1).trimStart();
	if (command === "login") {
		return sources
			.providers()
			.filter((provider) => provider.id.startsWith(rest))
			.map((provider) => ({ value: `login ${provider.id}`, label: provider.id, description: provider.name }));
	}
	if (command === "remove" || command === "add") {
		// add offers the existing names too: adding one again signs it in again.
		return sources
			.accounts()
			.filter((name) => name !== MAIN_ACCOUNT && name.startsWith(rest))
			.map((name) => ({
				value: `${command} ${name}`,
				label: name,
				description: command === "add" ? "sign in again" : "Claude account",
			}));
	}
	return [];
}

/** What `/accounts <args>` asks for. */
export type AccountsCommand =
	| { readonly kind: "list" }
	| { readonly kind: "add"; readonly name: string }
	| { readonly kind: "login"; readonly provider: string }
	| { readonly kind: "remove"; readonly name: string }
	| { readonly kind: "usage"; readonly message: string };

export function parseAccountsCommand(args: string): AccountsCommand {
	const [command, target, ...rest] = args.split(/\s+/u).filter(Boolean);
	if (command === undefined || command === "list") return { kind: "list" };
	const usage = (message: string): AccountsCommand => ({ kind: "usage", message });
	if (rest.length > 0) return usage(`Usage: /accounts ${command} <${command === "login" ? "provider" : "name"}>`);
	if (command === "add" || command === "remove") {
		if (target === undefined) return usage(`Usage: /accounts ${command} <name>`);
		if (target === MAIN_ACCOUNT) {
			return usage(
				command === "add"
					? `"main" is the agent dir's own login; sign it in with /accounts login anthropic`
					: `"main" is the agent dir's own login and is not removed; sign it out with pi auth logout anthropic`,
			);
		}
		return { kind: command, name: target };
	}
	if (command === "login") {
		if (target === undefined) return usage("Usage: /accounts login <provider>");
		return { kind: "login", provider: target };
	}
	return usage(`Unknown /accounts command "${command}"; ${ACCOUNTS_HINT}`);
}

/**
 * An AuthInteraction on pi's login dialog, as pi's /login wires it: the URL (the dialog opens the browser), a pasted
 * code or other prompts in the dialog, and a method choice through `select`, which shows a list in its place.
 */
export function dialogInteraction(
	dialog: LoginDialogComponent,
	select: (prompt: Extract<AuthPrompt, { type: "select" }>) => Promise<string>,
): AuthInteraction {
	return {
		signal: dialog.signal,
		async prompt(prompt) {
			const response =
				prompt.type === "select"
					? select(prompt)
					: prompt.type === "manual_code"
						? dialog.showManualInput(prompt.message)
						: dialog.showPrompt(prompt.message, prompt.placeholder);
			// The browser callback can finish a step first, cancelling just that prompt.
			const signal = prompt.signal;
			if (signal === undefined) return response;
			if (signal.aborted) throw new Error("Login cancelled");
			let onAbort = (): void => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error("Login cancelled"));
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				return await Promise.race([response, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		notify(event) {
			if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
			else if (event.type === "device_code") {
				dialog.showDeviceCode(event);
				dialog.showWaiting("Waiting for authentication...");
			} else if (event.type === "info") dialog.showInfo(event.message, event.links);
			else dialog.showProgress(event.message);
		},
	};
}
