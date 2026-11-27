---
name: pr-babysit
description: Babysit an open pull request until it is green and ready - watches CI, review threads and merge state, fixes failing checks and actionable review feedback, pushes the fixes, and drafts replies for the user to post. Use right after opening a PR, or when asked to babysit, shepherd, watch or get a PR green.
---

# PR babysit

Drive one pull request to done: every required check green, no unaddressed review feedback, no merge
conflict. The argument is a PR number or URL; without one, use the PR of the current branch
(`gh pr view --json number,url`). Optional flags: `--quiet-for <minutes>` (how long to keep watching for
review comments once CI is green, default 30) and `--max-rounds <n>` (fix-and-push rounds, default 8).

## 0. Run it in the background

Babysitting is mostly waiting, so it should not hold the main conversation.

- **Just opened the PR in this conversation, and the harness has background subagents** (pi-durable:
  `subagent` with `background: true`; Claude Code: a background Agent/Task): start one named
  `babysit-<number>` with a self-contained task: "Follow the pr-babysit skill for <PR URL>. The branch is
  checked out at <absolute path>; work only there." Include the repo's build and test commands and any
  conventions you already know (commit style, pull-before-push). Tell the user it is running and go on.
  Its final answer arrives as a message: relay the summary and the drafted replies.
- **Otherwise** (no background agents, or you are that subagent): run the loop below yourself.

Waiting is done by the harness's background tools when it has them (pi-durable: `watch` with
`kind: command` on `gh pr checks <n> --watch --interval 30`, or `kind: timer`; Claude Code: Bash with
`run_in_background`), and by a plain blocking `gh pr checks <n> --watch --interval 30` otherwise. Never
busy-poll in a tight loop.

## 1. Set up

    gh pr view <n> --json number,url,state,isDraft,headRefName,baseRefName,headRepositoryOwner,mergeable,mergeStateStatus,reviewDecision

- Stop if the PR is merged or closed.
- Work in a checkout of `headRefName` with no unrelated changes. If the current checkout is on another
  branch or dirty, use a separate worktree (`git twig new <path> <headRefName>` when available, else
  `git worktree add`) rather than stashing someone's work.
- `git pull --rebase` the branch first: the user or another agent may have pushed since.
- Keep a log at `$(git rev-parse --git-common-dir)/pr-babysit/<number>.md`: each round's findings, what you
  changed, and the IDs of comments already handled, so a restarted run does not redo or re-answer them.

## 2. The loop

Repeat until done (section 5) or a stop condition (section 6):

1. **Wait for CI** to finish on the current head (`gh pr checks <n> --watch`). Pending checks are not
   failures; checks that never start (no runner, needs approval) are a stop condition after ~20 minutes.
2. **Collect** everything at once, then act on all of it in one round, so reviewers and CI see one push
   instead of five:
   - checks: `gh pr checks <n> --json name,state,bucket,link,workflow`
   - review threads (section 4 query), reviews with `CHANGES_REQUESTED`, and top-level PR comments
     (`gh pr view <n> --json comments,reviews`)
   - merge state: `mergeable`, `mergeStateStatus`
3. **Fix** (sections 3 and 4), verify locally, commit, push.
4. Go back to 1. When CI is green and nothing is left to do, keep watching for new comments every
   ~5 minutes until `--quiet-for` passes with no new activity.

## 3. Failing checks

- Read the failure, not just its name: `gh run view <run-id> --log-failed` (the run ID is in the check's
  `link`); for external checks (Vercel, Buildkite, CodeRabbit...) open the link with `gh` or the web tools.
- Reproduce locally with the same command CI runs (read the workflow file) before changing anything, and
  rerun it after the fix. Run the narrowest command that proves the fix, then the repo's usual checks.
- **Fix the cause, never the signal.** No skipping or deleting tests, loosening assertions, adding
  `|| true`, `continue-on-error`, `--no-verify`, lint disables, or bumping timeouts to hide a hang,
  unless that is plainly the correct fix and you say so in the log.
- **Flaky or infrastructure** (network timeouts, runner lost, the same commit passed before, unrelated
  to the diff): rerun once with `gh run rerun <run-id> --failed`. If it fails the same way again, treat
  it as real.
- **Broken on the base branch too** (check the latest run on `baseRefName`): not this PR's fault. Do not
  fix it here unless it is trivial and blocking; report it.
- Formatting and generated files: run the repo's formatter or generator rather than hand-editing.

## 4. Review feedback

Fetch unresolved threads (owner/name from `gh repo view --json owner,name`):

    gh api graphql -F owner=OWNER -F name=REPO -F n=NUMBER -f query='
      query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
        reviewThreads(first:100){nodes{id isResolved isOutdated path line
          comments(first:50){nodes{id databaseId author{login} body url createdAt}}}}}}}'

Skip resolved threads and comment IDs already in the log. For each remaining item, decide:

- **Actionable and right** (bug, missed case, clear style or convention ask): make the change.
- **Bot reviews** (CodeRabbit, Copilot, Cursor Bugbot, linters): judge each one on its merits. Fix real
  bugs; ignore nitpicks that contradict the repo's conventions, and note why in the log.
- **Question, disagreement, or a design choice the user owns**: do not change code on a guess. Draft a
  reply.
- **Outdated** (`isOutdated`): check whether the current code still has the problem before acting.

**You never post on GitHub.** Comments, replies, reviews and resolving threads speak for the user in
public (the harness's `gh` shim refuses comment and review writes; do not work around it). Instead,
collect a draft reply per thread: the thread URL, a one-line summary of the comment, and the reply text
("Fixed in <short sha>: ..." or the answer/pushback). Hand them all over in the final report.

## 5. Commits, pushes and the base branch

- Commit in the repo's style (read recent `git log`; conventional commits if the repo uses them), one
  commit per concern: "fix failing lint" and "address review: handle empty input" are separate.
- Before every push: `git pull --rebase` the PR branch. Push normally; never force-push over commits
  you did not write.
- **Conflict** (`mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`): rebase onto (or merge, if the
  branch already has merge commits) the latest `baseRefName`, resolve conflicts preserving both sides'
  intent, rerun the tests, and push (`--force-with-lease` after a rebase, only if the branch is yours
  alone; otherwise merge the base instead). Stop and ask if a conflict needs a judgment call.
- **Behind** (`BEHIND`): update only if branch protection requires an up-to-date branch.
- Do not mark a draft ready, change reviewers or labels, merge, or enable auto-merge unless the user
  asked for it.

**Done** when: all required checks pass on the latest head, no unresolved thread or change request is
left without either a pushed fix or a drafted reply, the PR is mergeable, and `--quiet-for` has passed
without new activity.

## 6. Stop and report early when

- the same check fails after 3 fix attempts, or `--max-rounds` is reached;
- the fix needs secrets, credentials, permissions, paid resources, or infrastructure you cannot reach;
- the failure is on the base branch, or in a check that never runs;
- a review asks for a change of scope or design, or reviewers disagree with each other;
- someone else pushes conflicting work to the branch while you are on it.

## 7. Final report

Short, in this order:

1. Status: done / blocked (why) / gave up (why), with the PR URL.
2. Pushed commits: short sha + subject, and which check or comment each one answers.
3. Drafted replies, one block per thread (URL, then the text), ready to paste.
4. Anything left for the user: flaky checks seen, base-branch failures, judgment calls.
