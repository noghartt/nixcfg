import {
	type ExtensionAPI,
	type ExtensionContext,
	type SlashCommandInfo,
	type Theme,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Focusable,
	Input,
	Key,
	type Keybinding,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

type CommandSource = SlashCommandInfo["source"] | "builtin" | "action";

type PaletteCommand = {
	name: string;
	description?: string;
	source: CommandSource;
	scope: string;
	sequence?: string;
};

type ModalItem<T> = {
	label: string;
	description?: string;
	group: string;
	hint?: string;
	searchText: string;
	value: T;
};

// Skills are left out: they are prompt context rather than actions, outnumber the
// commands, and stay reachable through `/skill:` autocomplete.
const SOURCE_ORDER: CommandSource[] = ["action", "builtin", "extension", "prompt"];
const SOURCE_LABELS: Record<CommandSource, string> = {
	action: "ACTIONS",
	builtin: "BUILT-IN",
	extension: "COMMANDS",
	prompt: "PROMPTS",
	skill: "SKILLS",
};

// Extension shortcuts have no listing API; these are the ones this config ships.
const EXTENSION_SHORTCUTS: [key: string, description: string][] = [
	["ctrl+p", "Open command palette"],
	["ctrl+?", "Show keybindings"],
	["ctrl+t", "Open session tree view"],
];

// Editor actions with neither a command nor an extension API. The palette fires
// them by sending their keybinding, which pi/settings.nix pins to these chords.
const PALETTE_ACTIONS: PaletteCommand[] = [
	{
		name: "toggle-thinking",
		description: "Show or hide thinking blocks",
		source: "action",
		scope: "action",
		sequence: "\x1b[116;8u", // shift+ctrl+alt+t
	},
];

// The engine's own slash completion, captured when the palette wraps it. Built-in
// commands are absent from pi.getCommands(), and Pi and OmO ship different sets,
// so the completion list is the one engine-agnostic place to read them from.
let engineAutocomplete: AutocompleteProvider | undefined;

// Extension commands stay out of slash autocomplete, except the swarm pair: `/leader`
// needs a typed goal, which a palette pick cannot supply, and `/swarms` sits beside it.
const SLASH_EXTENSION_COMMANDS = new Set(["leader", "swarms"]);

async function builtinCommands(registered: Set<string>): Promise<PaletteCommand[]> {
	if (!engineAutocomplete) return [];
	const suggestions = await engineAutocomplete.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
	return (suggestions?.items ?? [])
		.filter((item) => !registered.has(item.value))
		.map((item) => ({ name: item.value, description: item.description, source: "builtin" as const, scope: "built-in" }));
}

function commandItem(command: PaletteCommand): ModalItem<PaletteCommand> {
	const builtin = command.source === "builtin" || command.source === "action";
	const scope = command.scope === "project" || command.scope === "user" ? command.scope : "temporary";
	return {
		label: command.name,
		description: command.description,
		group: builtin ? SOURCE_LABELS[command.source] : `${SOURCE_LABELS[command.source]} · ${command.scope.toUpperCase()}`,
		hint: builtin ? undefined : scope,
		searchText: [command.name, command.description ?? "", command.source, command.scope].join(" ").toLowerCase(),
		value: command,
	};
}

function compareCommands(left: PaletteCommand, right: PaletteCommand): number {
	const sourceDifference = SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source);
	if (sourceDifference !== 0) return sourceDifference;
	const scopeDifference = left.scope.localeCompare(right.scope);
	if (scopeDifference !== 0) return scopeDifference;
	return left.name.localeCompare(right.name);
}

function keybindingItems(keybindings: KeybindingsManager): ModalItem<null>[] {
	const item = (keys: string, description: string, group: string): ModalItem<null> => ({
		label: keys,
		description,
		group,
		searchText: [keys, description, group].join(" ").toLowerCase(),
		value: null,
	});
	const builtin = Object.entries(keybindings.getResolvedBindings())
		.map(([id, keys]) => [id, [keys ?? []].flat()] as const)
		.filter(([, keys]) => keys.length > 0)
		.sort(([left], [right]) => Number(left.startsWith("tui.")) - Number(right.startsWith("tui.")) || left.localeCompare(right))
		.map(([id, keys]) =>
			item(keys.join(" / "), keybindings.getDefinition(id as Keybinding)?.description ?? id, id.split(".").slice(0, 2).join(".").toUpperCase()),
		);
	return [...EXTENSION_SHORTCUTS.map(([key, description]) => item(key, description, "EXTENSIONS")), ...builtin];
}

function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class SearchModal<T> implements Focusable {
	private readonly search = new Input();
	private filtered: ModalItem<T>[] = [];
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
		private readonly title: string,
		private readonly footer: string,
		private readonly labelWidth: number | undefined,
		private readonly items: ModalItem<T>[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (item: ModalItem<T> | null) => void,
	) {
		this.filtered = items;
		this.search.onSubmit = () => {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.done(selected);
		};
		this.search.onEscape = () => this.done(null);
	}

	private updateFilter(): void {
		const tokens = this.search.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		// Description matches would otherwise bury `/session` under `/clone`; rank by
		// label first, keeping group order within each rank.
		const rank = (item: ModalItem<T>) =>
			item.label.startsWith(tokens[0] ?? "") ? 0 : tokens.some((token) => item.label.includes(token)) ? 1 : 2;
		this.filtered = this.items
			.filter((item) => tokens.every((token) => item.searchText.includes(token)))
			.sort((left, right) => rank(left) - rank(right));
		this.selectedIndex = 0;
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
		lines.push(row(` ${this.theme.bold(this.theme.fg("accent", this.title))}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		// Input draws its own "> " prompt.
		lines.push(row(` ${this.search.render(Math.max(1, innerWidth - 2))[0] ?? ""}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		if (this.filtered.length === 0) {
			lines.push(row(` ${this.theme.fg("warning", "No matches")}`));
		} else {
			const maxRows = 12;
			const start = Math.max(0, Math.min(this.selectedIndex - 5, this.filtered.length - maxRows));
			const visible = this.filtered.slice(start, start + maxRows);
			let previousGroup: string | undefined;
			for (let offset = 0; offset < visible.length; offset++) {
				const item = visible[offset]!;
				if (item.group !== previousGroup) {
					lines.push(row(` ${this.theme.bold(this.theme.fg("borderAccent", item.group))}`));
					previousGroup = item.group;
				}
				const index = start + offset;
				const prefix = index === this.selectedIndex ? "› " : "  ";
				const label = this.labelWidth ? padToWidth(item.label, this.labelWidth) : item.label;
				const description = item.description ? `  ${this.theme.fg("muted", item.description)}` : "";
				const hint = item.hint ? `  ${this.theme.fg("dim", item.hint)}` : "";
				const fitted = ` ${truncateToWidth(`${prefix}${this.theme.bold(label)}${description}${hint}`, innerWidth - 2, "…")}`;
				lines.push(row(index === this.selectedIndex ? this.theme.bg("selectedBg", padToWidth(fitted, innerWidth)) : fitted));
			}
			if (this.filtered.length > maxRows) {
				lines.push(row(` ${this.theme.fg("dim", `${this.selectedIndex + 1}/${this.filtered.length}`)}`));
			}
		}

		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		lines.push(row(` ${this.theme.fg("dim", this.footer)}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}

function overlayOptions() {
	return {
		overlay: true,
		overlayOptions: {
			width: Math.max(1, Math.min(100, (process.stdout.columns ?? 120) - 4)),
			maxHeight: Math.max(12, Math.min(28, (process.stdout.rows ?? 40) - 4)),
			anchor: "center" as const,
			margin: 2,
		},
	};
}

async function showKeybindings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<ModalItem<null> | null>(
		(tui, theme, keybindings, done) =>
			new SearchModal("KEYBINDINGS", "type to filter · ↑↓ navigate · esc close", 24, keybindingItems(keybindings), theme, tui, done),
		overlayOptions(),
	);
}

async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	if (!ctx.isIdle()) {
		ctx.ui.notify("Commands can be opened after Pi finishes the current turn", "info");
		return;
	}

	const registered = pi.getCommands();
	const commands = [
		...PALETTE_ACTIONS,
		...(await builtinCommands(new Set(registered.map((command) => command.name)))),
		...registered
			.filter((command) => command.source !== "skill")
			.map((command) => ({
				name: command.name,
				description: command.description,
				source: command.source,
				scope: command.sourceInfo.scope,
			})),
	].sort(compareCommands);
	if (commands.length === 0) {
		ctx.ui.notify("No commands are registered", "info");
		return;
	}

	const picked = await ctx.ui.custom<ModalItem<PaletteCommand> | null>(
		(tui, theme, _keybindings, done) =>
			new SearchModal(
				"COMMAND PALETTE",
				"type to filter · ↑↓ navigate · enter run · esc close",
				undefined,
				commands.map(commandItem),
				theme,
				tui,
				done,
			),
		overlayOptions(),
	);
	const selected = picked?.value;
	if (!selected) return;
	if (selected.sequence) {
		const sequence = selected.sequence;
		setImmediate(() => process.stdin.emit("data", sequence));
	} else if (selected.source === "builtin") {
		// Built-in commands run only from the interactive editor's submit handler;
		// no extension API reaches them. Submit the prefilled editor with the same
		// Enter a user would type, then put any draft back once the command took it.
		const draft = ctx.ui.getEditorText();
		ctx.ui.setEditorText(`/${selected.name}`);
		setImmediate(() => {
			process.stdin.emit("data", "\r");
			if (draft) setImmediate(() => ctx.ui.setEditorText(draft));
		});
	} else if (supportsCommandDispatch()) {
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
	// Ctrl+P is free only because keybindings move model cycling off it; Herdr
	// owns Alt+P for its pull-request tree.
	pi.registerShortcut(Key.ctrl("p"), {
		description: "Open command palette",
		handler: async (ctx) => showCommandPalette(pi, ctx),
	});
	// Ctrl+? is DEL in legacy terminals; Ghostty sends it as CSI-u instead.
	pi.registerShortcut(Key.ctrl("?"), {
		description: "Show keybindings",
		handler: async (ctx) => showKeybindings(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => {
			engineAutocomplete = current;
			return {
				triggerCharacters: current.triggerCharacters,
				async getSuggestions(lines, line, column, options) {
					const suggestions = await current.getSuggestions(lines, line, column, options);
					if (!suggestions) return suggestions;
					const extensionCommands = new Set(
						pi
							.getCommands()
							.filter((command) => command.source === "extension" && !SLASH_EXTENSION_COMMANDS.has(command.name))
							.map((command) => command.name),
					);
					const items = suggestions.items.filter((item) => !extensionCommands.has(item.value.split(/\s/, 1)[0]!));
					return items.length > 0 ? { ...suggestions, items } : null;
				},
				applyCompletion: (lines, line, column, item, prefix) =>
					current.applyCompletion(lines, line, column, item, prefix),
				shouldTriggerFileCompletion: (lines, line, column) =>
					current.shouldTriggerFileCompletion?.(lines, line, column) ?? true,
			};
		});
	});
}
