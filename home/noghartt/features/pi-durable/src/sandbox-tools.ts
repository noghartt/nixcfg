import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { Approvals } from "./approvals.ts";
import type { Host } from "./host.ts";
import { repoTop, runInSandbox, sandboxName, sandboxOf, sessionPrefix } from "./sandbox.ts";
import { SessionSandbox } from "./state.ts";

const RunParameters = obj({
	command: str({ description: "Shell command, run in the checkout (or home without one)" }),
	kind: opt(str({ description: "sbx kind (default job)" })),
	repo: opt(bool({ description: "Seed it with this repository's committed HEAD" })),
	artifacts: opt(arr(str(), { description: "Paths to download afterwards, relative to the checkout (no .., not absolute)" })),
	out: opt(str({ description: "Local directory for artifacts (default $TMPDIR/sbx-artifacts)" })),
	keep: opt(bool({ description: "Keep the sandbox afterwards" })),
	timeout: opt(int({ description: "Seconds before the command is killed" })),
});

const PullParameters = obj({
	sandbox: opt(str({ description: "Sandbox name (default: the one this conversation runs in)" })),
	branches: opt(arr(str(), { description: "Branches to pull (default all)" })),
	remove: opt(bool({ description: "Remove the sandbox after a successful pull" })),
});

/** `sandbox_run` and `sandbox_pull`, offered to every conversation. */
export function createSandboxTools(host: Host, approvals?: Approvals): Extension {
	const sandboxRun = defineTool({
		name: "sandbox_run",
		description:
			"Run one command in a fresh sandbox VM of an sbx kind (default job: internet, large), optionally seeded with " +
			"this repository's committed HEAD, streaming its output; downloads artifacts, then removes the sandbox unless keep.",
		parameters: RunParameters,
		// The sandbox's name derives from the call, so a rerun after a crash reuses it (and runs the command again).
		replay: "safe",
		execute: async (args, api, context) => {
			const sandboxes = host.sandboxes;
			const kind = args.kind ?? (sandboxes.kinds().includes("job") ? "job" : undefined);
			const cwd = (await api.agent(context)).cwd ?? host.cwd;
			const out = args.out === undefined ? join(tmpdir(), "sbx-artifacts") : resolve(cwd, args.out);

			const result = await runInSandbox(sandboxes, {
				name: sandboxName(host.sessionId, `run${api.taskId}`),
				command: args.command,
				...(kind === undefined ? {} : { kind }),
				...(args.repo === true ? { repo: cwd } : {}),
				...(args.timeout === undefined ? {} : { timeoutMs: args.timeout * 1000 }),
				...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
				out,
				...(args.keep === true ? { keep: true } : {}),
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
				onOutput: (text) => api.output(text),
			});
			const retained = api.retainedOutput();
			const footer = [
				`[sandbox ${result.name}${kind === undefined ? "" : ` (kind ${kind})`}: exit ${result.exitCode}; ` +
					(result.removed ? "removed]" : `kept; \`sbx shell ${result.name}\`, \`sbx rm ${result.name}\`]`),
				...(result.timedOut ? ["the sandbox stopped answering past the timeout; its command may still be running there"] : []),
				...result.warnings.map((warning) => `warning: ${warning}`),
				...result.artifacts.map((artifact) =>
					artifact.error === undefined
						? `artifact ${artifact.remote} -> ${artifact.local}`
						: `artifact ${artifact.remote} not downloaded: ${artifact.error}`,
				),
			].join("\n");
			const text = `${retained.text}${retained.truncated ? "\n[output truncated to its tail]" : ""}\n${footer}`;
			return { output: [{ type: "text" as const, text }], ...(result.exitCode === 0 ? {} : { isError: true }) };
		},
	});

	const sandboxPull = defineTool({
		name: "sandbox_pull",
		description:
			"Bring a sandbox's committed git branches into the local repository as sbx/<sandbox>/<branch>; only commits travel. " +
			"Optionally remove the sandbox afterwards.",
		parameters: PullParameters,
		// Pulling again only updates the same refs; removing a removed sandbox does nothing.
		replay: "safe",
		execute: async (args, api, context) => {
			const sandboxes = host.sandboxes;
			const own = await sandboxOf(api, api.conversationId, context);
			const detach = (gone: string) =>
				api.commit(async (tx) => {
					const doc = await tx.doc(SessionSandbox);
					if (doc.ref?.name === gone) delete doc.ref;
				}, context);
			const name = args.sandbox?.trim() || own?.name;
			if (name === undefined) throw new Error("This conversation runs in no sandbox; name one (sbx ls lists them).");
			const ref = own !== undefined && own.name === name ? own : { name };
			const cwd = (await api.agent(context)).cwd ?? host.cwd;
			const repo = ("localRoot" in ref ? ref.localRoot : undefined) ?? (await repoTop(cwd));
			if (repo === undefined) throw new Error(`${cwd} is not in a git repository to pull into.`);
			const pulled = await sandboxes.pull(
				ref,
				repo,
				args.branches ?? [],
				context.abortSignal === undefined ? undefined : context.abortSignal,
			);
			const lines = [
				pulled.gone
					? `${name} no longer exists; an earlier pull left these branches.`
					: pulled.fetched
						? `Pulled ${name} into ${repo}.`
						: `${name} has nothing new for ${repo}.`,
				pulled.output,
				pulled.branches.length > 0 ? `Branches: ${pulled.branches.join(", ")} (merge with git merge <branch>).` : "",
			];
			if (args.remove === true) {
				const box = pulled.gone ? undefined : await sandboxes.find(ref);
				// Only sandboxes this session made, and not kept ones, go without asking the user.
				const foreign = !name.startsWith(sessionPrefix(host.sessionId));
				const kept = box?.info.keep === true || ("keep" in ref && ref.keep === true);
				if (own?.name === name && own.purpose === "subagent") {
					lines.push("Not removed: a subagent's sandbox is removed when it finishes.");
				} else if (box === undefined) {
					// A rerun after the removal: the session may still name it.
					if (own?.name === name) await detach(name);
					lines.push(`${name} was already removed.`);
				} else if (
					(foreign || kept) &&
					!(await approvals?.request(
						{
							title: `Remove sandbox ${name}?`,
							message: `${foreign ? "This session did not make it" : "It is marked to keep"}; its pulled branches stay.`,
						},
						context,
					))
				) {
					lines.push(`Not removed: ${name} ${foreign ? "was not made by this session" : "is marked to keep"} and the user did not approve.`);
				} else {
					await sandboxes.remove(ref);
					if (own?.name === name) {
						// The session's sandbox is gone, so the session goes back to this machine.
						await detach(name);
						lines.push(`Removed ${name}; this session's tools run on the local machine again.`);
					} else lines.push(`Removed ${name}.`);
				}
			}
			return { output: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
		},
	});

	return defineExtension({ name: "pi-durable-sandbox", tools: [sandboxRun, sandboxPull] });
}
