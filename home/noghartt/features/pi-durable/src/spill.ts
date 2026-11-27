import type { Context } from "@earendil-works/chord/context";
import { boundOutput } from "@earendil-works/chord/output";
import {
	AgentDoc,
	defineExtension,
	type EnvTarget,
	type Extension,
	type HookApi,
	hook,
	type ToolDiagnostic,
	type ToolExecutionResult,
	type ToolHookCall,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

// The Harness's defaults (DEFAULT_MAX_BYTES/LINES, head retained), which bound every tool here: none of ours sets
// `outputLimits`, and bash, the one that does, streams its output, so its result is already bounded and never spills.
const LIMITS = { maxBytes: 50 * 1024, maxLines: 2000, retain: "head" } as const;

export type EnvBuilder = (
	target: EnvTarget,
	context: Context,
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;

/**
 * An `afterTool` hook that writes the complete text of a result the Harness is about to truncate to a temp file in the
 * conversation's execution environment, and names it in a `full_output` diagnostic, as Durable's bash does with its
 * spill file. The Harness only bounds results; a tool that returns explicit output (subagent, parallel, agents read,
 * antigravity, ...) would otherwise lose the rest for good. Going through the environment, not node:fs, keeps the path
 * readable by the model's own `read` once the environment is remote. Install it last so it sees the final text.
 */
export function createSpillExtension(env: EnvBuilder): Extension {
	return defineExtension({
		name: "spill-output",
		hooks: [hook(ToolTask, { afterTool: (call, result, api, context) => spill(call, result, env, api, context) })],
	});
}

async function spill(
	call: ToolHookCall,
	result: ToolExecutionResult,
	build: EnvBuilder,
	api: HookApi,
	context: Context,
): Promise<ToolExecutionResult | undefined> {
	// A nested call's result goes to the program that made it, which gets the bounded output as the model would.
	if (call.parent !== undefined || result.output === undefined) return undefined;
	const text = result.output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
	if (boundOutput(text, LIMITS).droppedBytes === 0) return undefined;
	const note = await write(text, build, api, context);
	return { ...result, diagnostics: [...(result.diagnostics ?? []), note] };
}

async function write(text: string, build: EnvBuilder, api: HookApi, context: Context): Promise<ToolDiagnostic> {
	const failed = (reason: string): ToolDiagnostic => ({
		severity: "warn",
		code: "full_output",
		message: `Could not save the full output: ${reason}`,
	});
	try {
		const cwd = (await api.snapshot(AgentDoc, api.conversationId, context))?.cwd;
		const target = { conversationId: api.conversationId, ...(cwd === undefined ? {} : { cwd }), read: api };
		const env = await build(target, context);
		if (env === undefined) return failed("no execution environment");
		const file = await env.createTempFile({ prefix: "pi-tool-output-", suffix: ".txt" }, context);
		if (!file.ok) return failed(file.error.message);
		const written = await env.writeFile(file.value, text, context);
		if (!written.ok) return failed(written.error.message);
		return { severity: "info", code: "full_output", message: `Full output: ${file.value} (read with offset/limit)` };
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}
