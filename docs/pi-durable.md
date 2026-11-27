# pi-durable

`pi-durable` is a durable coding agent built on `@earendil-works/pi-durable`, the Durable
library that ships inside the installed Pi package. Every streamed partial, tool output,
queued message and turn is committed to SQLite before it is shown, so a killed process
(crash, closed terminal, reboot) resumes where it stopped with `--continue`. A tool call
that was cut off gets an "interrupted" result and the turn finishes.

Code: `home/noghartt/features/pi-durable/` (`src/` holds the TypeScript, `package.nix`
the build, `default.nix` the install). Imported by `home.nix`, so every host has it.

## Why our own app

Durable is a library: Pi itself does not run on it, and upstream deleted its Durable CLI
in Pi 1.2.0 (7472cda0d). `pi-durable` began as that last upstream CLI ported to the 1.6.0
API, and now aims at `pi`'s UI and commands on top of Durable. It reuses Pi's own pieces
wherever possible:

- **Resources:** Pi's `DefaultResourceLoader` (extensions off) finds skills, prompt templates
  and AGENTS.md files exactly as `pi` does. That covers the agent dir, `~/.agents/skills`,
  the project's `.pi/skills` and `.agents/skills` up to the repository root, `skills`
  settings and packages. Project resources follow Pi's trust: a decision saved in
  `trust.json` (by `pi` or `/trust`), or trusted when the project has nothing that needs
  trust. An undecided project loads untrusted, with a notice pointing at `/trust`.
- **System prompt:** Pi's `buildSystemPromptSections()` with those skills and context files,
  re-read on every request, so `/reload` and `/trust` reach the next one. An `agency` section
  after the rules (`src/prompt.ts`) makes acting on the clear next step the default (watching
  a PR's CI, running tests after a change) instead of asking "Should I ...?"; asking stays for
  destructive or hard-to-undo actions and for decisions the request leaves open.
- **UI:** Pi's components: editor, message, tool and skill cards, theme, keybindings, the
  `/tree` selector (also behind `/fork`) and the `/resume` session picker.

Imports go through `#pi/index.js` (Pi's public API) where it exports what is needed. A few
internals still come from deeper paths: theme, tool renderers, status indicator, prompt
templates, trust store, HTTP setup and model resolution.

## TUI

Typing `/` lists the commands, then prompt templates, then `/skill:<name>` for every loaded
skill (unless `enableSkillCommands` is off). `@` completes file paths through `fd`.
`/skill:name args` and `/template args` expand the way `pi` expands them. A skill invocation
is shown as Pi's collapsed skill card; the expand key opens it, as it does tool output.
Any other `/...` text goes to the model.

Commands: `/model`, `/thinking`, `/tree`, `/fork`, `/clone`, `/agents`, `/stop`, `/profiles`,
`/dashboard`, `/btw`, `/status`, `/accounts`, `/swarm`, `/research`, `/sandbox`, `/label`, `/tasks`, `/notices`, `/compact`, `/new`, `/resume`, `/name`, `/session`, `/copy`,
`/reload`, `/trust`, `/quit`. Enter prompts when idle and steers when busy; the follow-up key
queues; Esc aborts; Shift+Tab cycles thinking.

Warnings and errors (skills that failed to load, a missing model, failed commands) are counted
in the footer as `⚠ n` and `✖ n` instead of filling the space above the editor; `/notices`
shows or hides them in full, and `/notices clear` dismisses the ones so far. Info notices, which
answer a command such as `/session`, always show.

While other conversations work (subagents, background subagents) or watchers run, an agents
panel above the editor lists each with what it is doing, its model and its cost; `/stop` aborts
one's work or ends a watcher, `/agents` switches to it. Reports and messages from other agents
show as collapsed cards. A subagent or `parallel` call shows its children's progress in its tool
card while it waits.

**Labels.** `/label <text>` labels the newest entry; in `/tree`, Pi's label key labels any
node, and the tree's labelled-only filter lists them. Labels are a session document
(`pi-durable.labels`), so they survive restarts and other sessions can read them.

**References.** An input may name other work: `@label:<label>` (this session up to a labelled
entry), `@agent:<name or id>[#label]` (another conversation of this session) and
`@session:<id prefix, name or dir>[#label]` (another session, read-only, also while another
process holds it). Their transcripts are attached after the text as `<reference>` blocks; the
transcript shows only how many were attached.
A target or label with spaces is quoted (`@label:"before refactor"`); punctuation or a closing
backtick after a bare one is dropped. They complete like `@` paths (`src/completions.ts`): a bare
`@` offers the three kinds above the files, `@session:` lists sessions newest first (all
projects, fuzzy over ID, name, first message and directory, marking open ones by their lock),
`@agent:` this session's conversations, `@label:` and a `#` after a target that session's labels.

**Dashboard.** `/dashboard`, or `pi-durable agents` on its own, lists every session by project,
refreshed every 2 s: which are open (by their lock), which work and how many agents, the model,
cost, and a line of activity. A process writes that status to its session's `meta.json`
(`live`) and clears it on close. Enter opens a closed session; an open one belongs to its process
(reference or message it instead).

**Side questions.** `/btw <question>` asks about the shown conversation without steering it
(`src/btw.ts`), after Claude Code's `/btw`. It is one request outside the session, on the
conversation's model (reasoning models think at `low`), with no tools: the conversation's model
context goes in serialized the way compaction serializes it (tool calls without tool definitions
are refused by some providers), keeping the newest part past three quarters of the window. The
answer streams into a panel in place of the editor while the agent keeps working; Esc (or Enter
once answered) closes it and aborts a request still running. Nothing is written to the
transcript, so it costs the agent no context, is not replayed on a reopen, and its spend (shown
in the panel) is missing from the usage ledger and `/status`.

**Status.** `/status` (`src/status.ts`) shows, in place of the editor (r reloads):

- Accounts: Claude and ChatGPT subscription windows with bars and reset times, and the
  signed-in emails, read through the statusline's fetcher (`features/pi/extensions/statusline/limits.ts`,
  copied in by `package.nix`) and its shared 5-minute cache, so `/status` adds no polling.
- Today: spend, requests and tokens since local midnight across every session, by model. Durable's
  usage ledger has no dates, so this sums the assistant entries written today: open sessions and
  those whose `meta.json` moved today are opened read-only (this one through its own Harness).
  Compaction summaries write no assistant entry and are left out.
- Sessions: totals, projects, open and working, and this session's cost and conversations.
- Claude fallback (only with more than one account, see Accounts): each account, the active one
  marked, free or limited/skipped until when.

## Accounts

Several Claude subscription accounts can back one pi-durable (`src/accounts.ts`,
`src/accounts-cli.ts`, `src/accounts-view.ts`). When the account in use hits its usage limit, the same request continues
on the next one, and requests go back to the first account once its window resets.

- `main` is the agent dir's own `auth.json` (`pi auth login anthropic`). Each extra account has
  its own `<agent dir>/accounts/<name>/auth.json` and its own `ModelRuntime`, so it refreshes and
  rotates its own OAuth tokens; one token pair is never copied into two files.
- `pi-durable accounts login <name> [--no-browser]` signs one in (pi's terminal login: a URL to
  open, then the pasted code), `accounts list` shows each account, whether it holds a login, and
  its block, and `accounts remove <name>` deletes it. Fallback order is `main`, then
  `accounts/order.json` (login appends to it), then any other account dirs by name. A dir whose
  `auth.json` holds no credential at all is not an account: that is a first sign-in still under way,
  or the empty file Pi recreates when a runtime still open on a removed account reads its auth.
- `/accounts` does the same from inside a session (`src/accounts-view.ts`, `ReportPanel` in
  `src/status.ts`):
  - Bare (or `list`), a panel lists every login by provider: Claude first (always, with `main` and
    the extra accounts), then each provider pi's credential store holds for the agent dir's
    `auth.json` (`ModelRuntime.listCredentials()`). Each row shows signed in (or API key) or not, its
    email, and for pooled Claude accounts free or blocked until when, the active one marked. Emails
    come from the statusline's `authFileEmails()` (`limits.ts`): Claude's through the same cached
    profile request `/status` makes, ChatGPT's from its token, others from what the credential stores.
  - `/accounts add <name>` signs an extra Claude account in with pi's `LoginDialogComponent` in place
    of the editor (method list, URL, opened in the browser, pasted code), `/accounts login <provider>`
    signs the agent dir in to any provider whose pi auth has OAuth (`getProviders()`; exact ids only,
    since it replaces that provider's login), refreshes its catalog and puts its models in `/model`.
    API-key logins stay with `pi auth login`. Both run beside the agent, not queued behind commands;
    inside Rex the tab shows them as waiting on the user. The dialog and its method list are view
    layers (`TuiView.layer`), as is an approval: one asked during a sign-in shows over the dialog and
    gives it back when answered, and whichever finishes first leaves the other on screen.
  - `/accounts remove <name>` asks first, then deletes the account; `main` is never removed.
  - Subcommands, provider IDs and account names complete. Sign-in (`loginAccount`), the order and
    removal (`recordLogin`, `removeAccount`) are the same functions `pi-durable accounts` runs; a
    cancelled first sign-in leaves no account directory.
  - Accounts added or removed take effect in the open session: the pool is reloaded (a re-signed
    account's runtime is reopened). Accounts changed from a shell join when `/accounts` or `/status`
    next runs.
- Routing: `openAccounts()` always puts an `AccountPool` (a pi-ai `Models`) in as the Harness's
  `models` and `/btw`'s, so accounts can join later; with one account it passes every request
  straight to the primary runtime, so a single login behaves as before. Everything but requests goes
  to the primary, and requests for provider `anthropic` go to the first account not blocked
  (preference order, not sticky). Other providers pass straight through; only Claude pools accounts
  (`accountsOverview()` lists rows per provider, so another provider could gain extra accounts later).
- A request's events are held back until its first content event. If it ends before that in a
  429, a rate- or usage-limit error, the account is blocked and the same request goes to the next
  account, so the transcript gets one answer and no error. The block lasts until
  `anthropic-ratelimit-unified-reset`, else `retry-after`, else 1 hour when the unified status is
  `rejected`, else 5 minutes (at least 30 seconds). The pool passes the provider a `fetch` that
  records each response's status and headers, since `onResponse` never sees a failed request.
  An extra account without a login, or whose auth fails (refresh failure, 401), is skipped for
  an hour with reason `auth`; `main`'s auth errors pass through for the user to fix. Errors after
  content, and any error with no other account free, pass through unchanged, so the Harness's
  retry and failure apply as before (a retry tries the account free soonest).
- Blocks live in `<agent dir>/accounts/state.json` (name to `{ blockedUntil, reason }`, no
  credentials), written through a rename and re-read when its mtime moves, so every pi-durable
  process skips an account another one found limited.
- A switch shows a warning notice (`Claude account "main" limited until 18:40; continuing on
  "work"`), and the return to an earlier account an info one. With more than one account the
  footer shows the active one after an `anthropic` model, and `/status` lists them.
- The statusline's limits fetcher also reads `accounts/*/auth.json` under every agent dir, so
  `/status` and the Pi statusline pool every account's windows and show their emails; tokens are
  deduplicated as before.

The login flow (CLI and `/accounts add`) was checked up to the code prompt; a full sign-in needs a
browser. `tests/accounts.test.ts` covers the overview, add/remove bookkeeping, the `/accounts` parser
and completions, emails, and a pool gaining and losing accounts while open; the install check runs it.

**Branches.** A session is one SQLite database holding conversations: `main`, branches
(Durable forks) and subagents. `/tree` shows main and its branches as Pi's tree, with each
branch hanging off its fork point. Selecting a node continues from there: it switches to
the branch that ends at that node, or forks a new one. Selecting a user message forks just
before it and puts its text in the editor to edit and resend. `/fork` is the same tree
opened on user messages only (Pi's `[user]` filter, which the filter keys change), and `/clone`
forks at the current end. Both open under a branch overview (`src/branches.ts`, in place of
the tree's title): one line per branch with where it forked, how many messages it added and its
first one, the shown branch marked; past six, the newest are listed and the rest counted. Other
branches keep running when you switch away. `/agents` switches between branches and
subagents. Unlike `pi`, `/fork` stays in the same session rather than starting a new file,
and moving in the tree offers no branch summary.

**Sessions.** They live in
`~/.config/pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/`: `session.sqlite`
plus `meta.json` (directory, name, first message, message count, the branch last shown,
which a reopen returns to, and the live status the dashboard reads), `inbox/` (messages from
other sessions) and `worktrees/` (isolated subagents' checkouts). One process holds a session at a time; a lock left by a crash
goes stale after 10 s. A session nobody wrote to is deleted on close, as `pi` only saves a
session after its first message. `/resume` (also `--session <dir>`) and `/new` close the
open session and reopen; its running work stays pending for the next open. Sessions from
before `meta.json` show as "(older session)".

**Swarm.** `/swarm <task>` runs a task as a swarm, after Antigravity's `/swarm` (`src/swarm.ts`,
`src/swarm-board.ts`). The shown conversation, main or a branch, becomes the coordinator, and the
task goes in as a collapsed `swarm` skill card. The coordinator adds workers, each its own
conversation. Workers and coordinator talk through one shared board of numbered posts. A post wakes
only the agents it mentions:

- `@name` wakes that member, `@<group>` every `<group>-N`, `@all` every member, `@coordinator` the
  coordinator.
- The woken agent gets the post as an input (a `pi-durable.message` card).
- An agent that waits ends its turn, so a sleeping swarm costs nothing.

The coordinator's guide and the workers' guide are a `swarm` prompt section. Each conversation gets
only the guide for its role, so the guide survives compaction. The rules follow agy's skill:

- The coordinator does not do the work itself.
- Each file has one owner.
- About one verifier for every two to four authors.
- Peers hand work to each other directly.
- The coordinator merges worker branches itself and never pushes on its own.
- A `[done] <summary>` post from the coordinator closes the swarm.

Members need not run on the coordinator's model. `add` requires a profile, and the coordinator's
guide says how to pick one:

- `general` copies the coordinator's model; the guide names that model, and keeps `general` for parts
  that need it.
- Mechanical, well-specified parts go to cheap, fast implementers, judgment calls to strong ones, and
  reading to read-only scouts.
- Model families are mixed: a verifier runs on a different family from the author it checks, and an
  unclear approach can be tried on two families side by side.
- `add`'s `thinking` replaces the profile's thinking level for those members: low for mechanical
  parts, high or xhigh for reasoning and reviews. agy has no thinking setting, so on an Antigravity
  member it picks the model's `-low`/`-medium`/`-high` variant. Off and minimal map to `-low`, and
  `-xhigh` applies only to Gemini 4 Neon and Hydrogen. Models without variants, such as gpt-oss,
  are left unchanged.

Models show as `provider/model:thinking` in `add`'s result, `swarm status`, the board and the
coordinator's guide.

A Fable coordinator can therefore run Sonnet and Codex authors, Opus and Codex reviewers, and Gemini
members.

The swarm's tools are deferred: only the coordinator (configured by `/swarm`) and the members (when
added) are offered them, so a model never starts a swarm on its own.

- `swarm`: `status` (everyone); `add`, `kill`, `title`, `plan` (coordinator only).
  - `add` takes a name, a brief, an `agent` (a profile; required), and optionally `thinking`,
    `workspace` and `tasks`. Its result names each member's model and thinking level.
    - `workspace`: `inherit` shares the checkout; `worktree` gives the worker its own git worktree.
    - `tasks`: shards the brief into workers `<name>-1..n`.
    - The brief is posted as `@name <brief>` and becomes the worker's first input.
  - `kill` is permanent. It removes a worktree with no changes and keeps a branch that has commits.
  - `plan` stores a goal and up to six threads for the board's overview.
- `post_message`: posts, wakes those mentioned, and with `wait: true` ends the turn.
- `read_board`: returns posts after the reader's mark.
- `swarm_wait`: ends the turn with no further model request (`control.terminate`).

Members have no subagent tools, so they cannot spawn their own workers.

**Antigravity members.** A profile with `runner: antigravity` joins without a conversation. Its
record holds:

- the agy model, cwd and write permission: writes only in its own worktree, and only for an
  `allowWrites` profile;
- the agy conversation ID, continued across runs;
- a queue of the posts that mention it;
- the live run, if any.

A post that mentions it queues the post and, if no run is live, starts a `pi-durable.swarm-agy`
task in the coordinator's conversation, in the background. Each round of the run does this:

1. It gives agy every post the member has not seen (the last 40, each cut at 4000 characters). The
   first round also gets a guide: the final answer is posted verbatim, so mention who must act and
   report `@coordinator [done]`.
2. It posts agy's answer as the member. An answer that mentions nobody is addressed to whoever
   mentioned it.
3. It wakes those the answer mentions.
4. It loops while new mentions are queued.

Each round's question is a memo and each post records its round, so a reopen posts once; an agy
run cut off by a close runs again. `kill` (and `/swarm end`) marks it, and the run, which checks the
mark every 2 seconds, stops agy. On the board, Enter on an Antigravity member shows its latest post.
`PI_DURABLE_AGY` points the runs and the `antigravity` tool at a stand-in agy for scripted tests.

State lives in the session document `pi-durable.swarm`: the coordinator, the members, the posts and
each reader's mark. One swarm runs per session at a time. A post and its wakes are replay-safe:
the post records the call that wrote it, and each wake has a request ID.

A monitor task, written in plain code with no model, sleeps durably between checks: every 3 minutes,
or `PI_DURABLE_SWARM_MONITOR_SECONDS`. When no member and not the coordinator is working and the
swarm is not done, it sends the coordinator one `[swarm monitor]` stall alert per board state.

`/swarm board` (or a bare `/swarm`) opens the board, refreshed every second:

- the title, status and goal;
- an overview of the threads with each member's state;
- one filterable list of the roster and the posts, newest first. Enter on a member opens its
  conversation; Enter on a post shows it in full.

While a swarm runs, the agents panel shows a line for it.

When a swarm closes, the coordinator stops being offered the swarm tools and loses its guide, and
works as an ordinary agent again. A `[done]` post closes it, and so does `/swarm end`.

`/swarm end` also works on a swarm that `[done]` already closed. It marks every live member killed
and stops it, and stops the monitor. The board and the members' branches are kept.

A new `/swarm` is refused while members of the last swarm are still live. Wake request IDs carry
the swarm's start time, so a later swarm on the same coordinator starts numbering posts from 1
again without its wakes being deduplicated against the old ones.

Not carried over from agy:

- board channels;
- forking a worker from another member's history;
- switching a member's model after it joined (its profile picks the model);
- multi-machine swarms;
- copying uncommitted changes into worktrees, which are cut from HEAD as for `worker` subagents.

Not there: Pi extensions (Durable has its own extension model, see below), `/login` (`/accounts
login <provider>` covers OAuth; API keys go through `pi auth login`), `/settings`, `/export`, `/share`, images, `!` shell commands.

## Tools

Durable's coding tools (read, write, edit, bash), `antigravity` (`src/antigravity.ts`, see
`docs/extensions.md`), and the agent tools below. Durable tools get no UI, so a tool that must
ask the user goes through `src/approvals.ts`: the TUI shows a yes/no list in place of the
editor, and with no TUI every request is refused.

**Long results** (`src/spill.ts`): the Harness cuts every tool result to 2000 lines / 50 KB and
keeps no copy; only bash writes its complete output to a file. An `afterTool` hook, installed
last, gives every other model-issued result the same treatment: text over the limits is written
to a temp file (`pi-tool-output-*.txt`) and the result gains `[info] Full output: <path> (read
with offset/limit)` next to the Harness's truncation warning. The file is made through the
conversation's `ExecutionEnv`, not `node:fs`, so with a remote environment (a sandbox, see
Sandboxes) it lands where the model's `read` looks. Files live in the OS temp dir, as bash's do, and are never
cleaned up by pi-durable. Output a tool streams with `api.output()` is already bounded before
the hook runs, so such a tool must write its own file, as bash does.

Four extensions carry the agent tools (`src/subagent.ts`, `src/watch.ts`, `src/messaging.ts`, and
`src/swarm.ts`, see Swarm above).
Orchestration (`subagent`, `parallel`, and the `agent_profiles` prompt section) is removed from
subagents, so they never spawn their own; watch and messaging stay everywhere. Every tool is
replay-safe: a rerun after a crash finds the child, worktree, task or submission it already made.

- **`subagent`** runs a task in a child conversation with a profile's agent. By default the
  call parks on the child's answer (`SubmissionSettled`), so it holds no process and survives a
  restart. `background: true` returns at once: the child hangs off a background anchor task, and
  a reporter task posts its answer back as a follow-up input (`pi-durable.report` entry, kept
  through Esc).
- **`parallel`** fans out up to 16 tasks as nested `subagent` calls, keyed so a wake finds them
  again, starting at most `maxConcurrency` (default 4, at most 8) and parking until any ends.
  It returns every answer in one result; failures are listed, not fatal.
- **`watch`** starts a background watcher task: a command (reports output lines matching a
  pattern, and its exit with the last 40 lines; its process group is killed when stopped), a
  file or directory (reports changes), or a timer (a durable sleep that fires across restarts).
  A command cut off by pi-durable closing is reported as stopped on the next open, or run again
  with `restartOnResume`.
- **`agents`** lists, messages, reads and stops this session's conversations and watchers.
  A message to a background subagent goes through a reporter, so its answer comes back to the
  sender; other targets get a `pi-durable.message` input they can answer with `send`.
  Subagents reach their parent as `parent`. A conversation cannot stop itself or its ancestors.
- **`sessions`** lists other sessions, reads one (at a label), and sends its agent a message.
  A message is a file in the receiver's `inbox/`; the process holding that session delivers it
  (watched, plus a 5 s poll) as an input to main or a named conversation, with the file name as
  request ID, then deletes it. A closed session gets it when it next opens.

**Research tools** (`src/research.ts`, everywhere, subagents included): `web_search` (Exa, Kagi),
`web_fetch` (a ladder of readers, cached under `$XDG_CACHE_HOME/pi-durable/research/`), `lookup`
(Wikipedia, OpenAlex, arXiv, Hacker News, GitHub through `gh`), `research_note` (appends notes under the research
folder only) and `research_verify`. All but `research_note` are read-only and replay-safe.
`/research <question>` submits `/skill:research <question>`, the skill
shipped in `features/pi-durable/skills/research/`. See `docs/deep-research.md`.

**Profiles** (`src/profiles.ts`) are markdown files with frontmatter, like Claude Code agents,
read from `<agent dir>/agents/`, `~/.agents/agents/`, and, in trusted projects, `.agents/agents/`
and `.pi/agents/` from the repository root down; a later file replaces a profile of the same
name. Fields: `name`, `description`, `model` (`provider/model` or an ID, resolved like
`pi --model`), `thinking`, `tools` (offered coding tools; `agents` and `sessions` are always
kept), `isolation` (`worktree`, `none`, `sandbox` or `sandbox:<kind>`, see Sandboxes),
`keepSandbox`, `maxTurns`; the body becomes the subagent's
instructions. Built in: `general`, `explore` and `reviewer` (read-only tools), `worker` (own
worktree). `/profiles` lists them; `/reload` re-reads them.

`runner: antigravity` runs a profile on the Antigravity CLI instead of a Pi conversation: the
subagent tool makes one nested call to the tools-only `antigravity-subagent` tool (same agy run
as `antigravity`), with the profile's body and the worktree note prepended to the task. `model`
is then an agy model ID; `tools`, `thinking` and `maxTurns` do not apply. `allowWrites: true`
(only with `isolation: worktree`) runs agy with `--dangerously-skip-permissions` without asking:
the profile is the user's consent, and a per-call `isolation: none` makes it read-only again.
Such a subagent has no conversation (nothing for `/agents`, `agents send` or `read`) and no
background mode; `parallel` runs it like any other.

The feature ships its own profiles (`features/pi-durable/agents/*.md`, one link per file into
`<agent dir>/agents/`): Anthropic first for implementation (`opus-worker`, the default;
`sonnet-worker` for contained edits; `scout` and `opus-reviewer` read-only), Codex for second
opinions and alternative attempts (`codex-reviewer` on GPT-6.2 Astra, `codex-worker` on GPT-5.6
Sol), and Antigravity on Gemini 4 Neon (`gemini` read-only, `gemini-worker` writing). `researcher`
(Sonnet) and `research-critic` (Codex) serve `/research`.

**Worktrees** (`src/worktrees.ts`): an isolated subagent works in a git worktree on its own
branch (`pi-durable/<session start>-<key>`) cut from the parent's HEAD, kept in the session's
`worktrees/` so repositories gain no untracked directories, and is told to commit there. It is
made with `git twig new` (`features/git-twig/`, on pi-durable's PATH), which clones tracked
files copy-on-write on APFS or reflink filesystems and falls back to plain Git elsewhere; the
result is an ordinary linked worktree. `PI_DURABLE_TWIG=0`, or a git without `twig`, uses
`git worktree add`. The prompt also tells the model to use `git twig new` for worktrees it
makes through bash. Its result names the branch with a diff stat and how to merge it; a finished foreground subagent
that changed nothing has its worktree and branch removed.

State lives in Durable documents (`src/state.ts`): `pi-durable.identity` per child (name,
profile, parent, worktree or sandbox), `pi-durable.background` per conversation (background
subagents by name, watchers), and the session-wide `pi-durable.labels`, `pi-durable.swarm` and
`pi-durable.sandbox` (the session's sandbox).

## Sandboxes

pi-durable runs tools in `sbx` sandboxes (`docs/sandbox.md`): VMs made through the sbx library
and its provider interface, never a particular provider, with kinds and providers from
`$XDG_CONFIG_HOME/sbx/config.json` as for the `sbx` CLI. Code: `src/sandbox-env.ts` (the
environment), `src/sandbox.ts` (lifecycle), `src/sandbox-tools.ts` (tools).

**The environment.** `SandboxExecutionEnv` implements Durable's `ExecutionEnv` on
`Sandbox.exec`, `readFile` and `writeFile`, so read, write, edit, bash, spill files and
everything else built on the environment land in the VM:

- Every operation is one round trip: stat, listings, renames, appends and the like are one
  POSIX sh script (GNU or BSD tools) that classifies its own errors (`sbx-err:<code>` on stderr,
  mapped to Durable's `FileError` codes); a failed `readFile`/`writeFile` costs a second one to
  say why. Paths are resolved locally against the environment's cwd (POSIX, `~` is the sandbox's
  home), so scripts only see absolute paths.
- A binary reader's open returns files up to 1 MiB inline (one round trip for most `read`s);
  larger ones are hard-linked (else copied) to a snapshot, read in 4 MiB base64 chunks with a
  small cache, and the snapshot is removed on close, so the reader keeps reading the file it
  opened, as a descriptor would. Text line readers sit on the binary reader.
- `exec` runs strings through bash (sh where there is none) and argv without a shell, reports a
  missing cwd or program as `spawn_error` (a marker line the caller never sees), maps the
  context's abort to sbx's cancellation (which kills the remote process group), and tells a
  timeout (sbx's 124/137 with the clock past the limit) from the command's own exit code. Output
  streams to the caller; past the spill thresholds it is appended to a temp file on the sandbox
  in 1 MiB batches, returned to sbx as backpressure. The spill writes use their own bounded
  context, so an aborted or timed-out command's file is still complete; it holds decoded text
  (sbx streams strings), so invalid UTF-8 is U+FFFD there. `renameFile` behaves like rename(2):
  a symbolic link at the destination is replaced, never followed. A throwing output callback is a
  `callback_error` and stops the command.
- `watch` is `not_supported` (nothing here watches its environment; resources load from the
  local checkout) and the optional `listFiles` is absent. Durable's own `ExecutionEnv`
  conformance suite runs against it (watch cases aside) in the tests.

`ExecutionEnvs` picks the environment per call: a conversation's own sandbox (a
sandbox-isolated subagent), none for a worktree-isolated one, else the session's sandbox, else
the local directory. The agent's `cwd` stays local; the environment maps a directory below the
seeding repository to the same place in the sandbox's checkout (else the checkout, else its
home), so detaching needs no change to the conversation. Tools that run local programs (`watch`,
`antigravity`, the research tools) use the local cwd. While a conversation works in a sandbox,
pi-durable records use (`touch`) at most hourly, since sbx's reaper does not count commands.

**Prompt.** A `sandbox` section tells such a conversation that its tools run on another machine,
the kind's network policy (`all`: internet; `integrations`: only the provider's services and
attached integrations), the checkout path, branch and seed commit (and that uncommitted local
changes did not travel), how ports are reachable (`Sandbox.url(port)` when the provider has the
`httpsUrl` capability, otherwise that they are not), that only committed work comes back, and
which tools still run locally.

**Sandbox-isolated subagents.** `isolation: "sandbox"` or `"sandbox:<kind>"` on `subagent`,
`parallel` tasks or a profile (`keepSandbox: true` to keep it; the default profiles keep
`worktree` and say in a comment how to opt in) gives the child its own sandbox:

- Named `pd-<session hash, 10 hex>-<key>` from the session and the call (`t<task>`, `bg<task>`),
  made with sbx's `createSandbox` from the parent's repository (its committed HEAD; local commits
  travel as a bundle), on a new branch `pi-durable/<key>`, with the local git identity set in the
  checkout and a marker file (`~/.pi-durable/seeded`) written last. Outside a git repository it is
  refused (its work could not come back). Seeding warnings (uncommitted local changes that stay
  behind) are in the result.
- A rerun after a crash first looks for the child it already made and reuses it as it is; only
  before that does it look the name up, and only a sandbox of ours without the marker (a crash
  mid-seed) is replaced. A sandbox a saved reference (a child's identity, the session) points at
  is never replaced. Anything failing after a sandbox was created removes it, and a failed
  creating commit wraps up the workspace no child holds.
- Every ending wraps up the workspace: an answer, an ending without one (stopped, failed), and an
  abort of the call while it waits (the tool's `cancel`, so also an aborted `parallel`).
  Uncommitted changes are committed in the sandbox, and every branch of its checkout is pulled
  with `pullBranches` into the parent's repository as `sbx/<sandbox>/<branch>` (only commits after
  the seed travel): the subagent's own `pi-durable/<key>`, which the result names with a diff stat
  and how to merge it, and any other it made (listed); commits on a detached HEAD get a
  `pi-durable/detached-<sha>` branch first. Then the sandbox is removed unless kept. Leftover files
  over 10 MB are not committed; they are named, and the sandbox is kept for them. A rerun after the
  removal reports the branch already pulled. A failed pull keeps the sandbox and says how to
  inspect it (`sbx shell`), pull again (`sandbox_pull`) and remove it (`sbx rm`). Wrap-ups and
  worktree changes are serialized per sandbox, so concurrent ones never race on a checkout.
- A background subagent's branch is pulled again with each answer and its sandbox is kept, since
  it may get more messages; Esc in its conversation or a withdrawn message changes nothing. A stop
  for good (`agents stop`, `/stop`) marks it stopped, and its work comes back and its sandbox goes
  at once (it takes no more work); so does its reporter task being aborted. When the session
  closes, idle background subagents' sandboxes go the same way, all at once within 60 s, skipping
  those already wrapped up (one still at work keeps it, as its run resumes on the next open); any
  that could not be removed are named on stderr.
- Antigravity profiles cannot use sandbox isolation (agy runs locally). Isolation strings are
  checked before anything starts, for `subagent` and for each `parallel` task.
- The sandbox is also in `pi-durable.sandbox-binding`, a conversation document that forks keep
  (Identity does not), so a `/tree` branch of a sandbox subagent keeps working in its sandbox.

**In a sandboxed session**, isolated children stay in the parent's sandbox: `worktree` and
`sandbox[:kind]` isolation, and swarm members (whose sandbox profiles join with a worktree), get a
git worktree of the sandbox's checkout at `~/.pi-durable/worktrees/<session hash>-<key>` on branch
`pi-durable/<session hash>-<key>`, started from the parent's HEAD (its own worktree's, when the
parent works in one). The start commit is recorded before the worktree is added, so a rerun after
a crash completes it. Their commits are commits of the repository the parent works in, so nothing
travels between VMs or through this machine (the alternative, bundling from the parent VM to a
child VM through the local repository, needs two transfers per child and a second VM for no
gain). When the child ends, its leftovers are committed and the worktree is removed; the branch
stays in the sandbox's checkout for the parent to merge there, and is deleted only when it surely
holds nothing new (an unknown start or a failed count keeps it). Sandbox isolation turned into
such a worktree is noted in the result as a warning, with the kind asked for: the session chose
its machine. Its prompt says it works in a worktree inside the sandbox the main agent works in,
and the swarm board, status and end report name members' branches there.

**Session sandbox.** `pi-durable --sandbox[=kind[:name]]` or `/sandbox` puts the whole session's
tools in a sandbox. `/sandbox <kind>` makes (or reattaches) the session's sandbox of that kind,
named `pd-<session hash>-session-<kind>` and seeded from the session directory's repository;
`<kind>:<name>` uses that name; any other word attaches an existing sandbox by name (`sbx ls`);
bare `/sandbox` shows it and `/sandbox off` detaches it (the sandbox is kept). Attaching one
seeded from another repository is refused, since paths map into its checkout and pulls land here.
The choice is the session document `pi-durable.sandbox`, so `--continue` and `/resume` reattach
by name. Every conversation without its own sandbox or worktree uses it: main, branches,
non-isolated subagents. The saved sandbox is never replaced, only reattached.

It fails closed. The argument is checked first (the kind exists, the sandbox to attach exists), so
a typo changes nothing. While a new sandbox is being made the document is `pending`: tools wait
for it (up to 15 minutes), never running on this machine meanwhile. If making it fails, the
session stays in its current sandbox when it had another; otherwise the failure is recorded as
`failed`, and tools return errors and prompts are not sent until `/sandbox <kind>` succeeds or
`/sandbox off`. `--sandbox` writes `pending` before interrupted work resumes, unless it names the
healthy current sandbox (`--continue --sandbox` with the same kind blocks nothing). A `pending`
left by a process that died becomes `failed` on the next open, so tools do not wait for nobody.

**Tools.** `sandbox_run` runs one command in a fresh sandbox (kind `job` by default), optionally
seeded with the repository, streams its output, downloads `artifacts` (relative paths inside the
checkout only; they land under `out`, default `$TMPDIR/sbx-artifacts/<sandbox>/`), and removes
the sandbox unless `keep`, also when the command fails. Its name derives from the call, so a rerun
after a crash reuses the sandbox and runs the command again. `sandbox_pull` fetches a sandbox's
branches (the conversation's own by default, or any by name) into the local repository as
`sbx/<sandbox>/<branch>`; a rerun after the sandbox is gone reports the branches an earlier pull
left. With `remove: true` it removes the sandbox afterwards. The session's own sandbox, one this
session did not make, or one marked to keep goes only when the user approves (through
`src/approvals.ts`); after the session's own goes, the session is `failed` (blocked), not quietly
back on this machine. A subagent's own goes when the subagent finishes. Both are offered
everywhere.

**Deadlines.** sbx enforces a command's timeout on the sandbox; locally, a command with a timeout
gives up 30 s past it (a sandbox that stopped answering is a timeout, said as such), and each file
script after 5 minutes. A bash call without a timeout has no local deadline, as on this machine:
Esc stops it (and sbx kills its remote process group). Closing the environment aborts running
commands and waits up to 5 s for those kills.

Tests (`tests/sandbox.test.ts`) run on sbx's fake provider: the conformance suite, cancellation
that stops the remote command, spill files on the sandbox (complete after an abort), rename over a
link and onto itself, the subagent lifecycle (made once, reused, pulled back, removed or kept,
failures kept, big leftovers keeping the sandbox, other branches and detached commits pulled), a
half-seeded sandbox replaced and an unmarked one not ours reused, removal after a failure past
creation, refusal outside a repository and of another repository's sandbox, artifact containment,
nested worktrees and an uncertain base, a pending session sandbox waited for and a stale one
failed, a failed or mistyped `/sandbox` keeping the current one, a fork keeping its sandbox,
`sandbox_run`, a session sandbox across a Harness reopen, and Harness runs with a scripted faux
model: a `sandbox:dev` subagent whose bash commits in the VM, one stopped before answering, an
aborted `parallel` whose child is cancelled, a background subagent kept through Esc and removed by
a stop, a worktree subagent in a sandboxed session, and `sandbox_run` plus `sandbox_pull` (an
unapproved removal refused, the session left blocked). What only exe.dev can show is in TASK.md.

## Rex

Inside a Rex terminal, pi-durable reports its state to Rex (working, blocked on an approval, done,
error; one child record per subagent at work) and its user-facing conversations get Rex's
session-start context as a `rex` prompt section (`src/rex.ts`). See `docs/rex.md`.

## How it is built

`package.nix` runs the source against the nixpkgs Pi package: Node 24 strips the
TypeScript, bare imports resolve through Pi's `node_modules`, `#pi/*` (package.json
`imports`) through Pi's `dist` and `#sbx/*` through the sbx package's `lib/sbx` (its vendored SDK
included), all by symlink. There is no npm build, and Durable is always
the copy shipped with `pi`. The install check runs `--version` and imports every module,
which links each import against Pi's exports, then runs `tests/*.test.ts` with `node --test` beside
the installed modules (linked, so they resolve Pi the same way) on a throwaway agent dir. Tests are
not installed.

Durable's API still changes between releases, so `package.nix` records `verifiedPiVersion`.
When nixpkgs moves Pi past it, the package is marked broken, the feature leaves it out
with an evaluation warning, and the rest of the host still builds. To re-port, link a
scratch dir to the new Pi's `node_modules` and `dist` (as the build does), copy `src/`
there, and type-check with `tsc` (`module`/`moduleResolution` `nodenext`,
`allowImportingTsExtensions`, `noEmit`). Fix the errors, try the TUI, copy back, and bump
`verifiedPiVersion`. The agent tools are best re-checked without a real model: open a Harness
with pi-ai's faux provider (`@earendil-works/pi-ai/providers/faux`) and this registry, script
the model by the last message (a subagent's request carries its `instructions` section), and
run a subagent, a `parallel` fan-out, a background subagent with a reply, watchers, a
worktree worker, and a close and reopen while they work. For a swarm, script a coordinator that
adds two members and waits, members that hand off with mentions and `wait: true`, a `[done]` that
closes it, and a silent worktree member that the monitor reports
(`PI_DURABLE_SWARM_MONITOR_SECONDS=1`) across a reopen. For Antigravity members, point
`PI_DURABLE_AGY` at a script that prints agy's `init` and `result` stream-json lines, and check a
reply addressed to the asker, a second round that continues the agy conversation, a kill mid-run,
and a reopen mid-run that posts once. A faux tool-call message needs
`stopReason: "toolUse"`. For accounts, give an `AccountPool` one `createModels()` with a faux
`anthropic` provider per account (and a fake clock), script a 429 error message before content, and
check the switch, a block expiring, all accounts limited, an error after content, two pools on one
`state.json`, and a Harness turn that ends with one assistant entry. Point `PI_CODING_AGENT_DIR` at a temp
dir so test sessions stay out of the real one.
