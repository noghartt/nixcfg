"""Herdr popup for the authenticated GitHub user's open pull requests."""

from __future__ import annotations

import asyncio
import curses
import json
import os
import shutil
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import urlsplit


# The viewer connection avoids search's result cap and indexing delay.
QUERY = """
query($endCursor: String) {
  viewer {
    login
    pullRequests(first: 100, after: $endCursor, states: OPEN,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft updatedAt repository { nameWithOwner }
        reviewDecision
        statusCheckRollup { state }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


def clean(value):
    return "".join(char if char.isprintable() else " " for char in str(value))


def valid_url(url):
    parts = urlsplit(url)
    if (parts.scheme != "https" or not parts.hostname or parts.username
            or parts.password or any(char.isspace() or not char.isprintable() for char in url)):
        raise ValueError("GitHub returned an invalid HTTPS URL")
    return url


@dataclass
class Node:
    key: str
    label: str
    repository: str
    url: str = ""
    draft: bool = False
    children: list = field(default_factory=list)
    review: str | None = None
    ci: str | None = None


@dataclass(frozen=True)
class Badge:
    label: str
    compact: str
    tone: str


REVIEW_BADGES = {
    "CHANGES_REQUESTED": Badge("changes requested", "R!", "red"),
    "REVIEW_REQUIRED": Badge("review required", "R~", "yellow"),
    "APPROVED": Badge("approved", "R+", "green"),
    None: Badge("review n/a", "R-", "neutral"),
}
CI_BADGES = {
    "ERROR": Badge("CI error", "C!", "red"),
    "FAILURE": Badge("CI failed", "C!", "red"),
    "EXPECTED": Badge("CI pending", "C~", "yellow"),
    "PENDING": Badge("CI pending", "C~", "yellow"),
    "SUCCESS": Badge("CI passed", "C+", "green"),
    None: Badge("no checks", "C-", "neutral"),
}


def badges(node):
    return ([Badge("draft", "D", "neutral")] if node.draft else []) + [
        REVIEW_BADGES.get(node.review, Badge("review unknown", "R?", "neutral")),
        CI_BADGES.get(node.ci, Badge("CI unknown", "C?", "neutral")),
    ]


def parse_pages(pages):
    if not isinstance(pages, list) or not pages:
        raise ValueError("GitHub returned no pages")
    repositories, seen, login = {}, set(), None
    for page in pages:
        if page.get("errors"):
            raise ValueError("GitHub returned an incomplete result; retry the refresh")
        viewer = page["data"]["viewer"]
        if login is not None and login != viewer["login"]:
            raise ValueError("GitHub account changed while loading")
        login = viewer["login"]
        for pr in viewer["pullRequests"]["nodes"]:
            url = valid_url(pr["url"])
            if url in seen:
                continue
            seen.add(url)
            repository = clean(pr["repository"]["nameWithOwner"])
            parent = repositories.setdefault(repository, Node(repository, repository, repository))
            parent.children.append(Node(
                url, f"#{pr['number']}  {clean(pr['title'])}", repository,
                url=url, draft=pr["isDraft"],
                review=pr.get("reviewDecision"),
                ci=(pr.get("statusCheckRollup") or {}).get("state"),
            ))
    if pages[-1]["data"]["viewer"]["pullRequests"]["pageInfo"]["hasNextPage"]:
        raise ValueError("GitHub pagination stopped before the last page")
    return clean(login), sorted(repositories.values(), key=lambda node: node.key.casefold())


async def fetch_prs():
    env = dict(os.environ, GH_PROMPT_DISABLED="1", GH_PAGER="cat", NO_COLOR="1")
    try:
        process = await asyncio.create_subprocess_exec(
            "gh", "api", "graphql", "--paginate", "--slurp", "-f", f"query={QUERY}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
    except OSError as error:
        raise RuntimeError("Cannot run gh; install GitHub CLI and run gh auth login") from error
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)
    except asyncio.TimeoutError as error:
        raise RuntimeError("GitHub timed out; press r to retry") from error
    finally:
        # Closing the popup must also stop an in-flight network request.
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.communicate()
    if process.returncode:
        detail = clean(stderr.decode("utf-8", errors="replace").strip())
        raise RuntimeError(detail or "GitHub request failed; check gh auth status")
    try:
        return parse_pages(json.loads(stdout))
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise RuntimeError(f"Cannot load PRs: {error}") from error


def visible_rows(roots, query="", collapsed=frozenset()):
    terms, rows = query.casefold().split(), []
    for root in roots:
        children = [child for child in root.children if all(
            term in search_text(child)
            for term in terms
        )]
        if not children:
            continue
        rows.append((root, 0))
        if terms or root.key not in collapsed:
            rows.extend((child, 1) for child in children)
    return rows


def search_text(node):
    status = " ".join(badge.label for badge in badges(node))
    raw = f"{node.review or ''} {node.ci or ''}".replace("_", " ")
    return f"{node.repository} {node.label} {'draft' if node.draft else 'open'} {status} {raw}".casefold()


def selection_index(rows, previous=None):
    return next((i for i, (node, _) in enumerate(rows) if node.key == previous),
                next((i for i, (node, _) in enumerate(rows) if node.url), 0))


def desktop_command(argv, text=None):
    try:
        # Clipboard helpers may fork; inherited output pipes would delay completion.
        subprocess.run(argv, input=text, text=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"{argv[0]} failed; check your desktop session") from error


def open_url(url):
    valid_url(url)
    desktop_command(["/usr/bin/open" if sys.platform == "darwin" else "xdg-open", url])


def copy_url(url):
    valid_url(url)
    if sys.platform == "darwin":
        command = ["/usr/bin/pbcopy"]
    elif os.environ.get("WAYLAND_DISPLAY") and shutil.which("wl-copy"):
        command = ["wl-copy"]
    elif os.environ.get("DISPLAY") and shutil.which("xclip"):
        command = ["xclip", "-selection", "clipboard"]
    else:
        raise RuntimeError("Clipboard unavailable; use a local macOS, Wayland, or X11 session")
    desktop_command(command, text=url)


def cell_width(char):
    return 0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in "WF" else 1)


def clipped(text, width):
    result, used = "", 0
    for char in clean(text):
        cells = cell_width(char)
        if used + cells > width:
            break
        result += char
        used += cells
    return result


def put(screen, y, text, style=0, x=1):
    height, width = screen.getmaxyx()
    if 0 <= y < height and 0 <= x < width - 1:
        try:
            screen.addstr(y, x, clipped(text, width - x - 1), style)
        except curses.error:
            pass


def init_colors():
    try:
        curses.start_color()
        if not curses.has_colors():
            return {}
        try:
            curses.use_default_colors()
            background = -1
        except curses.error:
            background = curses.COLOR_BLACK
        palette = {}
        for index, (tone, foreground) in enumerate([
            ("red", curses.COLOR_RED), ("yellow", curses.COLOR_YELLOW),
            ("green", curses.COLOR_GREEN), ("neutral", curses.COLOR_WHITE),
        ], 1):
            curses.init_pair(index, foreground, background)
            palette[tone] = curses.color_pair(index)
        return palette
    except curses.error:
        return {}


def draw_pr(screen, y, node, style, palette):
    width = max(0, screen.getmaxyx()[1] - 2)
    statuses = badges(node)
    labels = [f"[{badge.label}]" for badge in statuses]
    # Prefer a little title context; tiny terminals still keep both status axes.
    if len(" ".join(labels)) + 12 > width:
        labels = [f"[{badge.compact}]" for badge in statuses]
    badge_width = len(" ".join(labels))
    title_width = max(0, width - badge_width - 1)
    title = clipped(f"  ├─ {node.label}", title_width)
    padding = title_width - sum(cell_width(char) for char in title)
    put(screen, y, " " * width, style)
    put(screen, y, title + " " * padding, style)
    x = 1 + (title_width + 1 if title_width else 0)
    for badge, label in zip(statuses, labels):
        emphasis = curses.A_DIM if badge.tone == "neutral" else curses.A_BOLD
        put(screen, y, label, style | palette.get(badge.tone, 0) | emphasis, x=x)
        x += len(label) + 1


class Tree:
    def __init__(self):
        self.roots, self.rows, self.collapsed = [], [], set()
        self.query, self.searching = "", False
        self.selected = 0

    @property
    def current(self):
        return self.rows[self.selected][0] if self.rows else None

    def rebuild(self):
        previous = self.current.key if self.current else None
        self.rows = visible_rows(self.roots, self.query, self.collapsed)
        self.selected = selection_index(self.rows, previous)

    def key(self, key, capacity):
        """Return a desktop/lifecycle action, or update local navigation."""
        if key == "\x03":
            return "quit"
        if key == "\x1b":
            if self.searching or self.query:
                self.searching, self.query = False, ""
                self.rebuild()
                return
            return "quit"
        if key in ("\n", "\r", curses.KEY_ENTER):
            if self.searching:
                self.searching = False
            elif self.current:
                if self.current.url:
                    return "open"
                self.collapsed.symmetric_difference_update([self.current.key])
                self.rebuild()
            return
        if key == "\x15":
            self.query, self.searching = "", False
        elif key == "\x12" or (key == "r" and not self.searching):
            return "refresh"
        elif key in (curses.KEY_DOWN, curses.KEY_UP, curses.KEY_NPAGE, curses.KEY_PPAGE):
            delta = {curses.KEY_DOWN: 1, curses.KEY_UP: -1,
                     curses.KEY_NPAGE: capacity, curses.KEY_PPAGE: -capacity}[key]
            self.selected = max(0, min(len(self.rows) - 1, self.selected + delta))
            return
        elif self.searching:
            if key in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                self.query = self.query[:-1]
            elif isinstance(key, str) and key.isprintable():
                self.query += key
        elif key == "q":
            return "quit"
        elif key in ("y", "c") and self.current and self.current.url:
            return "copy"
        elif key in ("j", "k"):
            self.selected = max(0, min(len(self.rows) - 1, self.selected + (1 if key == "j" else -1)))
            return
        elif key in ("g", curses.KEY_HOME, "G", curses.KEY_END):
            self.selected = 0 if key in ("g", curses.KEY_HOME) else max(0, len(self.rows) - 1)
            return
        elif key == "/":
            self.searching = True
        elif self.current and key in ("h", "l", curses.KEY_LEFT, curses.KEY_RIGHT, " "):
            node = self.current
            if key in ("h", curses.KEY_LEFT):
                if node.url:
                    self.selected = next(i for i, (row, _) in enumerate(self.rows) if row.key == node.repository)
                else:
                    self.collapsed.add(node.key)
            elif not node.url:
                if key == " ":
                    self.collapsed.symmetric_difference_update([node.key])
                elif node.key in self.collapsed:
                    self.collapsed.remove(node.key)
                else:
                    self.selected = min(len(self.rows) - 1, self.selected + 1)
        self.rebuild()


async def run(screen):
    if hasattr(curses, "set_escdelay"):
        curses.set_escdelay(25)
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    screen.keypad(True)
    screen.nodelay(True)
    palette = init_colors()
    tree, login, offset = Tree(), "", 0
    message, error, updated, message_until = "", "", "", 0
    future, next_refresh = None, 0
    try:
        while True:
            if time.monotonic() >= message_until:
                message = ""
            if future is not None and future.done():
                try:
                    login, tree.roots = future.result()
                    tree.rebuild()
                    error, updated = "", time.strftime("%H:%M:%S")
                except RuntimeError as failure:
                    error = clean(str(failure))
                future, next_refresh = None, time.monotonic() + 60
            if future is None and time.monotonic() >= next_refresh:
                future = asyncio.create_task(fetch_prs())

            height, _ = screen.getmaxyx()
            capacity = max(1, height - 8)
            offset = max(0, min(offset, tree.selected, max(0, len(tree.rows) - capacity)))
            if tree.selected >= offset + capacity:
                offset = tree.selected - capacity + 1
            screen.erase()
            count = sum(len(root.children) for root in tree.roots)
            put(screen, 0, f"MY PULL REQUESTS  ·  {count} open  ·  {len(tree.roots)} repositories", curses.A_BOLD)
            status = "Refreshing…" if future else ("STALE" if error else f"Updated {updated}")
            put(screen, 1, f"{login or 'GitHub'}  ·  {status}", curses.A_DIM)
            put(screen, 2, f"/ {tree.query}" + ("▏" if tree.searching else ""))
            if not tree.rows:
                empty = "Loading your pull requests…" if future else (
                    "Unable to load pull requests" if error else
                    "No matching pull requests" if tree.query else "You have no open pull requests")
                put(screen, 4, empty, curses.A_DIM)
            for y, (node, depth) in enumerate(tree.rows[offset:offset + capacity], 4):
                style = curses.A_REVERSE if offset + y - 4 == tree.selected else 0
                if depth:
                    draw_pr(screen, y, node, style, palette)
                else:
                    marker = "▸" if node.key in tree.collapsed and not tree.query else "▾"
                    label = f"{marker} {node.label}  ({len(node.children)})"
                    style |= curses.A_BOLD
                    put(screen, y, label, style)
            if tree.current:
                put(screen, height - 4, tree.current.url or tree.current.repository, curses.A_DIM)
            put(screen, height - 3, message or error, curses.A_BOLD if error else curses.A_DIM)
            put(screen, height - 2, "↑↓/jk move  ←→/hl fold  Enter open  y/c copy URL", curses.A_DIM)
            put(screen, height - 1, "/ search  r refresh  Ctrl+U clear  Esc/q close", curses.A_DIM)
            screen.refresh()
            try:
                key = screen.get_wch()
            except curses.error:
                await asyncio.sleep(0.05)
                continue
            action = tree.key(key, capacity)
            if action == "quit":
                return
            if action == "refresh":
                next_refresh = 0
            elif action in ("open", "copy"):
                try:
                    (open_url if action == "open" else copy_url)(tree.current.url)
                    message = "Opened in your default browser" if action == "open" else "URL copied to clipboard"
                except (RuntimeError, ValueError) as failure:
                    message = clean(str(failure))
                message_until = time.monotonic() + 5
    finally:
        if future is not None:
            future.cancel()
            await asyncio.gather(future, return_exceptions=True)


if __name__ == "__main__":
    try:
        curses.wrapper(lambda screen: asyncio.run(run(screen)))
    except KeyboardInterrupt:
        pass
