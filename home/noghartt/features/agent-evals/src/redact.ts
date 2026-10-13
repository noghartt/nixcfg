// Secrets are scrubbed before anything reaches the database, so labels, reports and
// exports never see them. Patterns favour false positives: a redacted log line costs
// little, a leaked token in a fine-tuning file costs a rotation.

interface Rule {
	kind: string;
	re: RegExp;
	secretGroup?: number;
}

const RULES: Rule[] = [
	{ kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
	{ kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
	{ kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g },
	{ kind: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
	{ kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "onepassword-token", re: /\bops_[A-Za-z0-9_-]{20,}/g },
	{ kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ kind: "auth-header", re: /\b((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?)((?:bearer|basic|token|bot)\s+)?([^\s"',;]{6,})/gi, secretGroup: 3 },
	{ kind: "bearer", re: /\b(bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi, secretGroup: 2 },
	{ kind: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, secretGroup: 2 },
	{
		kind: "assignment",
		re: /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?token)\b["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{8,})/gi,
		secretGroup: 2,
	},
];

const MARK = /^\[REDACTED:[a-z-]+\]$/;

export function redact(text: string): string {
	if (!text) return text;
	let out = text;
	for (const rule of RULES) {
		out = out.replace(rule.re, (...m: unknown[]) => {
			const match = m[0] as string;
			if (!rule.secretGroup) return `[REDACTED:${rule.kind}]`;
			const groups = m.slice(1, -2) as (string | undefined)[];
			const secretIndex = rule.secretGroup - 1;
			const secret = groups[secretIndex];
			if (!secret || MARK.test(secret) || secret.startsWith("[REDACTED")) return match;
			return groups.map((g, i) => (i === secretIndex ? `[REDACTED:${rule.kind}]` : (g ?? ""))).join("");
		});
	}
	return out;
}

export function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = /^(?:authorization|api[_-]?key|token|password|secret)$/i.test(k) && typeof v === "string" ? "[REDACTED:field]" : redactDeep(v);
		}
		return out as T;
	}
	return value;
}

/** Home paths carry the account name; exports replace them. */
export function scrubHome(text: string): string {
	return text.replace(/\/(?:home|Users)\/[^/\s"'`]+/g, "~");
}
