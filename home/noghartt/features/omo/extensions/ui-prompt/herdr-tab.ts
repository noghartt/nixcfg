import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_TAB_LABEL = 30;

type TabInfo = { label: string };

// Herdr never derives tab labels from the pane's terminal title, so the session name has to
// be pushed with `herdr tab rename`. A tab is only claimed while it still carries Herdr's
// generated numeric label: manual names and a tab another pane's session already named are
// left alone, and the original label comes back when this session ends.
export function createHerdrTab(pi: ExtensionAPI) {
	const tabId = process.env.HERDR_ENV === "1" ? process.env.HERDR_TAB_ID : undefined;
	let original: string | undefined;
	let applied: string | undefined;
	let disabled = false;
	let queue = Promise.resolve();

	const herdr = async (args: string[], cwd: string): Promise<string> => {
		const result = await pi.exec("herdr", args, { cwd });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `herdr ${args.slice(0, 2).join(" ")} failed`);
		return result.stdout;
	};
	const currentLabel = async (id: string, cwd: string) =>
		(JSON.parse(await herdr(["tab", "get", id], cwd)) as { result: { tab: TabInfo } }).result.tab.label;

	const enqueue = (ctx: ExtensionContext, step: (id: string, cwd: string) => Promise<void>): Promise<void> => {
		if (!tabId || disabled) return queue;
		const { cwd } = ctx;
		queue = queue
			.then(() => step(tabId, cwd))
			.catch((error: unknown) => {
				// One warning, then stop: a broken socket would otherwise fail every turn.
				disabled = true;
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`ui-prompt: Herdr tab naming disabled (${message})`, "warning");
			});
		return queue;
	};

	return {
		set(ctx: ExtensionContext, name: string): void {
			const label = name.length > MAX_TAB_LABEL ? `${name.slice(0, MAX_TAB_LABEL - 1)}\u2026` : name;
			if (label === applied) return;
			void enqueue(ctx, async (id, cwd) => {
				if (label === applied) return;
				const current = await currentLabel(id, cwd);
				if (current !== applied && !/^\d+$/.test(current)) return;
				original ??= current;
				await herdr(["tab", "rename", id, label], cwd);
				applied = label;
			});
		},
		restore(ctx: ExtensionContext): Promise<void> {
			return enqueue(ctx, async (id, cwd) => {
				const label = original;
				original = undefined;
				if (label === undefined || applied === undefined) return;
				const claimed = applied;
				applied = undefined;
				// A rename made by hand while this session ran wins over the restore.
				if ((await currentLabel(id, cwd)) === claimed) await herdr(["tab", "rename", id, label], cwd);
			});
		},
	};
}
