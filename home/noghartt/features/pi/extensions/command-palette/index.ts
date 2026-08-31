import {
	type ExtensionAPI,
	type ExtensionContext,
	type SlashCommandInfo,
	type Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

type CommandSource = SlashCommandInfo["source"];

const SOURCE_ORDER: CommandSource[] = ["extension", "prompt", "skill"];
const SOURCE_LABELS: Record<CommandSource, string> = {
	extension: "COMMANDS",
	prompt: "PROMPTS",
	skill: "SKILLS",
};

function commandSearchText(command: SlashCommandInfo): string {
	return [
		command.name,
		command.description ?? "",
		command.source,
		command.sourceInfo.scope,
		command.sourceInfo.source,
	]
		.join(" ")
		.toLowerCase();
}

function compareCommands(left: SlashCommandInfo, right: SlashCommandInfo): number {
	const sourceDifference = SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source);
	if (sourceDifference !== 0) return sourceDifference;
	const scopeDifference = left.sourceInfo.scope.localeCompare(right.sourceInfo.scope);
	if (scopeDifference !== 0) return scopeDifference;
	return left.name.localeCompare(right.name);
}

function commandGroup(command: SlashCommandInfo): string {
	return `${SOURCE_LABELS[command.source]} · ${command.sourceInfo.scope.toUpperCase()}`;
}

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class CommandPalette implements Focusable {
	private readonly search = new Input();
	private filtered: SlashCommandInfo[] = [];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	constructor(
		private readonly commands: SlashCommandInfo[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (command: SlashCommandInfo | null) => void,
	) {
		this.filtered = commands;
		this.search.onSubmit = () => {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.done(selected);
		};
		this.search.onEscape = () => this.done(null);
	}

	private updateFilter(): void {
		const tokens = this.search.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		this.filtered = this.commands.filter((command) => {
			const searchable = commandSearchText(command);
			return tokens.every((token) => searchable.includes(token));
		});
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filtered.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.filtered.length > 0) this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
		} else {
			const previous = this.search.getValue();
			this.search.handleInput(data);
			if (this.search.getValue() !== previous) this.updateFilter();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const border = (text: string) => this.theme.fg("border", text);
		const row = (text: string) => `${border("│")}${padToWidth(text, innerWidth)}${border("│")}`;

		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(` ${this.theme.bold(this.theme.fg("accent", "COMMAND PALETTE"))}`));
		lines.push(row(` ${this.theme.fg("muted", "Search names, descriptions, groups, or scope")}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		const searchLine = this.search.render(Math.max(1, innerWidth - 4))[0] ?? "";
		lines.push(row(` ${this.theme.fg("accent", "> ")}${searchLine}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		if (this.filtered.length === 0) {
			lines.push(row(` ${this.theme.fg("warning", "No matching commands")}`));
		} else {
			const maxCommandRows = 8;
			const start = Math.max(0, Math.min(this.selectedIndex - 5, this.filtered.length - maxCommandRows));
			const visible = this.filtered.slice(start, start + maxCommandRows);
			let previousGroup: string | undefined;
			for (let offset = 0; offset < visible.length; offset++) {
				const command = visible[offset]!;
				const group = commandGroup(command);
				if (group !== previousGroup) {
					lines.push(row(` ${this.theme.bold(this.theme.fg("borderAccent", group))}`));
					previousGroup = group;
				}
				const index = start + offset;
				const prefix = index === this.selectedIndex ? "› " : "  ";
				const scope = command.sourceInfo.scope === "project" ? "project" : command.sourceInfo.scope === "user" ? "user" : "temporary";
				const description = command.description ? `  ${this.theme.fg("muted", command.description)}` : "";
				const commandLine = `${prefix}${this.theme.bold(command.name)}${description}  ${this.theme.fg("dim", scope)}`;
				const fitted = ` ${truncateToWidth(commandLine, innerWidth - 2, "…")}`;
				lines.push(row(index === this.selectedIndex ? this.theme.bg("selectedBg", padToWidth(fitted, innerWidth)) : fitted));
			}
			if (this.filtered.length > maxCommandRows) {
				lines.push(row(` ${this.theme.fg("dim", `${this.selectedIndex + 1}/${this.filtered.length}`)}`));
			}
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		lines.push(row(` ${this.theme.fg("dim", "type to filter · ↑↓ navigate · enter run · esc close")}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}

async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	if (!ctx.isIdle()) {
		ctx.ui.notify("Commands can be opened after Pi finishes the current turn", "info");
		return;
	}

	const commands = pi.getCommands().sort(compareCommands);
	if (commands.length === 0) {
		ctx.ui.notify("No commands are registered", "info");
		return;
	}

	const selected = await ctx.ui.custom<SlashCommandInfo | null>(
		(tui, theme, _keybindings, done) => new CommandPalette(commands, theme, tui, done),
		{
			overlay: true,
			overlayOptions: {
				width: Math.max(1, Math.min(100, (process.stdout.columns ?? 120) - 4)),
				maxHeight: Math.max(12, Math.min(24, (process.stdout.rows ?? 40) - 4)),
				anchor: "center",
				margin: 2,
			},
		},
	);
	if (!selected) return;
	if (supportsCommandDispatch()) {
		// expandPromptTemplates routes through session.prompt(), which executes
		// extension commands and expands prompts/skills instead of hitting the LLM.
		pi.sendUserMessage(`/${selected.name}`, { expandPromptTemplates: true } as never);
	} else {
		// Pi < 0.84.2 has no command dispatch API; sendUserMessage would ship the
		// raw "/name" text to the model backend. Prefill the editor so Enter runs
		// it through the same submit path as a typed command.
		ctx.ui.setEditorText(`/${selected.name}`);
		ctx.ui.notify(`Press enter to run /${selected.name}`, "info");
	}
}

function supportsCommandDispatch(): boolean {
	const [major = 0, minor = 0, patch = 0] = VERSION.split(".").map(Number);
	return major > 0 || minor > 84 || (minor === 84 && patch >= 2);
}

export default function commandPalette(pi: ExtensionAPI) {
	for (const shortcut of [Key.super("p"), Key.alt("p")]) {
		pi.registerShortcut(shortcut, {
			description: "Open command palette",
			handler: async (ctx) => showCommandPalette(pi, ctx),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: current.triggerCharacters,
			async getSuggestions(lines, line, column, options) {
				const suggestions = await current.getSuggestions(lines, line, column, options);
				if (!suggestions) return suggestions;
				const extensionCommands = new Set(
					pi.getCommands().filter((command) => command.source === "extension").map((command) => command.name),
				);
				const items = suggestions.items.filter((item) => !extensionCommands.has(item.value.split(/\s/, 1)[0]!));
				return items.length > 0 ? { ...suggestions, items } : null;
			},
			applyCompletion: (lines, line, column, item, prefix) => current.applyCompletion(lines, line, column, item, prefix),
			shouldTriggerFileCompletion: (lines, line, column) =>
				current.shouldTriggerFileCompletion?.(lines, line, column) ?? true,
		}));
	});
}
