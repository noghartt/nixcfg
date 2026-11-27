# Deep research

`/research <question>` in pi-durable turns a broad question ("what tools could improve our CI?") into a
plain-folder report: a cited write-up, the candidate tools and stacks, and an annotated reading list.

Code: `home/noghartt/features/pi-durable/` (`src/research.ts` for the tools, `skills/research/` for the method,
`agents/researcher.md` and `agents/research-critic.md`) and `features/cli/secrets-env.nix` for the API keys.

## Goals

- **Broad questions, mostly about tools.** Landscapes ("tools to improve CI"), concepts ("how do CRDTs work,
  what to read") and comparisons ("Bazel vs Buck2 vs Nx"). Practitioner writing (engineering blogs, talks, HN
  threads, repos) and papers both count.
- **Reference material, not a knowledge base.** Reports land in a plain folder and are not maintained; `rg`
  finds them later. Deleting a folder is the whole maintenance story.
- **pi-durable native.** Tools are a pi-durable extension and the fan-out is `parallel`, so a run survives a
  crash or close like any other session.
- **Cited or dropped.** A claim with no fetched page behind it does not reach the report.

Non-goals: Zotero or Obsidian sync, a hosted UI, a crawler.

## The run

`/research [--quick|--deep] <question>` is a built-in command that submits `/skill:research <question>`, so the
conversation receives the skill as a collapsed card and becomes the lead. `/skill:research` works the same.
The skill (`skills/research/SKILL.md`, linked to `pi/agent/skills/research`) holds the method:

1. **Scope.** At most three questions, only when the answer changes the plan; otherwise state assumptions. Pick a
   template: landscape, concept or compare.
2. **Run folder and prior art.** `${PI_DURABLE_RESEARCH_DIR:-~/research}/<date>-<slug>/` with `notes/`; `rg` over
   earlier `report.md` files for seeds.
3. **Plan.** `plan.md` with 3 to 6 angles (taxonomy, candidates, practice, discussion, papers, background).
4. **Fan out.** `parallel` with `researcher` subagents, one notes file each, a search and fetch budget per task.
   One broad angle may go to the `gemini` profile (Google's index through Antigravity); its answer is kept as
   leads, never cited.
5. **Critique.** `research-critic` runs `research_verify`, flags unsupported, single-source, stale, vendor-only
   and contradictory claims and missing angles, and ranks follow-ups. Those become a second, smaller round. Two
   rounds by default, three with `--deep`, one and no critic with `--quick`.
6. **Write and check.** `report.md` from the notes only, every factual sentence cited `[n]` into the reading list;
   `research_verify` again, then the report drops or re-sources what failed. `sources.jsonl` lists every source.

Budgets are instructions to the researchers (15 searches and 10 fetches each by default), not hard caps.

**Notes** are JSONL, one per claim: `{claim, quote, url, title, author, date, kind, tier, topic}`, appended with
`research_note`. A quote is copied from `web_fetch` text, never from a search snippet or a Kagi summary.

**Untrusted pages.** Researchers read arbitrary web pages, so they get no `read`, `bash` or `write`: only the three
retrieval tools and `research_note`, which appends validated notes to `.jsonl` files under the research folder and
nowhere else. A prompt injection on a page therefore has no shell, no files and no secrets to reach. `web_fetch` fences page text as untrusted data, and the
critic and the lead are told to treat quotes and answers as data. The critic has `read` and `research_verify` only.

**Tiers**, best first: primary (docs, papers, the project's repo), experience (a team's production report or talk),
discussion (HN, forums: sentiment and pitfalls), vendor, aggregator (listicles: leads only, never cited).

**Templates** (in the skill): landscape (TL;DR shortlist, taxonomy, candidate tables with licence and maturity, in
practice, tradeoffs, recommendation), concept (key ideas, history, state of the art, a reading path from intro to
papers), compare (verdict, criteria first, side-by-side table with a citation per cell, migration costs). Every
report ends with an annotated reading list (tier, read time, why read it) and open questions. `report.md` starts
with frontmatter (`question`, `date`, `template`, `tags`, `session`).

## Tools (`src/research.ts`)

Installed in every conversation, subagents included. All but `research_note` are read-only and `replay: "safe"`.
Profiles list them in `tools` (`researcher`: `web_search`, `web_fetch`, `lookup`, `research_note`;
`research-critic`: `read`, `research_verify`).

- **`web_search`**: `engine` `exa` (default), `kagi` or `kagi-smallweb` (Kagi's Enrichment index of independent
  sites); `count`; for Exa also `kind` (paper, github, news, pdf, personal site, company, tweet), `since`,
  `domains` and `similar` (findSimilar on a URL, for alternatives to a known tool). Returns titles, URLs, dates
  and highlights, not pages. With one key missing, or one engine failing (Kagi's Search API is invite-only), it
  uses the other and says so, including which Exa-only filters Kagi ignored; with no key it says to use `lookup`
  or the `gemini` profile.
- **`web_fetch`**: a page as text, through the ladder below; `query` keeps the matching paragraphs and their
  neighbours, `offset` and `maxChars` page through long text. Results are cached by URL for 30 days in
  `$XDG_CACHE_HOME/pi-durable/research/`, shared by every run; Kagi summaries are never cached, so a later fetch
  tries the real readers again. An unreadable page is reported with every step's reason. Text comes between
  `<<<untrusted page text …>>>` fences.
- **`lookup`**: free sources, no key: `wikipedia` (summary, the article's cited sources, other matches),
  `openalex` (works with citation counts and open-access links), `arxiv` (terms ANDed, quotes for phrases), `hn`
  (Algolia story search with points and comments) and `github` (`gh search repos` by stars, or `owner/repo` for
  stars, last push, latest release, licence, archived).
- **`research_note`**: appends notes to a `.jsonl` file inside `${PI_DURABLE_RESEARCH_DIR:-~/research}` (refused
  anywhere else); a note needs a quote unless its tier is `unreadable`.
- **`research_verify`**: for every note with `url` and `quote`, reads the page (cache first, never a
  summary) and scores how much of the quote is on it by word triples on word boundaries: verified (≥ 95 %),
  close (≥ 60 %), missing, unreadable, skipped (no quote, or not valid JSON). Lists the notes files it read, so
  the critic can open them without a shell.

### Fetch ladder

1. **Exa `/contents`** with `livecrawl: "fallback"`.
2. **Plain fetch** with a browser user agent, then HTML to text (the largest `<article>` or `<main>`, headings
   and lists kept, navigation dropped, title, author and date from meta tags).
3. **Headless Chrome** for pages that need JavaScript (below).
4. **Wayback Machine**: the closest snapshot, fetched raw (`id_`).
5. **Kagi Universal Summarizer** for PDFs, videos and anything left; marked as a summary, never quoted.

Steps 1 to 3 reject challenge and consent pages (Cloudflare, "enable JavaScript", 429 pages, bodies under 200
characters) so the next step tries. A 404 or 410 ends the ladder: no other reader will find a page that is gone.
URLs on this machine or a private network (localhost, RFC 1918 and CGNAT ranges, single-label hosts, `.local`,
`.internal`, `.ts.net`, ...) are never sent to Exa, the Wayback Machine or Kagi. archive.today was dropped: it has
no API and answers scripts with a captcha.

### Browser step: headless Chrome

`chrome --headless=new --dump-dom` with a throwaway `--user-data-dir`, a normal browser user agent (headless Chrome
otherwise announces itself as `HeadlessChrome`) and `--virtual-time-budget=8000` so scripts settle before the DOM is
printed; the DOM then goes through the same HTML-to-text as a plain fetch. It opens no window, no Dock icon and no
app-switcher entry (macOS lists it as `BackgroundOnly`), needs no desktop session, so it also works on Mellon, and
runs at most two at a time per process. Chrome runs in its own process group: a timeout (60 s) or abort kills it
with its helpers, and the profile folder is removed. The pi-durable wrapper sets `PI_DURABLE_CHROME` to the Home
Manager Chrome (`programs.google-chrome.package`, `bin/google-chrome-stable` on both platforms); without it the
step looks for `google-chrome-stable` on PATH.

**Why not Cua Driver.** The first design drove a real, headful Chrome through a second Cua Driver daemon. It
worked (a read-only tool policy, its own socket, the semantic outline paged with continuations), but every browser
it launched opened a visible window on the current Space, and macOS keeps at least 40 px of a window on screen when
it is moved away (`set_window_frame` to −5000 settled at x = −1240). Measured on nine sites with fresh profiles, Cua
read nothing headless Chrome could not: both were stopped by G2 (DataDome), npm (Cloudflare challenge) and Reddit,
and both read Linear's JavaScript changelog, Medium and Cloudflare's docs; headless Chrome also read Stack Overflow,
Indeed and Zillow. Notes for a later logged-in route through Cua (version 0.33.1):

- A bounded capability manifest needs exact browser origins (no wildcards, `about:blank` listed), so it cannot read
  arbitrary sites; standard mode plus a user policy (`CUA_DRIVER_POLICY_FILE`) allowlisting tools can.
- A second `serve` needs its own `--socket` and `--pid-file` (or it takes over the general daemon's pid file) and
  `--no-permissions-gate` (the browser route needs no Accessibility or Screen Recording; with the gate, a daemon
  whose grants are attributed to its launcher answers every call with exit 75).
- `browser_prepare` without a pid refuses when no vendor-signed Chrome is in `/Applications`; Home Manager's Chrome
  is in `~/Applications/Home Manager Apps`, so a running Chrome's pid has to name the binary.
- `cua-driver call` prints the tool's JSON; refusals are `{"status": "refused"}` with exit 0 or 1, denials a
  `Permission denied:` line on stderr. Named sessions carry across calls. `semantic_v2` snapshots hold 300 nodes;
  `snapshot.continuation` pages through the rest.

### Keys

`EXA_API_KEY` comes from the `Nix` vault (`op://Nix/EXA_API_KEY/notesPlain`) through `secrets-env.nix`, into
interactive shells and so into pi-durable. `KAGI_API_KEY` is not mapped yet: its item does not exist, and
`opnix env` resolves all references or none, so a mapping without an item makes every shell secret go missing.
Create the item first, then add the mapping. Without the Kagi key, `web_search` uses Exa only.

## Not built

- **Logged-in route**: reading pages behind the user's own Chrome logins (paywalls, internal docs). It needs a
  Cua Driver runtime started with `--grant existing-profile` only for an opted-in run (`/research --logged-in`), and
  on macOS 27+ Full Disk Access for CuaDriver.app. Attaching to an existing window opens no new one.
- Hard spend caps per run, `aeval` scoring of research sessions, hashcards from a report, `/research follow <dir>`.

## References

- Anthropic, "How we built our multi-agent research system" (lead plus parallel subagents).
- Stanford STORM / Co-STORM (perspective-guided angles), dzhng/deep-research, GPT Researcher, LangChain
  open_deep_research, Jina node-DeepResearch.
- Exa API (`/search`, `/findSimilar`, `/contents`), Kagi API (Search, Enrichment, Universal Summarizer).
- Cua Driver docs (`https://cua.ai/docs/llms.txt`): "Drive a browser" and "Set permissions".
