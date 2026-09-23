"""Regression tests for grouping and navigating live Herdr agent metadata."""

import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent_tree", Path(__file__).with_name("agent-tree.py"))
tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tree)


def workspace(key, label, number, linked=False, repo=None):
    result = {"workspace_id": key, "label": label, "number": number}
    if repo:
        result["worktree"] = {
            "repo_key": repo, "is_linked_worktree": linked,
            "checkout_path": f"/projects/{label}",
        }
    return result


def agent(workspace_id, title, focused=False):
    return {
        "workspace_id": workspace_id, "tab_id": f"{workspace_id}:t1",
        "pane_id": f"{workspace_id}:p1", "agent": "codex",
        "terminal_title_stripped": title, "agent_status": "idle", "focused": focused,
    }


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            "workspaces": [
                workspace("w1", "project", 1, repo="repo-1"),
                workspace("w2", "project/subproject", 2),
                workspace("w3", "Feature worktree", 3, linked=True, repo="repo-1"),
                workspace("w4", "Empty workspace", 4),
                workspace("w5", "project", 5, repo="repo-2"),
            ],
            "tabs": [{"tab_id": "w1:t1", "label": "1"}],
            "agents": [agent("w1", "Main task | project", True), agent("w2", "Nested task"),
                       agent("w3", "Implement search"), agent("w5", "Other repository")],
        }

    def test_worktrees_use_repo_identity_not_label_prefixes(self):
        roots = tree.build_tree(self.snapshot)
        self.assertEqual([node.key for node in roots], ["w1", "w2", "w5"])
        self.assertEqual([node.key for node in roots[0].children], ["w1:p1", "w3"])
        self.assertEqual(roots[0].children[0].label, "Main task")
        self.assertEqual(roots[0].count, 2)
        self.assertNotEqual(roots[0].label, roots[2].label)

    def test_parent_without_agents_remains_for_linked_worktree(self):
        self.snapshot["agents"] = [agent("w3", "Implement search")]
        roots = tree.build_tree(self.snapshot)
        self.assertEqual([node.key for node in roots], ["w1"])
        self.assertEqual(roots[0].children[0].key, "w3")

    def test_orphan_worktree_is_a_root(self):
        self.snapshot["workspaces"] = self.snapshot["workspaces"][1:]
        roots = tree.build_tree(self.snapshot)
        self.assertIn("w3", [node.key for node in roots])

    def test_search_preserves_ancestors_and_opens_collapsed_groups(self):
        rows = tree.visible_rows(tree.build_tree(self.snapshot), "IMPLEMENT search", {"w1", "w3"})
        self.assertEqual([(node.key, depth) for node, depth in rows], [("w1", 0), ("w3", 1), ("w3:p1", 2)])

    def test_searching_workspace_includes_its_agents(self):
        rows = tree.visible_rows(tree.build_tree(self.snapshot), "project/subproject")
        self.assertEqual([node.key for node, _ in rows], ["w2", "w2:p1"])

    def test_folding_keeps_other_workspaces_visible(self):
        rows = tree.visible_rows(tree.build_tree(self.snapshot), collapsed={"w1"})
        self.assertEqual([node.key for node, _ in rows], ["w1", "w2", "w2:p1", "w5", "w5:p1"])

    def test_refresh_keeps_selection_by_id_and_handles_agent_exit(self):
        rows = tree.visible_rows(tree.build_tree(self.snapshot))
        self.assertEqual(rows[tree.selection_index(rows, "w3:p1")][0].key, "w3:p1")
        self.snapshot["agents"] = [self.snapshot["agents"][0]]
        rows = tree.visible_rows(tree.build_tree(self.snapshot))
        self.assertEqual(rows[tree.selection_index(rows, "w3:p1")][0].key, "w1:p1")
        self.assertEqual(tree.selection_index([], "w3:p1"), 0)

    def test_labels_sanitize_controls_and_clip_wide_characters(self):
        self.assertEqual(tree.clean("title\nnext\x1b"), "title next ")
        self.assertEqual(tree.clipped("界a", 2), "界")
        self.assertEqual(tree.clipped("e\u0301a", 1), "e\u0301")

    def test_named_tabs_take_precedence_over_terminal_titles(self):
        self.snapshot["tabs"][0]["label"] = "Explicit task name"
        roots = tree.build_tree(self.snapshot)
        self.assertEqual(roots[0].children[0].label, "Explicit task name")


class ClientTests(unittest.TestCase):
    @patch.object(tree.subprocess, "run")
    def test_focus_uses_opaque_pane_id_as_an_argument(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps({"result": {}}), "")
        tree.Herdr().focus(tree.Node("wA:pB", "Untrusted $(title)"))
        self.assertEqual(run.call_args.args[0][-3:], ["agent", "focus", "wA:pB"])
        self.assertNotIn("shell", run.call_args.kwargs)

    @patch.object(tree.subprocess, "run")
    def test_disappeared_agent_is_reported(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, "", json.dumps({"error": {"message": "Agent not found"}}))
        with self.assertRaisesRegex(RuntimeError, "Agent not found"):
            tree.Herdr().focus(tree.Node("w1:p9", "Exited"))

    @patch.object(tree.subprocess, "run", side_effect=subprocess.TimeoutExpired("herdr", 3))
    def test_unresponsive_server_is_bounded(self, _run):
        with self.assertRaisesRegex(RuntimeError, "Herdr unavailable"):
            tree.Herdr().snapshot()


if __name__ == "__main__":
    unittest.main()
