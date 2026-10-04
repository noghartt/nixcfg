// Widgets OmO's built-ins and plugins set around the prompt (running subagents,
// DAG progress, the todo list, web search progress) and the /btw side answer,
// drawn as cards. Only these keys are restyled: the ask-user widget and any
// widget the ui-prompt extension owns keep their own look.
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { onWidget, theme, type WidgetContent } from "./core/host.ts";
import { type Component, stripAnsi } from "./core/style.ts";
import { noticeCard, type Tone } from "./notices.ts";

const CARDED: Record<string, Tone> = {
	btw: "accent",
	"ext:nested-agents:widget": "muted",
	"omo-task": "muted",
	"omo-dag": "muted",
	"todo-sidebar": "muted",
	"anthropic-web-search": "muted",
	"openai-web-search": "muted",
	"pi-webfetch": "muted",
	"pi-websearch": "muted",
};

// The statusline sidebar lists the same todos, so OmO's widget above the prompt is
// blanked while the sidebar reports itself on screen and returns when it is not.
const TODO_WIDGET = "todo-sidebar";
let sidebarShown = false;

// The card replaces the rules some widgets (/btw) draw around themselves.
const RULE = /^[\s─━═]+$/;

function carded(component: Component, tone: Tone): Component {
	const render = component.render.bind(component);
	component.render = (width: number) => {
		const th = theme();
		if (!th) return render(width);
		const lines = render(width - 1).filter((line) => !RULE.test(stripAnsi(line)) || !stripAnsi(line).trim());
		return noticeCard(th, tone, lines, width).filter((line, index) => index > 0 || line !== "");
	};
	return component;
}

// Patched in place, like carded, so OmO's dispose and other methods stay on the component.
function unlessSidebar(component: Component): Component {
	const render = component.render.bind(component);
	component.render = (width: number) => (sidebarShown ? [] : render(width));
	return component;
}

export default function widgets(pi: ExtensionAPI): void {
	pi.events.on("statusline:sidebar", (event) => {
		sidebarShown = (event as { shown?: boolean }).shown === true;
	});
	onWidget((key, content): WidgetContent => {
		const tone = CARDED[key];
		if (!tone) return content;
		const card: WidgetContent = Array.isArray(content)
			? () => carded({ render: () => content.map((line) => ` ${line}`), invalidate() {} }, tone)
			: (tui, th) => carded(content(tui, th), tone);
		return key === TODO_WIDGET ? (tui, th) => unlessSidebar(card(tui, th)) : card;
	});
}
