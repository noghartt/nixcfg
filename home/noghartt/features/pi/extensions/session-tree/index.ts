import {
	copyToClipboard,
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
	type SessionEntry,
	type SessionTreeNode,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

type FlatNode = {
	node: SessionTreeNode;
	parentId: string | null;
};

type TreeRow = {
	node: SessionTreeNode;
	graphX: number;
	graphY: number;
	hasChildren: boolean;
};

const FILTER_MODES: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as Record<string, unknown>;
			if (block.type === "text") return String(block.text ?? "");
			if (block.type === "thinking") return String(block.thinking ?? "");
			if (block.type === "image") return "[image]";
			if (block.type === "toolCall") return `${String(block.name ?? "tool")} ${JSON.stringify(block.arguments ?? {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function oneLine(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function entryCategory(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return entry.message.role;
		case "custom_message":
			return entry.customType;
		case "branch_summary":
			return "branch summary";
		case "thinking_level_change":
			return "thinking";
		case "model_change":
			return "model";
		case "session_info":
			return "title";
		default:
			return entry.type;
	}
}

function entrySummary(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "bashExecution") return oneLine(message.command);
			if ("content" in message) return oneLine(textContent(message.content));
			return "";
		}
		case "custom_message":
			return oneLine(textContent(entry.content));
		case "compaction":
			return `${Math.round(entry.tokensBefore / 1000)}k tokens`;
		case "branch_summary":
			return oneLine(entry.summary);
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		case "custom":
			return entry.customType;
		case "label":
			return entry.label ?? "cleared";
		case "session_info":
			return entry.name ?? "empty";
	}
}

function detailText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "bashExecution") {
				return [`COMMAND\n${message.command}`, `OUTPUT\n${message.output || "(no output)"}`, `EXIT ${message.exitCode ?? "running"}`].join(
					"\n\n",
				);
			}

			const sections: string[] = [];
			if ("content" in message && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!part || typeof part !== "object") continue;
					const block = part as unknown as Record<string, unknown>;
					if (block.type === "text") sections.push(String(block.text ?? ""));
					else if (block.type === "thinking") sections.push(`THINKING\n${String(block.thinking ?? "")}`);
					else if (block.type === "image") sections.push("[image]");
					else if (block.type === "toolCall") {
						sections.push(`TOOL · ${String(block.name ?? "unknown")}\n${JSON.stringify(block.arguments ?? {}, null, 2)}`);
					}
				}
			} else if ("content" in message) {
				sections.push(textContent(message.content));
			}

			if (message.role === "assistant") {
				sections.push(
					`MODEL · ${message.provider}/${message.model}\nSTOP · ${message.stopReason}\nTOKENS · ${message.usage.totalTokens}`,
				);
			} else if (message.role === "toolResult") {
				sections.push(`TOOL · ${message.toolName}\nSTATUS · ${message.isError ? "error" : "success"}`);
			}
			return sections.filter(Boolean).join("\n\n") || "(no content)";
		}
		case "custom_message":
			return textContent(entry.content) || "(no content)";
		case "compaction":
			return `${entry.summary}\n\nTOKENS BEFORE · ${entry.tokensBefore}`;
		case "branch_summary":
			return entry.summary;
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		case "custom":
			return JSON.stringify(entry.data ?? {}, null, 2);
		case "label":
			return `TARGET · ${entry.targetId}\nLABEL · ${entry.label ?? "(cleared)"}`;
		case "session_info":
			return entry.name ?? "(empty title)";
	}
}

function categoryColor(theme: Theme, category: string, text: string): string {
	switch (category) {
		case "user":
			return theme.fg("accent", text);
		case "assistant":
			return theme.fg("success", text);
		case "toolResult":
			return theme.fg("toolTitle", text);
		case "bashExecution":
			return theme.fg("warning", text);
		case "branch summary":
			return theme.fg("warning", text);
		case "compaction":
			return theme.fg("borderAccent", text);
		default:
			return theme.fg("customMessageLabel", text);
	}
}

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class SessionTreeModal implements Component, Focusable {
	focused = false;
	private readonly flatNodes: FlatNode[] = [];
	private readonly nodeById = new Map<string, SessionTreeNode>();
	private readonly activePath = new Set<string>();
	private readonly folded = new Set<string>();
	private rows: TreeRow[] = [];
	private graphLines: string[] = [];
	private graphWidth = 1;
	private selectedId: string | null;
	private selectedIndex = 0;
	private filterMode: FilterMode = "default";
	private search = "";
	private showLabelTimestamps = false;
	private previewOffset = 0;
	private previewMaxOffset = 0;
	private previewCache: { entryId: string; width: number; lines: string[] } | undefined;
	private bodyHeight: number;

	constructor(
		tree: SessionTreeNode[],
		private readonly leafId: string | null,
		terminalRows: number,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly tui: TUI,
		private readonly onSelect: (entryId: string) => void,
		private readonly onCancel: () => void,
		private readonly onCopy: (text: string | undefined) => void,
		private readonly onEditLabel: (node: SessionTreeNode) => void,
		initialSelectedId?: string,
	) {
		this.bodyHeight = Math.max(8, Math.min(42, Math.floor(terminalRows * 0.82) - 6));
		const stack = [...tree].reverse().map((node) => ({ node, parentId: null as string | null }));
		while (stack.length > 0) {
			const item = stack.pop()!;
			this.flatNodes.push(item);
			this.nodeById.set(item.node.entry.id, item.node);
			for (let index = item.node.children.length - 1; index >= 0; index--) {
				stack.push({ node: item.node.children[index]!, parentId: item.node.entry.id });
			}
		}
		for (let id = leafId; id; ) {
			this.activePath.add(id);
			id = this.nodeById.get(id)?.entry.parentId ?? null;
		}
		this.selectedId = initialSelectedId ?? leafId ?? this.flatNodes[0]?.node.entry.id ?? null;
		this.rebuildRows();
	}

	private searchableText(node: SessionTreeNode): string {
		return [entryCategory(node.entry), entrySummary(node.entry), node.label ?? ""].join(" ").toLowerCase();
	}

	private passesFilter(node: SessionTreeNode): boolean {
		const entry = node.entry;
		const isSettings = ["label", "custom", "model_change", "thinking_level_change", "session_info"].includes(entry.type);
		if (entry.type === "message" && entry.message.role === "assistant" && entry.id !== this.leafId) {
			const message = entry.message;
			const hasText = "content" in message && textContent(message.content).trim().length > 0;
			const exceptional = message.stopReason && !["stop", "toolUse"].includes(message.stopReason);
			if (!hasText && !exceptional) return false;
		}
		if (this.filterMode === "user-only" && !(entry.type === "message" && entry.message.role === "user")) return false;
		if (this.filterMode === "labeled-only" && node.label === undefined) return false;
		if (this.filterMode === "no-tools" && (isSettings || (entry.type === "message" && entry.message.role === "toolResult"))) {
			return false;
		}
		if (this.filterMode === "default" && isSettings) return false;
		const tokens = this.search.toLowerCase().split(/\s+/).filter(Boolean);
		const searchable = this.searchableText(node);
		return tokens.every((token) => searchable.includes(token));
	}

	private isHiddenByFold(node: SessionTreeNode): boolean {
		for (let id = node.entry.parentId; id; id = this.nodeById.get(id)?.entry.parentId ?? null) {
			if (this.folded.has(id)) return true;
		}
		return false;
	}

	private rebuildRows(): void {
		const visible = this.flatNodes.filter(({ node }) => this.passesFilter(node) && !this.isHiddenByFold(node));
		const visibleIds = new Set(visible.map(({ node }) => node.entry.id));
		const children = new Map<string | null, SessionTreeNode[]>();
		const nearestVisibleParent = (node: SessionTreeNode): string | null => {
			for (let id = node.entry.parentId; id; id = this.nodeById.get(id)?.entry.parentId ?? null) {
				if (visibleIds.has(id)) return id;
			}
			return null;
		};
		for (const { node } of visible) {
			const parent = nearestVisibleParent(node);
			const siblings = children.get(parent) ?? [];
			siblings.push(node);
			children.set(parent, siblings);
		}
		for (const siblings of children.values()) {
			siblings.sort((left, right) => Number(this.activePath.has(right.entry.id)) - Number(this.activePath.has(left.entry.id)));
		}

		this.rows = [];
		const visit = (node: SessionTreeNode) => {
			const visibleChildren = children.get(node.entry.id) ?? [];
			this.rows.push({ node, graphX: 0, graphY: 0, hasChildren: visibleChildren.length > 0 });
			for (const child of visibleChildren) visit(child);
		};
		const roots = children.get(null) ?? [];
		for (const root of roots) visit(root);

		const rowById = new Map(this.rows.map((row, index) => [row.node.entry.id, { row, index }]));
		let nextLeafX = 0;
		const position = (node: SessionTreeNode): number => {
			const visibleChildren = children.get(node.entry.id) ?? [];
			const childPositions = visibleChildren.map(position);
			const graphX =
				childPositions.length === 0
					? nextLeafX
					: Math.round((childPositions[0]! + childPositions[childPositions.length - 1]!) / 2);
			if (childPositions.length === 0) nextLeafX += 4;
			const row = rowById.get(node.entry.id)?.row;
			if (row) row.graphX = graphX;
			return graphX;
		};
		const rootPositions = roots.map(position);
		const minX = Math.min(0, ...this.rows.map((row) => row.graphX));
		const maxX = Math.max(0, ...this.rows.map((row) => row.graphX));
		const graphCenter =
			rootPositions.length > 0 ? Math.round((rootPositions[0]! + rootPositions[rootPositions.length - 1]!) / 2) : 0;
		const graphRadius = Math.max(graphCenter - minX, maxX - graphCenter);
		const graphShift = graphRadius - graphCenter;
		for (const row of this.rows) row.graphX += graphShift;
		this.graphWidth = Math.max(1, graphRadius * 2 + 1);

		let previousY = -2;
		for (const row of this.rows) {
			const parent = row.node.entry.parentId ? rowById.get(nearestVisibleParent(row.node) ?? "") : undefined;
			const edgeHeight = parent ? Math.abs(row.graphX - parent.row.graphX) : 0;
			row.graphY = Math.max(previousY + 2, (parent?.row.graphY ?? 0) + edgeHeight);
			previousY = row.graphY;
		}

		const graphHeight = Math.max(1, (this.rows.at(-1)?.graphY ?? 0) + 1);
		const canvas = Array.from({ length: graphHeight }, () => Array<string>(this.graphWidth).fill(" "));
		const draw = (x: number, y: number, character: "|" | "/" | "\\") => {
			const current = canvas[y]?.[x];
			if (current === undefined || current === character) return;
			canvas[y]![x] = current === " " ? character : "+";
		};

		for (const row of this.rows) {
			const parent = row.node.entry.parentId ? rowById.get(nearestVisibleParent(row.node) ?? "")?.row : undefined;
			if (!parent) continue;
			let edgeX = parent.graphX;
			for (let edgeY = parent.graphY + 1; edgeY < row.graphY; edgeY++) {
				if (edgeX < row.graphX) {
					edgeX++;
					draw(edgeX, edgeY, "\\");
				} else if (edgeX > row.graphX) {
					edgeX--;
					draw(edgeX, edgeY, "/");
				} else draw(edgeX, edgeY, "|");
			}
		}
		for (const row of this.rows) {
			canvas[row.graphY]![row.graphX] = row.node.entry.id === this.leafId ? "@" : row.hasChildren ? "*" : "+";
		}
		this.graphLines = canvas.map((line) => line.join("").trimEnd());

		let nextIndex = this.rows.findIndex((row) => row.node.entry.id === this.selectedId);
		if (nextIndex < 0 && this.selectedId) {
			for (let id = this.nodeById.get(this.selectedId)?.entry.parentId ?? null; id; id = this.nodeById.get(id)?.entry.parentId ?? null) {
				nextIndex = this.rows.findIndex((row) => row.node.entry.id === id);
				if (nextIndex >= 0) break;
			}
		}
		this.selectedIndex = Math.max(0, nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, this.rows.length - 1));
		this.selectedId = this.rows[this.selectedIndex]?.node.entry.id ?? null;
		this.previewOffset = 0;
		this.tui.requestRender();
	}

	private setSelected(index: number): void {
		if (this.rows.length === 0) return;
		const nextIndex = Math.max(0, Math.min(index, this.rows.length - 1));
		if (nextIndex !== this.selectedIndex) this.previewOffset = 0;
		this.selectedIndex = nextIndex;
		this.selectedId = this.rows[this.selectedIndex]!.node.entry.id;
	}

	private cycleFilter(direction: 1 | -1): void {
		const current = FILTER_MODES.indexOf(this.filterMode);
		this.filterMode = FILTER_MODES[(current + direction + FILTER_MODES.length) % FILTER_MODES.length]!;
		this.folded.clear();
		this.rebuildRows();
	}

	private setFilter(mode: FilterMode): void {
		this.filterMode = this.filterMode === mode && mode !== "default" ? "default" : mode;
		this.folded.clear();
		this.rebuildRows();
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (matchesKey(data, "shift+up")) this.previewOffset = Math.max(0, this.previewOffset - 1);
		else if (matchesKey(data, "shift+down")) {
			this.previewOffset = Math.min(this.previewMaxOffset, this.previewOffset + 1);
		} else if (kb.matches(data, "tui.select.up")) this.setSelected(this.selectedIndex - 1);
		else if (kb.matches(data, "tui.select.down")) this.setSelected(this.selectedIndex + 1);
		else if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.pageUp")) {
			this.setSelected(this.selectedIndex - Math.max(1, Math.floor(this.bodyHeight / 2)));
		} else if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.pageDown")) {
			this.setSelected(this.selectedIndex + Math.max(1, Math.floor(this.bodyHeight / 2)));
		} else if (kb.matches(data, "app.tree.foldOrUp")) {
			const row = this.rows[this.selectedIndex];
			if (row?.hasChildren) {
				this.folded.add(row.node.entry.id);
				this.rebuildRows();
			} else if (row?.node.entry.parentId) {
				const parentIndex = this.rows.findIndex(({ node }) => node.entry.id === row.node.entry.parentId);
				if (parentIndex >= 0) this.setSelected(parentIndex);
			}
		} else if (kb.matches(data, "app.tree.unfoldOrDown")) {
			const row = this.rows[this.selectedIndex];
			if (row && this.folded.delete(row.node.entry.id)) this.rebuildRows();
			else if (row?.hasChildren) this.setSelected(this.selectedIndex + 1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const row = this.rows[this.selectedIndex];
			if (row) this.onSelect(row.node.entry.id);
		} else if (kb.matches(data, "app.message.copy")) {
			const row = this.rows[this.selectedIndex];
			this.onCopy(row ? detailText(row.node.entry) : undefined);
		} else if (kb.matches(data, "app.tree.editLabel")) {
			const row = this.rows[this.selectedIndex];
			if (row) this.onEditLabel(row.node);
		} else if (kb.matches(data, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else if (kb.matches(data, "app.tree.filter.default")) this.setFilter("default");
		else if (kb.matches(data, "app.tree.filter.noTools")) this.setFilter("no-tools");
		else if (kb.matches(data, "app.tree.filter.userOnly")) this.setFilter("user-only");
		else if (kb.matches(data, "app.tree.filter.labeledOnly")) this.setFilter("labeled-only");
		else if (kb.matches(data, "app.tree.filter.all")) this.setFilter("all");
		else if (kb.matches(data, "app.tree.filter.cycleForward")) this.cycleFilter(1);
		else if (kb.matches(data, "app.tree.filter.cycleBackward")) this.cycleFilter(-1);
		else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.search) {
				this.search = this.search.slice(0, -1);
				this.folded.clear();
				this.rebuildRows();
			}
		} else if (kb.matches(data, "tui.select.cancel")) {
			if (this.search) {
				this.search = "";
				this.folded.clear();
				this.rebuildRows();
			} else this.onCancel();
		} else {
			const printable = data.length > 0 && ![...data].some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (printable) {
				this.search += data;
				this.folded.clear();
				this.rebuildRows();
			}
		}
		this.tui.requestRender();
	}

	private previewContent(entry: SessionEntry, width: number): string[] {
		if (this.previewCache?.entryId === entry.id && this.previewCache.width === width) return this.previewCache.lines;
		const lines = wrapTextWithAnsi(detailText(entry), Math.max(1, width));
		this.previewCache = { entryId: entry.id, width, lines };
		return lines;
	}

	updateLabel(node: SessionTreeNode, label: string | undefined): void {
		node.label = label;
		node.labelTimestamp = label ? new Date().toISOString() : undefined;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, Math.min(120, innerWidth - 2));
		const contentPadding = Math.max(0, Math.floor((innerWidth - contentWidth) / 2));
		const showPreview = contentWidth >= 80;
		const leftWidth = showPreview ? Math.floor(contentWidth * 0.58) : contentWidth;
		const previewWidth = showPreview ? contentWidth - leftWidth - 3 : 0;
		const graphViewportWidth = Math.max(1, Math.min(showPreview ? 22 : 30, Math.floor(leftWidth * 0.34)));
		const summaryWidth = Math.max(1, leftWidth - graphViewportWidth - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const frame = (content: string) =>
			`${border("│")}${" ".repeat(contentPadding)}${padToWidth(content, contentWidth)}${" ".repeat(
				Math.max(0, innerWidth - contentPadding - contentWidth),
			)}${border("│")}`;
		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(frame(this.theme.bold(this.theme.fg("accent", "SESSION TREE"))));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const searchStatus = `search: ${this.search || "·"}  filter: ${this.filterMode}  ${this.rows.length}/${this.flatNodes.length}  markers: @ current, + branch tip`;
		lines.push(frame(this.theme.fg("muted", searchStatus)));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		const selectedRow = this.rows[this.selectedIndex];
		const selectedGraphY = selectedRow?.graphY ?? 0;
		const start = Math.max(0, Math.min(selectedGraphY - Math.floor(this.bodyHeight / 2), this.graphLines.length - this.bodyHeight));
		const selectedX = selectedRow?.graphX ?? 0;
		const graphFits = this.graphWidth <= graphViewportWidth;
		const graphStart = graphFits
			? 0
			: Math.max(0, Math.min(selectedX - Math.floor(graphViewportWidth / 2), this.graphWidth - graphViewportWidth));
		const graphPadding = graphFits ? Math.floor((graphViewportWidth - this.graphWidth) / 2) : 0;
		const rowByGraphY = new Map(this.rows.map((row, index) => [row.graphY, { row, index }]));

		const preview: string[] = [];
		if (showPreview) {
			const previewBodyHeight = Math.max(1, this.bodyHeight - 3);
			const content = selectedRow ? this.previewContent(selectedRow.node.entry, previewWidth) : ["(no visible node)"];
			this.previewMaxOffset = Math.max(0, content.length - previewBodyHeight);
			this.previewOffset = Math.min(this.previewOffset, this.previewMaxOffset);
			const previewEnd = Math.min(content.length, this.previewOffset + previewBodyHeight);
			const progress =
				content.length > previewBodyHeight ? ` ${this.previewOffset + 1}-${previewEnd}/${content.length}` : "";
			preview.push(this.theme.bold(this.theme.fg("accent", `PREVIEW${progress}`)));
			if (selectedRow) {
				const category = entryCategory(selectedRow.node.entry);
				const label = selectedRow.node.label ? this.theme.fg("warning", ` [${selectedRow.node.label}]`) : "";
				preview.push(categoryColor(this.theme, category, category.toUpperCase()) + label);
			} else preview.push("");
			preview.push(border("─".repeat(previewWidth)));
			preview.push(...content.slice(this.previewOffset, previewEnd));
		} else {
			this.previewOffset = 0;
			this.previewMaxOffset = 0;
		}

		for (let offset = 0; offset < this.bodyHeight; offset++) {
			const graphY = start + offset;
			const item = rowByGraphY.get(graphY);
			const rawGraph = (this.graphLines[graphY] ?? "").padEnd(this.graphWidth);
			const visibleGraph = graphFits
				? `${" ".repeat(graphPadding)}${rawGraph}${" ".repeat(graphViewportWidth - graphPadding - this.graphWidth)}`
				: rawGraph.slice(graphStart, graphStart + graphViewportWidth);
			const graphCharacters = visibleGraph.padEnd(graphViewportWidth).split("");
			if (!graphFits && graphStart > 0) graphCharacters[0] = "<";
			if (!graphFits && graphStart + graphViewportWidth < this.graphWidth) graphCharacters[graphViewportWidth - 1] = ">";

			let renderedGraph: string;
			if (item) {
				const markerX = item.row.graphX - graphStart + graphPadding;
				const category = entryCategory(item.row.node.entry);
				const marker = item.row.node.entry.id === this.leafId ? "@" : item.row.hasChildren ? "*" : "+";
				if (markerX >= 0 && markerX < graphCharacters.length) graphCharacters[markerX] = marker;
				const before = graphCharacters.slice(0, Math.max(0, markerX)).join("");
				const after = graphCharacters.slice(markerX + 1).join("");
				renderedGraph =
					markerX >= 0 && markerX < graphCharacters.length
						? this.theme.fg("dim", before) + categoryColor(this.theme, category, marker) + this.theme.fg("dim", after)
						: this.theme.fg("dim", graphCharacters.join(""));
			} else {
				renderedGraph = this.theme.fg("dim", graphCharacters.join(""));
			}

			let summary = "";
			if (item) {
				const entry = item.row.node.entry;
				const category = entryCategory(entry);
				const categoryLabel = categoryColor(this.theme, category, category.toUpperCase());
				const text = entrySummary(entry);
				const label = item.row.node.label ? this.theme.fg("warning", ` [${item.row.node.label}]`) : "";
				const timestamp =
					this.showLabelTimestamps && item.row.node.label && item.row.node.labelTimestamp
						? this.theme.fg("muted", ` ${item.row.node.labelTimestamp.slice(5, 16).replace("T", " ")}`)
						: "";
				summary = `${categoryLabel}${label}${timestamp}${text ? this.theme.fg("muted", ` · ${text}`) : ""}`;
			}

			const graph = padToWidth(renderedGraph, graphViewportWidth);
			const leftContent = `${graph}  ${truncateToWidth(summary, summaryWidth, "…")}`;
			const leftFitted = padToWidth(leftContent, leftWidth);
			const selected = item?.index === this.selectedIndex;
			const renderedLeft = selected ? this.theme.bg("selectedBg", this.theme.bold(leftFitted)) : leftFitted;
			const rowContent = showPreview
				? `${renderedLeft} ${border("│")} ${padToWidth(preview[offset] ?? "", previewWidth)}`
				: renderedLeft;
			lines.push(frame(rowContent));
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const help = "↑↓ node · ←→ page · shift↑↓ preview · ctrl/alt←→ fold · type search · ^o filter · shift+l label · ^x copy · enter navigate · esc close";
		lines.push(frame(this.theme.fg("muted", help)));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.previewCache = undefined;
	}
}

export default function sessionTree(pi: ExtensionAPI) {
	let restoreEditor: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previousEditor = ctx.ui.getEditorComponent();
		restoreEditor = () => ctx.ui.setEditorComponent(previousEditor);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const redirectsBuiltInTree =
					keybindings.matches(data, "tui.input.submit") &&
					!("isShowingAutocomplete" in editor && editor.isShowingAutocomplete()) &&
					editor.getText().trim() === "/tree";
				if (redirectsBuiltInTree) editor.setText("/tree-view");
				handleInput(data);
			};
			return editor;
		});
	});

	pi.on("session_shutdown", () => {
		restoreEditor?.();
		restoreEditor = undefined;
	});

	pi.registerCommand("tree-view", {
		description: "Navigate the current session in a centered undo-tree graph",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			await ctx.waitForIdle();
			const tree = ctx.sessionManager.getTree();
			const leafId = ctx.sessionManager.getLeafId();
			if (tree.length === 0) {
				ctx.ui.notify("No entries in session", "info");
				return;
			}

			const terminalColumns = process.stdout.columns ?? 120;
			const terminalRows = process.stdout.rows ?? 40;
			const modalWidth = Math.max(1, Math.min(140, terminalColumns - 2, Math.floor(terminalColumns * 0.86)));
			const modalHeight = Math.max(1, Math.min(48, terminalRows - 2, Math.floor(terminalRows * 0.84)));
			let initialSelectedId: string | undefined;
			while (true) {
				let modal: SessionTreeModal;
				const selectedId = await ctx.ui.custom<string | null>(
					(tui, theme, keybindings, done) => {
						modal = new SessionTreeModal(
							tree,
							leafId,
							Math.min(tui.terminal.rows, modalHeight),
							theme,
							keybindings,
							tui,
							(entryId) => done(entryId),
							() => done(null),
							async (text) => {
								if (!text) return ctx.ui.notify("Selected entry has no text to copy", "error");
								try {
									await copyToClipboard(text);
									ctx.ui.notify("Copied selected entry", "info");
								} catch (error) {
									ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
								}
							},
							(node) => {
								void ctx.ui.input("Label (empty to remove):", node.label).then((label) => {
									if (label === undefined) return;
									const normalized = label.trim() || undefined;
									pi.setLabel(node.entry.id, normalized);
									modal.updateLabel(node, normalized);
								});
							},
							initialSelectedId,
						);
						return modal;
					},
					{
						overlay: true,
						overlayOptions: { width: modalWidth, maxHeight: modalHeight, anchor: "center", margin: 1 },
					},
				);

				if (!selectedId) return;
				if (selectedId === leafId) {
					ctx.ui.notify("Already at this point", "info");
					return;
				}
				const summaryChoice = await ctx.ui.select("Summarize branch?", [
					"No summary",
					"Summarize",
					"Summarize with custom prompt",
				]);
				if (summaryChoice === undefined) {
					initialSelectedId = selectedId;
					continue;
				}
				let customInstructions: string | undefined;
				if (summaryChoice === "Summarize with custom prompt") {
					customInstructions = await ctx.ui.editor("Custom summarization instructions");
					if (customInstructions === undefined) {
						initialSelectedId = selectedId;
						continue;
					}
				}
				const result = await ctx.navigateTree(selectedId, {
					summarize: summaryChoice !== "No summary",
					customInstructions,
				});
				if (result.cancelled) ctx.ui.notify("Navigation cancelled", "info");
				return;
			}
		},
	});
}
