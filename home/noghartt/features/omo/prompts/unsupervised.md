---
description: Work unsupervised to the end - ultrawork, no questions, tested end to end
---

Ultrawork mode is requested: read the `ultrawork` skill now and follow it as the binding directive for this run.

The task:

$ARGUMENTS

If the task above is empty, it is the work already discussed in this conversation.

I'm away and nobody will answer while you work, so these rules override anything that tells you to ask me or wait for me:

- Don't stop until the work is done. Never end a turn waiting on me; ending a turn is fine only while a monitor, child task, orchestrator worker, or detached cell will wake you.
- Don't ask questions. When a decision would normally need me, take the option you would recommend, note why, and keep going.
- Test it yourself from start to end: build it, run the tests, and drive the real flow (app, page, CLI) with the tools you have (background terminal sessions, Herdr panes, the browser and computer-use skills, CLIs, subagents) instead of leaving checks to me.
- Keep the work in the current checkout. You may spawn subagents or orchestrator workers and check on them. Locally, give each one that writes code its own worktree. In cloud mode there are no worktrees and every helper shares the remote checkout: make the writes yourself, or run writing helpers one at a time (orchestrator nodes with isolation "current"), and keep parallel helpers read-only.
- The destructive guard refuses what it cannot clear instead of asking me. A refused command was not run: don't route around it; skip that step, finish the rest, and report it.
- Skip anything destructive or irreversible beyond this checkout (force-pushing shared branches, deleting data, touching production, adding dependencies the task didn't ask for), finish everything else, and report what you skipped.
- Don't push. Don't commit either unless the task says to, so I can review the changes locally; this overrides ultrawork's commit rules. When the task does ask for a push or PR from cloud mode, use the `publish` tool, with a branch named by the repository's conventions.
- When the work is done, tear down every server, background session, browser, and worktree you started that the result doesn't need.

End with a report: what works now and how you verified it, every decision you made for me, and anything you skipped and why.
