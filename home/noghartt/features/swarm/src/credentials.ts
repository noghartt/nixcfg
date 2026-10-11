// Pod members use the host's subscription logins without holding a refresh token. Only the
// host refreshes (the leader session touches each provider's auth, so OmO's own locked refresh
// runs there); swarmd copies the current access tokens into every pod whenever auth.json
// changes. Expiry is stretched by a few minutes: Pi stores it five minutes early, and a member
// that finds its token "expired" re-reads auth.json before refreshing, so the stretch covers
// the gap until the host's refreshed token lands.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STRETCH_MS = 4 * 60_000;
const NO_REFRESH = "swarm-managed-no-refresh";

type AuthEntry = { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown } | { type: "api_key"; key: string };

export function hostAuthPath(): string {
	return join(process.env.OMO_CODING_AGENT_DIR || join(homedir(), ".omo", "agent"), "auth.json");
}

export async function podAuth(billing: Record<string, string>): Promise<string> {
	const host = JSON.parse(await readFile(hostAuthPath(), "utf8").catch(() => "{}")) as Record<string, AuthEntry>;
	const out: Record<string, AuthEntry> = {};
	for (const [provider, entry] of Object.entries(host)) {
		if (billing[provider]) continue;
		if (entry.type === "oauth") out[provider] = { ...entry, refresh: NO_REFRESH, expires: entry.expires + STRETCH_MS };
		else out[provider] = entry;
	}
	for (const [provider, placeholder] of Object.entries(billing)) out[provider] = { type: "api_key", key: placeholder };
	return `${JSON.stringify(out, null, 2)}\n`;
}

export function podSettings(model: string, thinking: string): string {
	const slash = model.indexOf("/");
	return `${JSON.stringify(
		{
			defaultProvider: model.slice(0, slash),
			defaultModel: model.slice(slash + 1),
			defaultThinkingLevel: thinking,
			quietStartup: true,
			collapseChangelog: true,
			tips: false,
			packages: [],
		},
		null,
		2,
	)}\n`;
}

export const BILLING_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
