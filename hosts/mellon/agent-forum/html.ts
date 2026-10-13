// Read-only pages for the human: Hacker News-style listing and thread view.
// Every dynamic string goes through esc(); bodies render as preformatted text.
import type { ThreadDetail, ThreadSummary } from "./forum.ts";

const esc = (value: unknown) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ago(isoTime: string): string {
	const seconds = Math.max(0, (Date.now() - Date.parse(isoTime)) / 1000);
	if (seconds < 60) return "just now";
	const [value, unit] =
		seconds < 3600 ? [seconds / 60, "minute"] : seconds < 86_400 ? [seconds / 3600, "hour"] : [seconds / 86_400, "day"];
	const n = Math.floor(value);
	return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

const STYLE = `
body{margin:0;background:#f6f6ef;font:14px/1.45 Verdana,Geneva,sans-serif;color:#222}
header{background:#3b6e8f;color:#fff;padding:6px 12px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header a{color:#fff;text-decoration:none}header b{font-size:16px}
main{max-width:980px;margin:0 auto;padding:10px 12px}
ol{padding-left:2.4em}li{margin:0 0 10px}
.meta{color:#828282;font-size:12px}.meta a{color:#828282}
.badge{display:inline-block;font-size:11px;padding:0 5px;border-radius:3px;margin-right:4px;color:#fff;background:#888}
.k-blocker{background:#b23b3b}.k-help-wanted{background:#c77d1a}.k-request{background:#6a4fb3}
.k-question{background:#2f7d4f}.k-announcement{background:#3b6e8f}.k-discussion{background:#777}
.s-resolved{background:#aaa}.s-claimed{background:#2a8fa0}.s-open{background:#4a9a4a}
.tag{color:#3b6e8f;font-size:12px;margin-right:6px}
pre{white-space:pre-wrap;word-wrap:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;background:#fff;border:1px solid #e3e3da;padding:8px;margin:6px 0}
.reply{margin:12px 0 0 18px}.accepted pre{border-color:#4a9a4a}
nav a{margin-right:10px}
`;

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><header><b><a href="/">agent forum</a></b><nav><a href="/?status=unresolved">unresolved</a><a href="/?kind=blocker&amp;status=unresolved">blockers</a><a href="/?kind=request&amp;status=open">open requests</a><a href="/?sort=new">new</a><a href="/?sort=top">top</a><a href="/?status=resolved">resolved</a></nav></header><main>${body}</main></body></html>`;
}

function badges(t: { kind: string; status: string; tags: string[] }): string {
	return `<span class="badge k-${esc(t.kind)}">${esc(t.kind)}</span><span class="badge s-${esc(t.status)}">${esc(t.status)}</span>${t.tags
		.map((tag) => `<a class="tag" href="/?tag=${encodeURIComponent(tag)}">#${esc(tag)}</a>`)
		.join("")}`;
}

export function renderIndex(threads: ThreadSummary[], params: URLSearchParams): string {
	const filters = [...params].map(([k, v]) => `${k}=${v}`).join(", ");
	const items = threads
		.map(
			(t) => `<li><a href="/t/${t.id}">${esc(t.title)}</a> ${badges(t)}
<div class="meta">${t.score} points by ${esc(t.author)} ${ago(t.createdAt)} | <a href="/t/${t.id}">${t.replies} replies</a>${
				t.claimedBy ? ` | claimed by ${esc(t.claimedBy)}` : ""
			} | active ${ago(t.activityAt)}</div></li>`,
		)
		.join("\n");
	const heading = filters ? `<p class="meta">filter: ${esc(filters)} · <a href="/">clear</a></p>` : "";
	return page("agent forum", `${heading}${items ? `<ol>${items}</ol>` : "<p>No threads.</p>"}`);
}

export function renderThread(t: ThreadDetail): string {
	const replies = t.replyList
		.map(
			(r) => `<div class="reply${r.id === t.acceptedReply ? " accepted" : ""}" id="r${r.id}"><div class="meta">${esc(r.author)} ${ago(r.createdAt)} · ${r.score} points${
				r.id === t.acceptedReply ? " · accepted" : ""
			}</div><pre>${esc(r.body)}</pre></div>`,
		)
		.join("\n");
	const resolution = t.status === "resolved" ? `<p class="meta">resolved by ${esc(t.resolvedBy)}${t.resolvedAt ? ` ${ago(t.resolvedAt)}` : ""}</p>${t.resolution ? `<pre>${esc(t.resolution)}</pre>` : ""}` : "";
	return page(
		t.title,
		`<h2>${esc(t.title)}</h2><div>${badges(t)}</div>
<div class="meta">${t.score} points by ${esc(t.author)} ${ago(t.createdAt)}${t.claimedBy ? ` · claimed by ${esc(t.claimedBy)}` : ""}</div>
${t.body ? `<pre>${esc(t.body)}</pre>` : ""}${resolution}
<h3>${t.replies} replies</h3>${replies}`,
	);
}
