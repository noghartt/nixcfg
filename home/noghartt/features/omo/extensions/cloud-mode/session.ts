// Pure session logic for cloud mode, no pi imports, so it is unit-tested without the engine
// (session.test.ts): recognising task children, which tools a session gets, and targets left
// behind by the removed sandbox support.

export type Role = "top" | "child";

/**
 * OmO marks a task child two ways (omo.js, `mC`/`gC`): a `sessionContext` with a `role` on the
 * extension context (sessions hosted by the shared task daemon), or
 * `OMO_SENPI_TASK_RPC_CHILD=1` in the environment of a spawned child process.
 */
export function roleOf(ctx: unknown, env: NodeJS.ProcessEnv = process.env): Role {
	const role = (ctx as { sessionContext?: { role?: unknown } } | undefined)?.sessionContext?.role;
	if (typeof role === "string" && role) return "child";
	return env.OMO_SENPI_TASK_RPC_CHILD === "1" ? "child" : "top";
}

/**
 * Drops the local-only tools. The top session also gets the remote file tools and `publish`;
 * a child keeps exactly the tools its agent type allows (a read-only type stays read-only), and
 * pushing stays the top session's job.
 */
export function activeTools(active: string[], role: Role, localOnly: RegExp): string[] {
	const next = active.filter((name) => !localOnly.test(name) && (role === "top" || name !== "publish"));
	if (role === "top") for (const name of ["read", "write", "edit", "publish"]) if (!next.includes(name)) next.push(name);
	return next;
}

// Sandbox targets (agentbox, exebox) are gone. Resuming one as a plain SSH target would act on
// the host's seed directory instead of the sandbox, so such sessions are blocked instead.
const SANDBOX_DESTS = new Set(["local", "exe"]);

export function legacyTarget(input: { spec?: string | null; entry?: unknown; env?: NodeJS.ProcessEnv }): string | undefined {
	const env = input.env ?? {};
	if (env.OMO_CLOUD_SANDBOX) return `the inherited OMO_CLOUD_SANDBOX=${env.OMO_CLOUD_SANDBOX} names a sandbox`;
	const sandbox = (input.entry as { sandbox?: unknown } | undefined)?.sandbox;
	if (typeof sandbox === "string" && sandbox) return `this session ran in sandbox ${sandbox}`;
	const dest = input.spec?.split(":")[0];
	if (dest && SANDBOX_DESTS.has(dest)) return `\`${dest}\` was a sandbox target`;
	return undefined;
}
