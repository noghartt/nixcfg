"""A session-local agent tree for Herdr's native popup terminal."""

import concurrent.futures
import curses
import json
import os
import subprocess
import sys
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field


def clean(value):
    return "".join(c if c.isprintable() else " " for c in str(value or ""))


@dataclass
class Node:
    key: str
    label: str
    children: list = field(default_factory=list)
    agent: dict = field(default_factory=dict)
    context: str = ""

    @property
    def count(self):
        return 1 if self.agent else sum(child.count for child in self.children)


def build_tree(snapshot):
    workspaces = sorted(snapshot["workspaces"], key=lambda w: w["number"])
    tabs = {tab["tab_id"]: tab for tab in snapshot["tabs"]}
    nodes = {w["workspace_id"]: Node(w["workspace_id"], clean(w["label"])) for w in workspaces}
    roots_by_repo = {}
    for workspace in workspaces:
        worktree = workspace.get("worktree") or {}
        if worktree and not worktree["is_linked_worktree"]:
            roots_by_repo.setdefault(worktree["repo_key"], workspace["workspace_id"])

    for agent in snapshot["agents"]:
        parent = nodes.get(agent["workspace_id"])
        if parent is None:
            continue
        tab = tabs.get(agent["tab_id"], {})
        tab_label = clean(tab.get("label"))
        title = clean(agent.get("title")) or (tab_label if not tab_label.isdigit() else "")
        title = title or clean(agent.get("terminal_title_stripped")) or clean(agent.get("name"))
        title = title or tab_label or clean(agent.get("agent")) or agent["pane_id"]
        if title.endswith(" | " + parent.label):
            title = title[: -(len(parent.label) + 3)]
        cwd = clean(agent.get("foreground_cwd") or agent.get("cwd"))
        parent.children.append(Node(agent["pane_id"], title, agent=agent, context=cwd))

    roots = []
    for workspace in workspaces:
        node = nodes[workspace["workspace_id"]]
        worktree = workspace.get("worktree") or {}
        node.context = clean(worktree.get("checkout_path"))
        parent_id = roots_by_repo.get(worktree.get("repo_key"))
        if worktree.get("is_linked_worktree") and parent_id:
            nodes[parent_id].children.append(node)
        else:
            roots.append(node)

    def prune(node):
        node.children = [child for child in node.children if prune(child)]
        return bool(node.agent or node.children)

    roots = [root for root in roots if prune(root)]
    duplicate_labels = Counter(root.label for root in roots)
    numbers = {w["workspace_id"]: w["number"] for w in workspaces}
    for root in roots:
        if duplicate_labels[root.label] > 1:
            root.label += f" · #{numbers[root.key]}"
    return roots


def visible_rows(roots, query="", collapsed=frozenset()):
    terms = query.casefold().split()

    def visit(node, depth, inherited=False):
        haystack = f"{node.label} {node.context} {node.agent.get('agent', '')}".casefold()
        matches = inherited or all(term in haystack for term in terms)
        children = []
        for child in node.children:
            children.extend(visit(child, depth + 1, matches))
        if terms and not matches and not children:
            return []
        if node.key in collapsed and not terms:
            children = []
        return [(node, depth)] + children

    return [row for root in roots for row in visit(root, 0)]


def selection_index(rows, previous=None):
    for index, (node, _) in enumerate(rows):
        if node.key == previous:
            return index
    for index, (node, _) in enumerate(rows):
        if node.agent.get("focused"):
            return index
    return next((i for i, (node, _) in enumerate(rows) if node.agent), 0)


class Herdr:
    def call(self, *args):
        try:
            result = subprocess.run(
                [os.environ.get("HERDR_BIN_PATH", "herdr"), *args],
                capture_output=True, text=True, timeout=3, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"Herdr unavailable: {error}") from error
        try:
            response = json.loads(result.stdout or result.stderr)
        except ValueError as error:
            raise RuntimeError("Herdr returned an unreadable response") from error
        if result.returncode or "error" in response:
            error = response.get("error", {})
            message = error.get("message", "Herdr request failed") if isinstance(error, dict) else error
            raise RuntimeError(clean(message))
        return response["result"]

    def snapshot(self):
        return build_tree(self.call("api", "snapshot")["snapshot"])

    def focus(self, node):
        self.call("agent", "focus", node.key)


def clipped(text, width):
    result = ""
    used = 0
    for char in clean(text):
        cells = 0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in "WF" else 1)
        if used + cells > width:
            break
        result += char
        used += cells
    return result


def put(screen, y, x, text, style=0):
    height, width = screen.getmaxyx()
    if 0 <= y < height and 0 <= x < width - 1:
        try:
            screen.addstr(y, x, clipped(text, width - x - 1), style)
        except curses.error:
            pass


def run(screen, client):
    curses.set_escdelay(25)
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    screen.keypad(True)
    screen.timeout(100)
    colors = {}
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        for index, (state, color) in enumerate([
            ("blocked", curses.COLOR_RED), ("working", curses.COLOR_YELLOW),
            ("done", curses.COLOR_CYAN), ("idle", curses.COLOR_GREEN),
            ("unknown", curses.COLOR_WHITE),
        ], 1):
            curses.init_pair(index, color, -1)
            colors[state] = curses.color_pair(index)

    roots, rows, collapsed = [], [], set()
    selected, offset = 0, 0
    query, searching, message = "", False, "Loading agents…"
    stale, next_refresh, future = True, 0, None
    worker = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        while True:
            now = time.monotonic()
            previous = rows[selected][0].key if rows else None
            if future is not None and future.done():
                try:
                    roots = future.result()
                    stale, message = False, ""
                    rows = visible_rows(roots, query, collapsed)
                    selected = selection_index(rows, previous)
                except (RuntimeError, KeyError, TypeError, ValueError) as error:
                    stale, message = True, f"Refresh failed: {clean(error)} — Ctrl+R to retry"
                future, next_refresh = None, now + 2
            if future is None and now >= next_refresh:
                future = worker.submit(client.snapshot)

            height, width = screen.getmaxyx()
            capacity = max(1, height - 7)
            offset = max(0, min(offset, selected, max(0, len(rows) - capacity)))
            if selected >= offset + capacity:
                offset = selected - capacity + 1
            screen.erase()
            count = sum(root.count for root in roots)
            put(screen, 0, 1, f"AGENTS  ·  {count} running sessions", curses.A_BOLD)
            put(screen, 1, 1, f"/ {query}" + ("▏" if searching else ""), curses.A_BOLD if searching else curses.A_DIM)
            if not rows and not message:
                put(screen, 3, 2, "No matching agents" if query else "No agents in this Herdr session", curses.A_DIM)
            for y, (node, depth) in enumerate(rows[offset:offset + capacity], 3):
                index = offset + y - 3
                style = curses.A_REVERSE if index == selected else 0
                indent = "  " * depth
                if node.agent:
                    state = node.agent.get("agent_status", "unknown")
                    current = "›" if node.agent.get("focused") else " "
                    symbol = {"blocked": "!", "working": "●", "done": "✓", "idle": "○"}.get(state, "?")
                    kind = clean(node.agent.get("display_agent") or node.agent.get("agent"))
                    detail = f"{kind} · {state}"
                    available = max(1, width - len(detail) - 5) if width > 45 else width - 3
                    title = f"{current} {indent}{symbol} {node.label}"
                    put(screen, y, 1, clipped(title, available), style | colors.get(state, 0))
                    if width > 45:
                        put(screen, y, width - len(detail) - 2, detail, style | curses.A_DIM)
                else:
                    marker = "▸" if node.key in collapsed and not query else "▾"
                    put(screen, y, 1, f"  {indent}{marker} {node.label}  ({node.count})", style | curses.A_BOLD)
            if rows:
                put(screen, height - 3, 1, rows[selected][0].context, curses.A_DIM)
            put(screen, height - 2, 1, message or "↑↓/jk move  ←→/hl fold  Enter focus  / search", curses.A_DIM)
            put(screen, height - 1, 1, "Esc close  Ctrl+U clear search  Ctrl+R refresh", curses.A_DIM)
            screen.refresh()

            try:
                key = screen.get_wch()
            except curses.error:
                continue
            if key in ("\x1b", "\x03") or (key == "q" and not searching):
                return
            if key in (curses.KEY_DOWN, "\x0e") or (key == "j" and not searching):
                selected = min(len(rows) - 1, selected + 1) if rows else 0
                continue
            if key in (curses.KEY_UP, "\x10") or (key == "k" and not searching):
                selected = max(0, selected - 1)
                continue
            if key in (curses.KEY_NPAGE, curses.KEY_PPAGE):
                selected = max(0, min(len(rows) - 1, selected + (capacity if key == curses.KEY_NPAGE else -capacity)))
                continue
            if key == "\x12":
                next_refresh = 0
                continue
            if key in ("\n", "\r", curses.KEY_ENTER) and rows:
                node = rows[selected][0]
                if node.agent:
                    if stale:
                        message = "Waiting for a fresh agent list — Ctrl+R to retry"
                        continue
                    try:
                        client.focus(node)
                        return
                    except RuntimeError as error:
                        message, stale, next_refresh = str(error), True, 0
                        continue
                collapsed.symmetric_difference_update([node.key])
            elif key in (curses.KEY_LEFT, curses.KEY_RIGHT) or (not searching and key in ("h", "l")):
                if not rows:
                    continue
                node, depth = rows[selected]
                left = key in (curses.KEY_LEFT, "h")
                if left and node.children and node.key not in collapsed and not query:
                    collapsed.add(node.key)
                elif left:
                    selected = next((i for i in range(selected - 1, -1, -1) if rows[i][1] < depth), selected)
                elif node.children:
                    if node.key in collapsed and not query:
                        collapsed.remove(node.key)
                    else:
                        selected = min(len(rows) - 1, selected + 1)
            elif key == "/" and not searching:
                searching = True
            elif key == "\x15":
                query, searching = "", False
            elif key in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                query = query[:-1]
            elif searching and isinstance(key, str) and key.isprintable():
                query += key
            else:
                continue
            previous = rows[selected][0].key if rows else None
            rows = visible_rows(roots, query, collapsed)
            selected = selection_index(rows, previous)
    finally:
        worker.shutdown(wait=False, cancel_futures=True)


def main():
    if os.environ.get("HERDR_ENV") != "1":
        sys.exit("Open the agent navigator inside Herdr.")
    try:
        curses.wrapper(run, Herdr())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
