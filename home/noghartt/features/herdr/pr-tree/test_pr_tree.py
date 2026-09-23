import asyncio
import curses
from contextlib import ExitStack
from itertools import product
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import pr_tree as tree


def pr(repo="example/alpha", number=1, title="Fix the tree", draft=False, review=None, ci=None):
    return {
        "number": number, "title": title, "isDraft": draft,
        "url": f"https://github.com/{repo}/pull/{number}",
        "repository": {"nameWithOwner": repo}, "updatedAt": "2026-01-01T00:00:00Z",
        "reviewDecision": review, "statusCheckRollup": {"state": ci} if ci else None,
    }


def page(prs, more=False):
    return {"data": {"viewer": {"login": "example-user", "pullRequests": {
        "nodes": prs, "pageInfo": {"hasNextPage": more, "endCursor": "cursor" if more else None},
    }}}}


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.view = tree.Tree()
        _, self.view.roots = tree.parse_pages([page([
            pr("example/beta", 3), pr(title="Unicode 日本語"), pr(number=2, draft=True),
        ])])
        self.view.rebuild()

    def test_pagination_grouping_deduplication_and_order(self):
        login, roots = tree.parse_pages([
            page([pr("example/zeta"), pr(number=9)], more=True),
            page([pr(number=9), pr(number=8)]),
        ])
        self.assertEqual(login, "example-user")
        self.assertEqual([root.key for root in roots], ["example/alpha", "example/zeta"])
        self.assertEqual([node.label for node in roots[0].children], ["#9  Fix the tree", "#8  Fix the tree"])

    def test_empty_account(self):
        self.assertEqual(tree.parse_pages([page([])])[1], [])

    def test_incomplete_or_failed_pages_are_rejected(self):
        for pages in ([], [page([], more=True)], [{"errors": [{"message": "denied"}]}]):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                tree.parse_pages(pages)

    def test_filter_terms_match_across_repository_and_title(self):
        rows = tree.visible_rows(self.view.roots, "alpha 日本語")
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[1][0].label.endswith("日本語"))
        self.assertEqual(len(tree.visible_rows(self.view.roots, "alpha draft")), 2)

    def test_filter_reveals_collapsed_matches(self):
        self.view.key("h", 10)
        self.view.key("h", 10)
        self.assertEqual(len(self.view.rows), 3)
        self.view.key("/", 10)
        for char in "日本語":
            self.view.key(char, 10)
        self.assertEqual(len(self.view.rows), 2)
        self.view.key("\x1b", 10)
        self.assertIn("example/alpha", self.view.collapsed)

    def test_enter_copy_and_search_controls(self):
        self.assertEqual(self.view.key("\n", 10), "open")
        self.assertEqual(self.view.key("y", 10), "copy")
        self.view.key("/", 10)
        self.view.key("y", 10)
        self.assertEqual(self.view.query, "y")
        self.assertIsNone(self.view.key("\n", 10))
        self.assertFalse(self.view.searching)
        self.view.key("\x15", 10)
        self.assertEqual(self.view.key("q", 10), "quit")

    def test_selection_survives_refresh_and_disappearing_pr(self):
        self.view.key("j", 10)
        selected = self.view.current.key
        _, self.view.roots = tree.parse_pages([page([pr(number=6), pr(number=2)])])
        self.view.rebuild()
        self.assertEqual(self.view.current.key, selected)
        _, self.view.roots = tree.parse_pages([page([])])
        self.view.rebuild()
        for key in (curses.KEY_NPAGE, "j", "G", "h", "y", "\n"):
            self.assertIsNone(self.view.key(key, 10))
        self.assertIsNone(self.view.current)

    def test_actions_never_fire_on_repository_rows(self):
        self.view.key("g", 10)
        self.assertIsNone(self.view.key("y", 10))
        self.assertIsNone(self.view.key("\n", 10))
        self.assertIn("example/alpha", self.view.collapsed)

    def test_sanitize_terminal_controls_and_clip_wide_text(self):
        _, roots = tree.parse_pages([page([pr(title="title\n\x1b[31m")])])
        self.assertNotIn("\x1b", roots[0].children[0].label)
        self.assertEqual(tree.clipped("a日本", 4), "a日")


class StatusTests(unittest.TestCase):
    def test_review_and_ci_are_independent_including_drafts(self):
        reviews = [
            ("CHANGES_REQUESTED", "changes requested", "red"),
            ("REVIEW_REQUIRED", "review required", "yellow"),
            ("APPROVED", "approved", "green"),
            (None, "review n/a", "neutral"),
            ("FUTURE_REVIEW", "review unknown", "neutral"),
        ]
        checks = [
            ("ERROR", "CI error", "red"),
            ("FAILURE", "CI failed", "red"),
            ("EXPECTED", "CI pending", "yellow"),
            ("PENDING", "CI pending", "yellow"),
            ("SUCCESS", "CI passed", "green"),
            (None, "no checks", "neutral"),
            ("FUTURE_CI", "CI unknown", "neutral"),
        ]
        for draft, review, ci in product((False, True), reviews, checks):
            with self.subTest(draft=draft, review=review[0], ci=ci[0]):
                _, roots = tree.parse_pages([page([pr(draft=draft, review=review[0], ci=ci[0])])])
                actual = [(badge.label, badge.tone) for badge in tree.badges(roots[0].children[0])]
                expected = [("draft", "neutral")] if draft else []
                expected += [review[1:], ci[1:]]
                self.assertEqual(actual, expected)

    def test_missing_status_fields_do_not_imply_success(self):
        item = pr()
        del item["reviewDecision"], item["statusCheckRollup"]
        _, roots = tree.parse_pages([page([item])])
        self.assertEqual([badge.label for badge in tree.badges(roots[0].children[0])],
                         ["review n/a", "no checks"])

    def test_statuses_survive_pagination_and_refresh(self):
        view = tree.Tree()
        _, view.roots = tree.parse_pages([
            page([pr(number=1, review="APPROVED", ci="FAILURE")], more=True),
            page([pr(number=2, review="CHANGES_REQUESTED", ci="SUCCESS")]),
        ])
        view.rebuild()
        view.key("j", 10)
        self.assertEqual(view.current.review, "CHANGES_REQUESTED")
        _, view.roots = tree.parse_pages([page([pr(number=2, review="APPROVED", ci="PENDING")])])
        view.rebuild()
        self.assertEqual((view.current.review, view.current.ci), ("APPROVED", "PENDING"))

    def test_status_search_matches_labels_and_raw_states(self):
        _, roots = tree.parse_pages([page([
            pr(number=1, review="APPROVED", ci="FAILURE"),
            pr(number=2, review="REVIEW_REQUIRED", ci="SUCCESS"),
            pr(number=3, draft=True, review="CHANGES_REQUESTED", ci="PENDING"),
            pr(number=4), pr(number=5, review="FUTURE_REVIEW", ci="FUTURE_CI"),
        ])])
        for query, numbers in [
            ("approved failed", [1]), ("alpha failure", [1]), ("review required passed", [2]),
            ("draft changes requested pending", [3]), ("no checks", [4]), ("unknown", [5]),
        ]:
            with self.subTest(query=query):
                rows = tree.visible_rows(roots, query, {roots[0].key})
                self.assertEqual([int(node.url.rsplit("/", 1)[1]) for node, depth in rows if depth], numbers)


class Screen:
    """Record cells and attributes while rejecting any out-of-bounds writes."""
    def __init__(self, width, height=2):
        self.width, self.height = width, height
        self.cells = [[" "] * width for _ in range(height)]
        self.writes = []

    def getmaxyx(self):
        return self.height, self.width

    def addstr(self, y, x, text, style):
        assert 0 <= y < self.height and 0 <= x < self.width - 1
        assert x + sum(tree.cell_width(char) for char in text) <= self.width - 1
        self.writes.append((y, x, text, style))
        for char in text:
            cells = tree.cell_width(char)
            if cells:
                self.cells[y][x] = char
                x += cells

    def line(self):
        return "".join(self.cells[0])


class RenderTests(unittest.TestCase):
    def setUp(self):
        _, roots = tree.parse_pages([page([
            pr(title="Long 日本語 title " * 40, draft=True, review="CHANGES_REQUESTED", ci="FAILURE"),
        ])])
        self.node = roots[0].children[0]
        self.palette = {"red": 256, "yellow": 512, "green": 768, "neutral": 1024}

    def test_long_title_reserves_full_badges_on_normal_and_selected_rows(self):
        for style in (0, curses.A_REVERSE):
            with self.subTest(style=style):
                screen = Screen(100)
                tree.draw_pr(screen, 0, self.node, style, self.palette)
                self.assertIn("#1", screen.line())
                for label in ("[draft]", "[changes requested]", "[CI failed]"):
                    self.assertIn(label, screen.line())
                badge_writes = [write for write in screen.writes if write[2].startswith("[")]
                self.assertEqual([write[3] & curses.A_COLOR for write in badge_writes], [1024, 256, 256])
                self.assertTrue(all(write[3] & curses.A_REVERSE == style for write in screen.writes))

    def test_monochrome_keeps_meaning_and_selection(self):
        self.node.review, self.node.ci = "APPROVED", "PENDING"
        screen = Screen(100)
        tree.draw_pr(screen, 0, self.node, curses.A_REVERSE, {})
        self.assertIn("[approved] [CI pending]", screen.line())
        self.assertTrue(all(write[3] & curses.A_REVERSE for write in screen.writes))
        self.assertTrue(all(not write[3] & curses.A_COLOR for write in screen.writes))

    def test_success_and_pending_have_distinct_colors(self):
        self.node.review, self.node.ci = "APPROVED", "PENDING"
        screen = Screen(100)
        tree.draw_pr(screen, 0, self.node, 0, self.palette)
        colors = {text: style & curses.A_COLOR for _, _, text, style in screen.writes}
        self.assertEqual(colors["[approved]"], 768)
        self.assertEqual(colors["[CI pending]"], 512)

    def test_narrow_rows_keep_compact_draft_review_and_ci(self):
        for width in (16, 20, 30, 45):
            with self.subTest(width=width):
                screen = Screen(width)
                tree.draw_pr(screen, 0, self.node, curses.A_REVERSE, self.palette)
                self.assertIn("[D] [R!] [C!]", screen.line())

    def test_all_widths_and_short_heights_stay_in_bounds(self):
        for width, height in product(range(110), range(3)):
            with self.subTest(width=width, height=height):
                screen = Screen(width, height)
                tree.draw_pr(screen, 0, self.node, curses.A_REVERSE, self.palette)

    def test_resize_errors_are_tolerated(self):
        screen = Screen(100)
        with patch.object(screen, "addstr", side_effect=curses.error("resized")):
            tree.draw_pr(screen, 0, self.node, curses.A_REVERSE, self.palette)


class ColorTests(unittest.TestCase):
    def color_mocks(self, stack):
        return {name: stack.enter_context(patch.object(tree.curses, name)) for name in
                ("start_color", "has_colors", "use_default_colors", "init_pair", "color_pair")}

    def test_terminal_palette_uses_default_background(self):
        with ExitStack() as stack:
            mocks = self.color_mocks(stack)
            mocks["has_colors"].return_value = True
            mocks["color_pair"].side_effect = lambda index: index << 8
            self.assertEqual(tree.init_colors(), {"red": 256, "yellow": 512, "green": 768, "neutral": 1024})
            self.assertEqual([call.args for call in mocks["init_pair"].call_args_list], [
                (1, curses.COLOR_RED, -1), (2, curses.COLOR_YELLOW, -1),
                (3, curses.COLOR_GREEN, -1), (4, curses.COLOR_WHITE, -1),
            ])

    def test_no_color_terminal_and_partial_init_failure(self):
        for failure in ("no colors", "start_color", "init_pair", "color_pair"):
            with self.subTest(failure=failure), ExitStack() as stack:
                mocks = self.color_mocks(stack)
                mocks["has_colors"].return_value = failure != "no colors"
                if failure != "no colors":
                    mocks[failure].side_effect = curses.error("unsupported")
                self.assertEqual(tree.init_colors(), {})

    def test_black_background_fallback(self):
        with ExitStack() as stack:
            mocks = self.color_mocks(stack)
            mocks["has_colors"].return_value = True
            mocks["use_default_colors"].side_effect = curses.error("unsupported")
            mocks["color_pair"].side_effect = lambda index: index << 8
            self.assertEqual(len(tree.init_colors()), 4)
            self.assertTrue(all(call.args[2] == curses.COLOR_BLACK for call in mocks["init_pair"].call_args_list))


class DesktopTests(unittest.TestCase):
    @patch.object(tree, "desktop_command")
    @patch.object(tree.sys, "platform", "darwin")
    def test_macos_uses_system_browser_and_copies_exact_url(self, run):
        url = pr()["url"]
        tree.open_url(url)
        run.assert_called_with(["/usr/bin/open", url])
        tree.copy_url(url)
        run.assert_called_with(["/usr/bin/pbcopy"], text=url)

    @patch.object(tree, "desktop_command")
    @patch.object(tree.sys, "platform", "linux")
    @patch.object(tree.shutil, "which", return_value="/bin/clipboard")
    def test_linux_desktop_clipboards(self, which, run):
        for env, command in [({"WAYLAND_DISPLAY": "wayland-0"}, ["wl-copy"]),
                             ({"DISPLAY": ":0"}, ["xclip", "-selection", "clipboard"])]:
            with patch.dict(os.environ, env, clear=True):
                tree.copy_url(pr()["url"])
                run.assert_called_with(command, text=pr()["url"])
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(RuntimeError):
            tree.copy_url(pr()["url"])

    @patch.object(tree, "desktop_command")
    def test_unsafe_urls_are_never_opened_or_copied(self, run):
        for url in ("file:///tmp/test", "javascript:alert(1)", "https://user:pass@github.com/a", "https://github.com/\n"):
            for action in (tree.open_url, tree.copy_url):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    action(url)
        run.assert_not_called()

    @patch.object(tree.subprocess, "run", side_effect=OSError("missing"))
    def test_desktop_errors_are_actionable(self, run):
        with self.assertRaisesRegex(RuntimeError, "desktop session"):
            tree.open_url(pr()["url"])


class FetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_gh_pagination_and_error_handling(self):
        process = AsyncMock()
        process.returncode = 0
        process.communicate.return_value = (json.dumps([page([pr()])]).encode(), b"")
        with patch.object(tree.asyncio, "create_subprocess_exec", return_value=process) as launch:
            _, roots = await tree.fetch_prs()
            self.assertEqual(len(roots), 1)
            launch.assert_called_once()
            self.assertIn("--paginate", launch.call_args.args)
            self.assertIn("--slurp", launch.call_args.args)
            self.assertTrue(tree.QUERY.lstrip().startswith("query("))
            self.assertIn("reviewDecision", tree.QUERY)
            self.assertIn("statusCheckRollup { state }", tree.QUERY)
            process.communicate.return_value = (b"not json", b"")
            with self.assertRaisesRegex(RuntimeError, "Cannot load PRs"):
                await tree.fetch_prs()
            process.returncode = 1
            process.communicate.return_value = (b"", b"Run gh auth login")
            with self.assertRaisesRegex(RuntimeError, "auth login"):
                await tree.fetch_prs()

    async def test_quit_kills_inflight_gh(self):
        # A real subprocess verifies cancellation reaps the child, not only the coroutine.
        real_launch = asyncio.create_subprocess_exec
        process = await real_launch(
            tree.sys.executable, "-c", "import time; time.sleep(30)",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        with patch.object(tree.asyncio, "create_subprocess_exec", return_value=process):
            task = asyncio.create_task(tree.fetch_prs())
            await asyncio.sleep(0.05)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNotNone(process.returncode)


if __name__ == "__main__":
    unittest.main()
