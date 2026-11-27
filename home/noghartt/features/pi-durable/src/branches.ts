import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { TreeSelectorComponent } from "#pi/index.js";
import { theme } from "#pi/modes/interactive/theme/theme.js";
import type { BranchSummary, SessionTree } from "./runtime.ts";

/** Most branches listed before the rest collapse into a count; the tree below still holds them all. */
const MAX_LISTED = 6;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Which branches are listed: the shown one always, then the newest. */
function listed(branches: readonly BranchSummary[]): BranchSummary[] {
	if (branches.length <= MAX_LISTED) return [...branches];
	const shown = branches.filter((branch) => branch.shown);
	const rest = branches.filter((branch) => !branch.shown).slice(-(MAX_LISTED - shown.length));
	return [...shown, ...rest].sort((left, right) => left.id - right.id);
}

/** A title, a hint, and one line per branch: where it forked, how much it added, and how it starts. */
class BranchHeader implements Component {
	readonly #title: string;
	readonly #hint: string;
	readonly #branches: readonly BranchSummary[];

	constructor(title: string, hint: string, branches: readonly BranchSummary[]) {
		this.#title = title;
		this.#hint = hint;
		this.#branches = branches;
	}

	/** Lines it renders, for sizing the tree below it. */
	get height(): number {
		const hidden = this.#branches.length > MAX_LISTED ? 1 : 0;
		return 3 + Math.min(this.#branches.length, MAX_LISTED) + hidden;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const shown = this.#branches.find((branch) => branch.shown);
		const count = Math.max(0, this.#branches.length - 1);
		const summary = `${plural(count, "branch")} besides main${shown === undefined ? "" : ` · showing ${shown.label}`}`;
		const lines = [
			`  ${theme.bold(this.#title)}  ${theme.fg("muted", summary)}`,
			theme.fg("dim", `  ${this.#hint}`),
		];
		const items = listed(this.#branches);
		const labelWidth = Math.max(...items.map((branch) => branch.label.length));
		for (const branch of items) {
			const marker = branch.shown ? theme.fg("accent", "● ") : theme.fg("dim", "○ ");
			const label = branch.label.padEnd(labelWidth);
			const origin =
				branch.from === undefined
					? plural(branch.messages, "message")
					: `from ${branch.from.label} after message ${branch.from.after} · +${plural(branch.own, "message")}`;
			const title = branch.title === undefined ? "" : theme.fg("dim", ` · “${branch.title}”`);
			const text = `  ${marker}${branch.shown ? theme.fg("accent", label) : label}  ${theme.fg("muted", origin)}${title}`;
			lines.push(truncateToWidth(text, width));
		}
		const hidden = this.#branches.length - items.length;
		if (hidden > 0) lines.push(theme.fg("dim", `    … ${hidden} older ${hidden === 1 ? "branch" : "branches"} in the tree`));
		lines.push("");
		return lines.map((line) => truncateToWidth(line, width));
	}
}

export interface BranchTreeOptions {
	readonly title: string;
	readonly hint: string;
	readonly filter?: "default" | "user-only";
	readonly rows: number;
	readonly onSelect: (nodeId: string) => void;
	readonly onCancel: () => void;
	readonly onLabelChange: (nodeId: string, label: string | undefined) => void;
}

/**
 * pi's tree selector under a branch overview: /tree and /fork share it, /fork starting on user messages only.
 * The overview replaces the selector's "Session Tree" title, the child it adds third.
 */
export function branchTree(session: SessionTree, options: BranchTreeOptions): TreeSelectorComponent {
	const header = new BranchHeader(options.title, options.hint, session.branches);
	const selector = new TreeSelectorComponent(
		session.tree,
		session.leafId,
		// The selector shows half of what it is given; leave room for the overview.
		Math.max(10, options.rows - 2 * (header.height - 1)),
		options.onSelect,
		options.onCancel,
		options.onLabelChange,
		undefined,
		options.filter,
	);
	const title = selector.children.findIndex((child) => child instanceof Text);
	if (title !== -1) selector.children[title] = header;
	return selector;
}
