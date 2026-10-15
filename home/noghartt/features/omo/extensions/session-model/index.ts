// Category subagents run on a pinned model instead of the category chain in
// omo.jsonc: Sonnet 5.5 for routine lanes while the session is on the Claude
// subscription, otherwise the parent session's current model. OmO 5.1.28 resolves a category's model only from
// that chain (loaded once per process) and rejects `category` + `model` on the
// same spawn, so each category spawn is rewritten into a model-pinned spawn
// before it executes. What that drops: OmO's per-category Category_Context
// prompt, per-category tools, and the chain's runtime fallback; a short lane
// note in the child prompt keeps the routing intent. See AGENTS.md.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Spawn = { prompt?: unknown; category?: unknown; subagent_type?: unknown; model?: unknown };
type TaskInput = Spawn & { tasks?: unknown };

const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// Delegated work drew on the same Claude limit as the Opus parent, so routine
// lanes go to Sonnet; the reasoning-heavy ones (deep-high, ultrabrain,
// architect, artistry, unknown lanes) keep the session's model. Off the Claude
// subscription (e.g. a GPT session while Claude is limited) nothing moves.
const SUBSCRIPTION = "anthropic-subscription";
const SONNET = `${SUBSCRIPTION}/claude-sonnet-5-5`;
const SONNET_LANES: Record<string, string> = {
	quick: "low",
	writing: "low",
	"deep-low": "medium",
	"unspecified-low": "medium",
	"unspecified-high": "high",
	"visual-engineering": "high",
};

function lanePin(ctx: ExtensionContext, category: string, sessionModel: string): string {
	const thinking = SONNET_LANES[category];
	return thinking && ctx.model?.provider === SUBSCRIPTION ? `${SONNET}:${thinking}` : sessionModel;
}

// `provider/model[:thinking]`, the pin format the task tool parses.
function sessionPin(ctx: ExtensionContext, thinking: string): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const base = `${model.provider}/${model.id}`;
	return model.reasoning && thinking !== "off" ? `${base}:${thinking}` : base;
}

function lane(category: string, prompt: unknown): unknown {
	if (typeof prompt !== "string") return prompt;
	return `[lane: ${category}] Routed as the "${category}" category; work at that lane's scope and depth.\n\n${prompt}`;
}

// Pins one spawn whose effective target is a category; `inherited` is the
// batch-level category an item without its own target falls back to.
function pin(spawn: Spawn, model: (category: string) => string, inherited?: string): void {
	if (present(spawn.subagent_type) || present(spawn.model)) return;
	const category = present(spawn.category) ? spawn.category : inherited;
	if (!category) return;
	delete spawn.category;
	spawn.model = model(category);
	spawn.prompt = lane(category, spawn.prompt);
}

export default function sessionModel(pi: ExtensionAPI) {
	// Tool arguments are cloned before this hook, so the rewrite reaches
	// execution only; the transcript keeps the call the model wrote.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName.toLowerCase() !== "task") return;
		const session = sessionPin(ctx, pi.getThinkingLevel());
		if (!session) return;
		const model = (category: string) => lanePin(ctx, category, session);
		const input = event.input as TaskInput;
		if (Array.isArray(input.tasks)) {
			const inherited = present(input.category) && !present(input.model) ? input.category : undefined;
			for (const item of input.tasks) {
				if (item && typeof item === "object") pin(item as Spawn, model, inherited);
			}
			if (inherited) delete input.category;
		} else {
			pin(input, model);
		}
	});
}
