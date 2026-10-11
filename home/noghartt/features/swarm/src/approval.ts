// Scope check for a member's tool calls. Inside its own worktree, /tmp, and the shared skill
// cache a member is trusted; destructive actions reaching past that need the user's double
// check. Pure functions so the member extension and tests share one classifier.

import { isAbsolute, normalize, resolve } from "node:path";

export interface Scope {
	worktree: string;
	home: string;
	extra: string[];
}

export interface Verdict {
	outOfScope: boolean;
	reason: string;
}

const IN_SCOPE: Verdict = { outOfScope: false, reason: "" };

function expand(path: string, scope: Scope, cwd: string): string {
	const home = path === "~" || path.startsWith("~/") ? `${scope.home}${path.slice(1)}` : path;
	return normalize(isAbsolute(home) ? home : resolve(cwd, home));
}

export function inScopePath(path: string, scope: Scope, cwd: string): boolean {
	const target = expand(path, scope, cwd);
	const roots = [scope.worktree, "/tmp", "/private/tmp", "/var/folders", ...scope.extra].map((root) => normalize(root));
	return roots.some((root) => target === root || target.startsWith(`${root}/`));
}

// Rough shell tokenizer: enough to find command words and their path operands without
// running a shell. Quotes group words; separators split commands.
function commands(script: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quote: string | undefined;
	const flushWord = () => {
		if (word) words.push(word);
		word = "";
	};
	const flushCommand = () => {
		flushWord();
		if (words.length) out.push(words);
		words = [];
	};
	for (let index = 0; index < script.length; index++) {
		const char = script[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else word += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (char === "\\" && index + 1 < script.length) word += script[++index];
		else if (/\s/.test(char) && char !== "\n") flushWord();
		else if (char === "\n" || char === ";" || char === "|" || char === "&" || char === "(" || char === ")") flushCommand();
		else word += char;
	}
	flushCommand();
	return out.map((command) => {
		const start = command.findIndex((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part) && part !== "sudo" && part !== "env" && part !== "command" && part !== "exec");
		return start < 0 ? [] : command.slice(start);
	});
}

function flags(args: string[]): Set<string> {
	const out = new Set<string>();
	for (const arg of args) {
		if (arg.startsWith("--")) out.add(arg.split("=")[0]);
		else if (arg.startsWith("-") && arg.length > 1) for (const letter of arg.slice(1)) out.add(`-${letter}`);
	}
	return out;
}

function operands(args: string[]): string[] {
	return args.filter((arg) => !arg.startsWith("-"));
}

export function classifyBash(script: string, scope: Scope, cwd: string): Verdict {
	for (const [cmd, ...args] of commands(script)) {
		if (!cmd) continue;
		const name = cmd.split("/").pop()!;
		const set = flags(args);
		if (name === "rm" || name === "rmdir" || name === "shred" || name === "unlink") {
			const outside = operands(args).filter((path) => !inScopePath(path, scope, cwd));
			if (outside.length) return { outOfScope: true, reason: `${name} outside the member's scope: ${outside.join(" ")}` };
		}
		if (name === "mv" || name === "chmod" || name === "chown" || name === "truncate") {
			const outside = operands(args).filter((path, index, all) => (name === "mv" ? true : index > 0 || all.length === 1) && !inScopePath(path, scope, cwd));
			if (outside.length) return { outOfScope: true, reason: `${name} touches paths outside the member's scope: ${outside.join(" ")}` };
		}
		if (name === "dd" || name === "mkfs" || name.startsWith("mkfs.") || name === "diskutil" || name === "shutdown" || name === "reboot") {
			return { outOfScope: true, reason: `${name} is a system-level action` };
		}
		if (name === "git") {
			const [sub, ...rest] = operands(args);
			const subFlags = flags(args);
			if (sub === "push") {
				if (subFlags.has("--force") || subFlags.has("-f") || subFlags.has("--force-with-lease") || subFlags.has("--delete") || subFlags.has("-d")) {
					return { outOfScope: true, reason: "force or deleting git push" };
				}
				if (rest.some((ref) => ref.startsWith(":") || ref.startsWith("+"))) return { outOfScope: true, reason: "git push that deletes or force-updates a ref" };
				if (rest.some((ref) => /(^|:)(refs\/heads\/)?(main|master|trunk|develop|release[^ ]*)$/.test(ref))) {
					return { outOfScope: true, reason: "git push to a shared branch" };
				}
			}
			if (sub === "worktree" && rest[0] === "remove" && rest.slice(1).some((path) => !inScopePath(path, scope, cwd))) {
				return { outOfScope: true, reason: "removing another worktree" };
			}
			if (sub === "branch" && (subFlags.has("-D") || subFlags.has("-d") || subFlags.has("--delete")) && rest.some((ref) => !ref.includes("swarm/"))) {
				return { outOfScope: true, reason: "deleting a branch the swarm does not own" };
			}
			if ((sub === "reset" || sub === "clean" || sub === "checkout" || sub === "restore") && args.includes("-C")) {
				const target = args[args.indexOf("-C") + 1];
				if (target && !inScopePath(target, scope, cwd)) return { outOfScope: true, reason: `git ${sub} in another checkout` };
			}
		}
		if (name === "gh") {
			const [area, action] = operands(args);
			if (["pr", "issue"].includes(area) && ["close", "merge", "delete", "lock"].includes(action)) return { outOfScope: true, reason: `gh ${area} ${action}` };
			if (["repo", "release", "secret", "variable", "workflow", "ruleset"].includes(area) && ["delete", "archive", "rename", "set", "remove", "disable", "edit"].includes(action)) {
				return { outOfScope: true, reason: `gh ${area} ${action}` };
			}
			if (area === "api" && (/(^|\s)(-X|--method)[= ]?(DELETE|PUT|PATCH)/i.test(args.join(" ")))) return { outOfScope: true, reason: "gh api write" };
		}
		if (name === "curl" || name === "wget" || name === "http") {
			const joined = args.join(" ");
			const local = /(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(joined);
			if (!local && (/(^|\s)(-X|--request)[= ]?(DELETE|PUT|PATCH)/i.test(joined) || set.has("--delete"))) {
				return { outOfScope: true, reason: `${name} write request to an external service` };
			}
		}
		if (["kubectl", "terraform", "tofu", "aws", "gcloud", "az", "fly", "vercel", "heroku"].includes(name)) {
			const destructive = args.some((arg) => /^(delete|destroy|apply|deploy|rm|remove|terminate|scale)$/.test(arg));
			if (destructive) return { outOfScope: true, reason: `${name} ${args.find((arg) => /^(delete|destroy|apply|deploy|rm|remove|terminate|scale)$/.test(arg))} against shared infrastructure` };
		}
	}
	return IN_SCOPE;
}

export function classifyWrite(path: string, scope: Scope, cwd: string): Verdict {
	return inScopePath(path, scope, cwd) ? IN_SCOPE : { outOfScope: true, reason: `writes outside the member's worktree: ${path}` };
}
