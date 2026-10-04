// Every hook into OmO engine internals lives here, behind duck-typed guards: when a
// shape is missing the caller gets stock behaviour instead of an exception. Patches
// are keyed by Symbol.for so a /reload replaces the previous handler instead of
// stacking a second wrapper on the same object.
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";

const CONTAINER_HOOK = Symbol.for("nixcfg.ui-prompt.container-add-child");
const CURSOR_HOOK = Symbol.for("nixcfg.ui-prompt.cursor");

export type ChildWrapper = (child: Component) => Component | undefined;

type AddChildHook = { original: Container["addChild"]; wrap: ChildWrapper | undefined; patched: Container["addChild"] };
type HookedContainer = Container & { [CONTAINER_HOOK]?: AddChildHook };

type CursorState = { hardwareEnabledByUs: boolean };
type CursorTui = TUI & {
	[CURSOR_HOOK]?: CursorState;
	getShowHardwareCursor?: () => boolean;
	setShowHardwareCursor?: (enabled: boolean) => void;
	terminal?: { write?: (data: string) => void };
};

type TreeNode = {
	children?: unknown;
	entries?: unknown;
	layoutRoot?: unknown;
	child?: unknown;
	content?: unknown;
	component?: unknown;
};

// The editor's parent is the InteractiveMode editorContainer, which is also where the
// engine mounts the ask-user question in the editor's place. Nothing exposes it, so it
// is located by walking the mounted tree (statusline's HStack included) for the editor.
export function findParentContainer(tui: TUI, target: Component): Container | undefined {
	const mounted = tui as TUI & { getMountedRoots?: () => Component[] };
	const roots: unknown[] = typeof mounted.getMountedRoots === "function" ? mounted.getMountedRoots() : [tui];
	const seen = new Set<object>();
	const stack: unknown[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		const { children, entries, layoutRoot, child, content, component } = node as TreeNode;
		if (Array.isArray(children)) {
			if (children.includes(target) && node instanceof Container) return node;
			stack.push(...children);
		}
		if (Array.isArray(entries)) {
			for (const entry of entries) stack.push((entry as { component?: unknown })?.component);
		}
		stack.push(layoutRoot, child, content, component);
	}
	return undefined;
}

export function hookAddChild(container: Container, wrap: ChildWrapper): () => void {
	const hooked = container as HookedContainer;
	let hook = hooked[CONTAINER_HOOK];
	// Another extension re-wrapping addChild from the engine's original (ui-chrome does on
	// /reload) drops this hook from the chain; re-wrap whatever is installed now.
	if (!hook || container.addChild !== hook.patched) {
		const installed: AddChildHook = { original: container.addChild, wrap: hook?.wrap, patched: container.addChild };
		installed.patched = function patchedAddChild(this: Container, child: Component) {
			const replacement = installed.wrap?.(child);
			installed.original.call(this, replacement ?? child);
		};
		hooked[CONTAINER_HOOK] = installed;
		container.addChild = installed.patched;
		hook = installed;
	}
	hook.wrap = wrap;
	return () => {
		if (hook?.wrap === wrap) hook.wrap = undefined;
	};
}

// DECSCUSR only shows once the hardware cursor is visible; OmO draws a reverse-video
// fake cursor by default, so the TUI's own public toggle is flipped for the session.
export function enableBarCursor(tui: TUI): boolean {
	const host = tui as CursorTui;
	if (typeof host.terminal?.write !== "function") return false;
	if (!host[CURSOR_HOOK]) {
		let hardwareEnabledByUs = false;
		if (typeof host.getShowHardwareCursor === "function" && typeof host.setShowHardwareCursor === "function") {
			if (!host.getShowHardwareCursor()) {
				host.setShowHardwareCursor(true);
				hardwareEnabledByUs = true;
			}
		} else {
			return false;
		}
		host[CURSOR_HOOK] = { hardwareEnabledByUs };
	}
	host.terminal.write("\x1b[5 q");
	return true;
}

export function restoreCursor(tui: TUI): void {
	const host = tui as CursorTui;
	const state = host[CURSOR_HOOK];
	if (!state) return;
	host.terminal?.write?.("\x1b[0 q");
	if (state.hardwareEnabledByUs) host.setShowHardwareCursor?.(false);
	delete host[CURSOR_HOOK];
}
