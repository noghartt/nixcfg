# Herdr

Mellon and the Macs (Palantir, Mithril) launch Herdr directly from Ghostty; tmux and Pi's tmux helpers
(`features/cli/tmux.nix`, `features/pi/tmux.nix`) are no longer imported anywhere.
The Mac reaches Mellon's Herdr as a saved Herdr machine (`herdr machine add mellon`, Herdr
client state, not Nix): Mellon's workspaces sit in the Mac's sidebar with the Mac's keys and
Mellon's own plugins, and what runs there survives the Mac sleeping. A Herdr nested in an
SSH login would lose every key to the outer one, so a plain `ssh mellon` stays an ordinary
shell; `ssh -t mellon herdr` attaches from a phone.
Herdr finds agents by process name, so it knows neither `omo` nor an OmO pane whose Claude
subscription child is in the foreground (that pane passes for `claude`). The
`pi/extensions/herdr-state.nix` package reports state for both harnesses instead. It is
Herdr's own Pi integration, built from the pinned Herdr source rather than installed into
`~/.pi` with `herdr integration install pi`. Pi reports as `pi`, and OmO (`OMO_NATIVE` set)
as `omo` with source `nixcfg:omo`. Only TUI sessions report: `worktree_agents` children and
other headless (`--mode json`/`rpc`/print) runs have no pane to show.
Herdr's agent tree is a Nix-packaged native popup command
under `features/herdr/`, bound to `Alt+A`; it uses live session metadata and pane IDs.
The `pr-tree/` plugin provides `Alt+P` for authored open GitHub PRs grouped by repo,
using the active `gh` account, with browser and clipboard actions. The `lazygit/` plugin
binds `Alt+R` to a lazygit popup in the focused pane's cwd, so it follows worktrees. The
`close-worktrees/` plugin binds `Prefix Alt+D` (beside `close_workspace` on `Prefix Shift+D`)
to a confirmation popup that closes every open linked-worktree workspace of the focused
repo, either keeping the checkouts or removing them with `herdr worktree remove`, which
refuses dirty ones; the primary workspace is never touched. Because Herdr owns
`Alt+P`, Pi's command palette uses `Ctrl+P` (model cycling moves to `Shift+Ctrl+P`)
the session tree view uses `Ctrl+T` (the thinking-block toggle moves into the palette),
and `Ctrl+?` lists keybindings. In OmO, `ui-prompt` makes `Ctrl+X` a leader: `L` resume,
`A` cycle the primary agent (as does `Tab` on an empty prompt), `Y` OmO's original copy
action. Ghostty sends left
Option as Alt so Alt chords reach Herdr and Pi, and forwards `Ctrl+?` as CSI-u.
