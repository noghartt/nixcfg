import { describe, expect, test } from "bun:test";
import { redact, redactDeep, scrubHome } from "./redact.ts";

describe("redact", () => {
	const cases: [string, string, string][] = [
		["anthropic key", "key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX here", "sk-ant-api03"],
		["openai key", "OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz0123", "sk-proj-abc"],
		["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abc"],
		["github pat", "github_pat_11ABCDEFG0123456789_abcdefghijk", "github_pat_11"],
		["aws key", "AKIAABCDEFGHIJKLMNOP", "AKIAABCD"],
		["slack token", "xoxb-1234567890-abcdefghij", "xoxb-12345"],
		["1password token", "ops_eyJhbGciOiJFUzI1NiIsImtpZCI6", "ops_eyJ"],
		["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNry"],
		["bearer", "curl -H 'Authorization: Bearer abc.def-ghi_jkl012345678'", "abc.def-ghi"],
		["auth header value", '{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}', "dXNlcjpw"],
		["url credentials", "https://user:hunter2secret@example.com/x", "hunter2secret"],
		["assignment", "API_KEY=abcd1234efgh5678 and password: 'correct horse battery'", "abcd1234efgh"],
		["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
	];
	for (const [name, input, secret] of cases) {
		test(name, () => {
			const out = redact(input);
			expect(out).not.toContain(secret);
			expect(out).toContain("[REDACTED:");
		});
	}

	test("keeps ordinary prose and is idempotent", () => {
		const prose = "The token budget is 2000 and the password prompt appears on login.";
		expect(redact(prose)).toBe(prose);
		const once = redact("API_KEY=abcd1234efgh5678");
		expect(redact(once)).toBe(once);
		expect(once).toBe("API_KEY=[REDACTED:assignment]");
	});

	test("redactDeep covers nested values and secret-named fields", () => {
		const out = redactDeep({ headers: { Authorization: "x" }, args: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"], n: 3 });
		expect(out).toEqual({ headers: { Authorization: "[REDACTED:field]" }, args: ["[REDACTED:github-token]"], n: 3 });
	});

	test("scrubHome hides the account name", () => {
		expect(scrubHome("/home/alice/www/x and /Users/bob/y")).toBe("~/www/x and ~/y");
	});
});
