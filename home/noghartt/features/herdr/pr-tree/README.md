# My Pull Requests

`nixcfg.pr-tree` shows the active GitHub account's authored open pull requests,
grouped alphabetically by `owner/repository`. Drafts are included and marked;
PRs within each repository are ordered by most recent update.

The plugin uses `gh api graphql --paginate --slurp` against the viewer's PR
connection, including every page. It uses existing `gh auth login` credentials
and respects `GH_HOST`. Results refresh every 60 seconds while the popup is open.
Failed refreshes retain the last successful result with a visible stale/error
notice. No credentials or PR results are written into the plugin or repository.

## Status badges

Review and CI appear separately, alongside `[draft]` when applicable. The same
paginated query reads `reviewDecision` and the head ref's `statusCheckRollup.state`;
there are no per-PR requests. Passing CI does not imply that a PR is ready to merge.

| Badge | Color | Meaning |
| --- | --- | --- |
| `[changes requested]` | Red | GitHub review decision is changes requested |
| `[review required]` | Yellow | GitHub requires a review |
| `[approved]` | Green | GitHub review decision is approved |
| `[CI failed]` / `[CI error]` | Red | Check/status rollup is failure or error |
| `[CI pending]` | Yellow | Check/status rollup is pending or expected |
| `[CI passed]` | Green | Check/status rollup is success |
| `[draft]` | Neutral | PR is a draft, independent of review and CI |
| `[review n/a]` / `[no checks]` | Neutral | GitHub returned no review decision / no check status |
| `[review unknown]` / `[CI unknown]` | Neutral | GitHub returned an unrecognized state |

Titles truncate to reserve badge space, including on selected rows. Narrow popups
use `[D]` for draft, `[R…]` for review and `[C…]` for CI: `!` means changes
requested or CI failure/error, `~` means required/pending, `+` means approved/passed,
`-` means unavailable/no checks, and `?` means unknown. Below 15 columns even compact
badges may clip. Terminals without usable colors retain these text labels.

Search includes badge text and GitHub state names (with underscores replaced by
spaces): for example, `approved failed`, `review required passed`, `draft pending`,
or `no checks`. A failed refresh retains the previous badges with the stale notice.

Field semantics are documented in GitHub's
[pull request reference](https://docs.github.com/en/graphql/reference/pulls#pullrequest)
and [status enum reference](https://docs.github.com/en/graphql/reference/commits#statusstate).

## Open

Home Manager builds and registers the plugin on activation. The activation
reference retains the bundle in the Nix closure; it stays out of `home.packages`
to avoid merging its manifest with other plugins in the user profile. `Alt+P` opens its
popup; Ghostty also forwards the existing `Cmd+P` chord as `Alt+P`.
Reload Herdr (`herdr server reload-config`) and Ghostty (`Cmd+Shift+,`) after
activating configuration changes.
Editing source or building a new system does not update an existing Nix store
registration; activate the new configuration to use that build, or explicitly
relink the source for development as below. Reopen the popup after either change.

For local development, without a rebuild:

```sh
herdr plugin link "$NIXCFG/home/noghartt/features/herdr/pr-tree"
herdr plugin action invoke open --plugin nixcfg.pr-tree
```

The action is also available in Herdr's command palette as
“GitHub: my open pull requests”. Linking makes the action available immediately;
the configured keyboard shortcut requires Home Manager activation.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move selection |
| `←` / `→`, `h` / `l` | Collapse/expand a repository or move to its parent/child |
| `Enter` | Open the selected PR in the default browser; fold a repository |
| `y` or `c` | Copy the selected PR's URL |
| `/` | Filter by repository, PR number, title, draft/open, review, or CI status |
| `Enter` while filtering | Finish typing the filter |
| `Ctrl+U` | Clear the filter |
| `r` or `Ctrl+R` | Refresh |
| `PageUp` / `PageDown`, `g` / `G` | Move by page or to the first/last row |
| `Esc` | Clear an active filter, otherwise close |
| `q` | Close (outside filter input) |

Opening a PR keeps the tree available for further browsing. macOS uses the
system `open` and `pbcopy`; Linux uses `xdg-open` and `wl-copy` (Wayland) or `xclip`
(X11). Browser tab/window placement follows the default browser's preferences.
Run in a local desktop session for browser and clipboard access.

## Validation

```sh
python3 -B -m unittest discover -s home/noghartt/features/herdr/pr-tree -v
```

See the [GitHub CLI pagination documentation](https://cli.github.com/manual/gh_api)
and [Herdr plugin CLI reference](https://herdr.dev/docs/cli-reference/#plugins).
