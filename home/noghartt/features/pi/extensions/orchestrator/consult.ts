// A second opinion for the leader from a stronger reasoning model (Fable, or GPT-6 Astra when
// Claude's limits run hot). Advisory only: the leader decides what to do with it.
import { limitsId, type Pressure, spill } from "./limits.ts";
import { RpcChild, type RpcEvent } from "./rpc.ts";

export interface ConsultantConfig {
	// In preference order; the first usable model of the other provider is the spill target.
	models: string[];
	thinking: string;
	timeoutSeconds: number;
	// Read-only tools, so it can check the leader's claims against the checkout.
	tools: string[];
}

export function pickConsultant(
	models: string[],
	usable: (ref: string) => boolean,
	pressure: Pressure,
	spillAt: number,
): { ref: string; note: string } | undefined {
	const preferred = models.find(usable);
	if (!preferred) return undefined;
	const other = models.find((ref) => limitsId(ref) !== limitsId(preferred) && usable(ref));
	const picked = spill(preferred, other, spillAt, pressure);
	return {
		ref: picked.ref,
		note: picked.hot === undefined ? "" : `${limitsId(preferred)} limits at ${Math.round(picked.hot)}%, so ${picked.ref} answered.`,
	};
}

const SYSTEM = [
	"You are a consultant to the leader of an orchestrated team of coding agents. The leader asks you one question with its own context.",
	"Answer directly: a clear recommendation first, then the reasons and the risks you see. Point out wrong assumptions in the question.",
	"You may read files to check claims, but you cannot change anything, and nobody answers follow-up questions: give your best judgment now.",
].join("\n");

export async function consult(options: {
	ref: string;
	thinking: string;
	tools: string[];
	cwd: string;
	question: string;
	context: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<string> {
	const slash = options.ref.indexOf("/");
	const child = new RpcChild(
		[
			"--no-session",
			"--provider",
			options.ref.slice(0, slash),
			"--model",
			options.ref.slice(slash + 1),
			"--thinking",
			options.thinking,
			"--tools",
			options.tools.join(","),
			"--append-system-prompt",
			SYSTEM,
		],
		options.cwd,
		// The installed orchestrator extension stays out of the consultant's way.
		{ ORCH_ROLE: "consultant" },
	);
	try {
		const settled = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(options.timeoutMs / 1000)}s`)), options.timeoutMs);
			const stop = () => {
				clearTimeout(timer);
				reject(new Error("consultation aborted"));
			};
			options.signal?.addEventListener("abort", stop, { once: true });
			child.onEvent((event: RpcEvent) => {
				if (event.type !== "agent_settled") return;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", stop);
				resolve();
			});
			void child.exited.then((code) => reject(new Error(`consultant exited (${code}): ${child.stderr().slice(-500)}`)));
		});
		// Observed now, so a failed send below cannot leave this rejection unhandled.
		settled.catch(() => undefined);
		await child.send({ type: "prompt", message: `Context from the leader:\n${options.context.trim() || "(none)"}\n\nQuestion:\n${options.question.trim()}` });
		await settled;
		const data = await child.send<{ text?: string | null } | string | null>({ type: "get_last_assistant_text" });
		const text = (typeof data === "string" ? data : data?.text)?.trim();
		if (!text) throw new Error("the consultant gave no answer");
		return text;
	} finally {
		await child.stop();
	}
}
