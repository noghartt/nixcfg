// opencode-style chrome for OmO: modal dialogs over a dimmed backdrop,
// compact tool rows, transcript cards and notice/widget cards. The prompt,
// title and working row belong to the sibling ui-prompt extension; the footer
// and sidebar to statusline.
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import backdrop from "./backdrop.ts";
import code from "./code.ts";
import { connect } from "./core/host.ts";
import dialogs from "./dialogs.ts";
import notices from "./notices.ts";
import tools from "./tools.ts";
import transcript from "./transcript.ts";
import widgets from "./widgets.ts";

export default function uiChrome(pi: ExtensionAPI): void {
	connect(pi);
	backdrop();
	dialogs();
	tools();
	transcript();
	code();
	notices();
	widgets(pi);
}
