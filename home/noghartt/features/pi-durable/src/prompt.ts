import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { buildSystemPromptSections } from "#pi/core/system-prompt.js";
import { bashToolSystemPromptContribution } from "#pi/core/tools/bash.js";
import { editToolSystemPromptContribution } from "#pi/core/tools/edit.js";
import { readToolSystemPromptContribution } from "#pi/core/tools/read.js";
import { writeToolSystemPromptContribution } from "#pi/core/tools/write.js";
import { antigravitySystemPromptContribution } from "./antigravity.ts";
import type { PiResources } from "./resources.ts";
import { createRexContext } from "./rex.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: {
		...bashToolSystemPromptContribution,
		guidelines: [
			...bashToolSystemPromptContribution.guidelines,
			"To make a git worktree yourself, use `git twig new` (same arguments as `git worktree add`, copy-on-write files) instead of `git worktree add`.",
		],
	},
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
	antigravity: antigravitySystemPromptContribution,
	subagent: {
		snippet: "Delegate a self-contained task to a subagent (a profile's model and tools), waiting or in the background",
		guidelines: [
			"Use subagent for self-contained work that would flood this conversation (wide searches, reviews, separate changes); give it the full task, it sees nothing of this conversation.",
		],
	},
	parallel: {
		snippet: "Run several independent tasks at once, one subagent each, and get all answers back",
		guidelines: [
			"Use parallel instead of consecutive subagent calls when tasks do not depend on each other; give subagents that change files isolation worktree.",
		],
	},
	watch: {
		snippet: "Start a background watcher (command exit or output match, file changes, timer) that wakes you with a message",
		guidelines: [
			"Use watch for long-running commands (test suites, builds, servers) instead of blocking bash; end your turn and act on the report when it arrives.",
		],
	},
	agents: {
		snippet: "List, message, read, or stop this session's other agents (main, branches, subagents) and watchers",
		guidelines: [],
	},
	sessions: {
		snippet: "List, read (also at a label), or message other pi-durable sessions on this machine",
		guidelines: [],
	},
};

/**
 * Models default to offering the obvious next step as a question ("Should I watch the PR's CI?"), which stalls work the
 * user already wants done; this sets the default to acting, with asking kept for what is hard to undo or truly theirs.
 */
const AGENCY = [
	"Act on the clear next step instead of asking whether to: when it follows from the request (watch the CI of a PR you opened and fix what fails, run the tests or the build after a change, act on a watcher's report, re-run a flaky check), do it and say what you did. The user says when they do not want something.",
	"Ask first only for what is destructive or hard to undo (deleting data or branches, force-pushing, rewriting shared history, applying system changes, spending money, posting or replying where other people read it), or for a real decision the request and the repo leave open.",
	"Do not end a turn with an offer like \"Should I ...?\" or \"Want me to ...?\" for work you can do: do it, or end because you are done or blocked on the user, and say which.",
	"Repository and user rules that restrict actions (no autonomous system switches, no PR replies without permission) still apply.",
].join("\n");

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "cwd"] as const;

/**
 * pi's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. Context files and skills come from pi's resource loader for the session's directory, read
 * at each request, so `/reload` and `/trust` reach the next one; skills marked `disable-model-invocation` stay out.
 */
export function createPiPrompt(resources: PiResources) {
	const load = () => ({
		contextFiles: resources.contextFiles,
		skills: resources.skills.filter((skill) => !skill.disableModelInvocation),
	});
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? resources.cwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			...load(),
		});
	};
	const rex = createRexContext();
	return defineExtension({
		name: "pi-prompt",
		sections: [
			// The built sections carry their own tags.
			...KEYS.flatMap((key) => {
				const piSection = section(key, (input) => build(input)[key], { tag: false });
				return key === "rules" ? [piSection, section("agency", () => AGENCY)] : [piSection];
			}),
			// Inside a Rex terminal: which Rex session and pane this is, and how to drive Rex (`src/rex.ts`).
			...(rex === undefined ? [] : [section("rex", rex)]),
		],
	});
}
