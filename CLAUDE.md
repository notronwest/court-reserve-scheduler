# CourtReserve Scheduler — CLAUDE.md

> **Session bootstrap** — Read [`STATUS.md`](STATUS.md) first (append-only front
> door: current state · done · in flight · next). Before wrapping a session,
> append a dated entry there. Newest on top; supersede, don't rewrite.

> **Strategic context** — For the *why* (manifesto) and *what's next* (strategy) across all four repos in this stack, see `../wmpc-meta/strategy.md`. That sibling directory is auto-synced on every `git pull` via `scripts/claude-bootstrap.sh` — run it once after first cloning to install the hooks. Update `wmpc-meta/strategy.md` after meaningful strategic decisions; engineering specs stay in this repo's docs.


Automated scheduling system for White Mountain Pickleball Club.
Generates AI-powered recommendations, posts them to Discord for approval,
and books confirmed events on Court Reserve automatically.

## Architecture

**The live jobs run TypeScript (`ts/`), not the Python at the repo root.** Five
launchd agents run on the club Mac, installed by `./setup.sh` from
[`ts/ops/`](ts/ops/). Court Reserve access goes through the `courtreserve-api`
HTTP service — none of these drives a browser. The Python tree is the rollback
path (`ts/ops/rollback.sh`), kept working but not what runs.

| Service | When | What |
|---|---|---|
| `com.whitemountain.scheduler` | Daily 8:00 AM | LLM recommendations → **books directly** (auto-book) → Discord confirmation + `logs/booking_log_<date>.json` |
| `com.whitemountain.listener` | Always-on | Polls Discord every 3s — handles `!book`/`!move`/`!schedule`/`!help` and waitlist expansions |
| `com.whitemountain.fetch-history` | Mondays 7:00 AM | Fetches 3 months of attendance history |
| `com.whitemountain.check-waitlists` | 9/11/13/15/17 daily | Alerts on waitlists that can be expanded to another court |
| `com.whitemountain.checkin` | Mondays 6:00 AM | Checks in players on past events so history stays accurate |

The daily job **no longer waits for Discord approval**. `pending_approval.json`
and the `all`/`1,3,5`/`none` replies below are the `--recommend` path, still
reachable ad hoc but not what the 8 AM agent runs.

## Key Files

| File | Purpose |
|---|---|
| `policy.json` | ALL business rules (edit this, not the code) |
| `run.py` | Main CLI: `python run.py 5/7/2026 --llm --book` |
| `recommender.py` | Rule-based + LLM hybrid recommendation engine |
| `llm_ranker.py` | Claude API call for Pass 1+2 recommendations |
| `llm_parser.py` | Claude haiku parser for `!book` and `!move` commands |
| `book_event.py` | Playwright automation — books and edits occurrences |
| `cr_client.py` | Court Reserve API client + browser session management |
| `discord_listener.py` | Persistent listener (approval + ad-hoc commands) |
| `discord_notify.py` | Discord webhook integration |
| `history_analysis.py` | Attendance popularity scoring |

## Discord Commands

| Command | Effect |
|---|---|
| `all` / `yes` / `ok` / `1,3,5` | Approve daily recommendations |
| `none` / `skip` | Skip all recommendations |
| `!schedule 5/7` | Generate recommendations for any date |
| `!book Intermediate 5/7 at 2pm Court 3` | Ad-hoc booking (shows preview, confirm to book) |
| `!book Intermediate 5/7 at 2pm` | Same, but **the court is auto-picked** from whatever is free |
| `!move Intermediate 5/7 from 9am to 11am` | Move an existing occurrence |
| `!help` | Show all commands |

## State Files

| File | Purpose |
|---|---|
| `logs/pending_approval.json` | Recommendations waiting for Discord approval |
| `logs/listener_state.json` | Discord cursor + pending !book/!move params |
| `logs/browser.lock` | Prevents concurrent Playwright sessions |
| `logs/booking_log_*.json` | Per-day booking results (audit trail) |
| `history/history_latest.json` | Attendance data used by recommender |
| `cache/chrome_profile/` | Saved Court Reserve browser session |
| `state/fixed-events.json` | Last-good cache of the standing weekly pattern (D-0056), read from `courtreserve-api GET /fixed-events` (which returns the rows under `items`); used when that read fails. Cached **unfiltered** — the `until` cutoff is re-applied on every read, so a slot retired since the cache was written is still not booked |

## The standing weekly pattern (D-0056)

`courtreserve.fixed_events` is the **source of record** for the recurring slots the
daily job books 14 days out — not `policy.json`. The scheduler reads it over
`courtreserve-api GET /fixed-events` (rows under `items`) at the top of every run
(`ts/src/fixedEvents.ts`), and resolves in this order:

1. **live** — the HTTP read; on success the rows are cached to `state/fixed-events.json`.
2. **cache** — the last-good read, when the service is unreachable. Alerts.
3. **seed** — `policy.json`'s `fixed_events.events`, when there is no usable cache. Alerts.

Three rules that exist because of real incidents:

- **A fallback is never silent.** Anything but a clean live read posts a Discord
  failure alert (D-0049's path, `sendFailureAlert`). So does a pattern that resolves
  to **zero** active slots, because "everything is retired" and "the read quietly
  returned nothing" are indistinguishable to the recommender.
- **`until` is the retirement switch, honoured on every source.** A row whose `until`
  is on or before today is not booked. The service filters it server-side, but the
  cache and the seed do not — so the cutoff is re-applied on each read.
- **`preferred_courts` pins courts by number (1–4).** A pin is an instruction, not a
  hint: the slot takes the free subset of its pins and does **not** spill onto an
  unpinned court. If every pinned court is taken the slot is skipped as `no_court`,
  logged, and recorded in `logs/booking_log_<date>.json` under `fixed_events.skipped`.

## Hard Constraints (policy.json)

1. No same-court overlap with existing events — enforced on **both** the daily
   recommender and the ad-hoc `!book` path (`resolveCourt` in `discord/listener.ts`,
   sharing `availability.ts` with the recommender). `!move` does **not** check this yet.
2. One primary court per recommended booking
3. Max 2 occurrences of same event per day
4. **2-hour minimum gap between same-event occurrences** (no back-to-back)
5. All 5 skill levels covered when possible
6. Fill toward 60% utilization target

Skill levels: Beginner · Advanced Beginner · Intermediate · Advanced Intermediate · Advanced

## Common Operations

```bash
make run               # Recommend + book (14 days out)
make run DATE=5/7/2026 # Specific date
make dry-run           # Preview only (posts to Discord, no booking)
make history           # Fetch attendance history now
make status            # Check all three launchd services
make logs              # Tail listener log
make restart           # Restart Discord listener after a code change
make check             # Full health check
make migrate           # Create migration bundle for a new machine
```

## Booking Flow

1. `run.py` fetches live schedule → LLM generates recommendations → posts embed to Discord
2. `run.py` saves `pending_approval.json` and exits (listener handles approval)
3. `discord_listener.py` polls Discord every 3s; on approval reply → calls `book_event.py`
4. `book_event.py` fills the Court Reserve AddEventOccurrence form via Playwright
5. For multi-court events: books primary court, then opens UpdateReservation modal to add courts + set MaxPeople=8
6. Results embed posted to Discord

## Book Event Technical Notes

- Court Reserve uses Bootstrap 3 modals for editing — `UpdateReservation` doesn't work as a standalone page (jQuery/Kendo missing); must open via `Events/Edit/{event_id}?page=occurrences` and click the `a[data-remote*="UpdateReservation"]` link
- Kendo MultiSelect hides the original `<select>` — wait for `.action-modal.in`, not `#Courts`
- Success detection: `wait_for_url(lambda url: "AddEventOccurrence" not in url, timeout=12000)` — not a fixed sleep
- Occurrence IDs captured from `data-remote` attribute or `revertReservationToSeries` onclick pattern
- **Archived events are invisible by default.** Court Reserve treats an event with no
  future instances as *archived*: it drops out of the events list entirely. To see one you
  must widen the list's date range back to the beginning of time — **1/15/2025**. This is
  how you recover the `event_id` of a dormant series (e.g. a seasonal or paused Open Play).
  A "missing" event is usually archived, not deleted — check before assuming it's gone or
  creating a duplicate.

## Environment Variables

Stored in `.env` (never committed):

```
CR_BASE_URL           # https://app.courtreserve.com
CR_EMAIL              # Court Reserve admin email
CR_PASSWORD           # Court Reserve admin password
DISCORD_WEBHOOK_URL   # Webhook for posting embeds
DISCORD_BOT_TOKEN     # Bot token for reading channel messages
DISCORD_CHANNEL_ID    # Channel ID for the listener
ANTHROPIC_API_KEY     # Claude API for LLM recommendations + !book parsing
```

## Migration

```bash
# On old machine:
make migrate           # Creates migration_YYYYMMDD.tar.gz

# On new machine:
git clone git@github-notronwest:notronwest/CourtReserve-Scheduler.git
cd CourtReserve-Scheduler
./setup.sh --restore ~/migration_YYYYMMDD.tar.gz
```

Or run `make check` to verify an existing install.

## Uninstall

```bash
make uninstall         # Interactive — stops services, removes plists, optionally deletes project dir
```

Or manually:

```bash
# 1. Stop and remove launchd services
launchctl unload ~/Library/LaunchAgents/com.whitemountain.scheduler.plist
launchctl unload ~/Library/LaunchAgents/com.whitemountain.fetch-history.plist
launchctl unload ~/Library/LaunchAgents/com.whitemountain.listener.plist
rm ~/Library/LaunchAgents/com.whitemountain.*.plist

# 2. Remove system logs
rm -rf ~/Library/Logs/court_reserve

# 3. Delete project directory (contains .env credentials + booking history)
rm -rf /path/to/CourtReserve-Scheduler
```

## LLM Cost

- Daily recommendations: ~$0.001/day (Claude Sonnet)
- `!book` / `!move` parsing: ~$0.0002/command (Claude Haiku)
- Approval polling: $0 (plain HTTP, no tokens)

## Backlog

This repo's backlog lives on the **WMPC Roadmap** GitHub Project board
(Project **#1**, owner `notronwest`) — **not** in a file. This repo's
stories are its `story`-labeled GitHub Issues, added to the board.

- **Read:** `gh issue list --repo notronwest/CourtReserve-Scheduler --label story`
  (whole board: `gh project item-list 1 --owner notronwest`).
- **Write ("add to backlog"):** create a GitHub Issue with a user story + a
  scripted, code-free `## Acceptance criteria`; label it `story`; add it
  (`gh project item-add 1 --owner notronwest --url <url>`); set **Priority**
  + **Type**. Runs on your `gh` auth — no approval needed.
- **Statuses — one pipeline:** `Backlog` → `Agent Ready` → `In Progress` →
  `In Review` → `Done`, with `Blocked` and `On Hold` as side rails.
  - The **Builder** drains **Agent Ready** into PRs and moves cards itself;
    **you merge** `In Review` (the only gate). It never merges or pushes main.
  - **`Blocked` = the Builder needs you** (missing AC, a product decision, or
    risky work — migrations / security / money). **Draining `Blocked` is your
    loop:** read its comment, then add the AC/decision and move it to **Agent
    Ready**, do the risky part yourself, or close it.
  - **`On Hold`** = intentionally parked (no action needed); **`Backlog`** =
    uncurated intake.
- **Full convention** (lifecycle table, the Blocked flow, fields, examples):
  [`../wmpc-meta/conventions/backlog.md`](../wmpc-meta/conventions/backlog.md).
  Don't reintroduce a `BACKLOG.md` file.





<!-- wmpc-block:environments:v1 START -->
## Deploy environments — TEST vs PR **preview** vs PROD (they differ)

There are **three** running environments, not two. Know which one you're
looking at, because they do **not** share configuration:

| Environment | Comes from | Cloudflare variable scope |
|---|---|---|
| **TEST** | the `main` branch build | the `main`/TEST build's variables |
| **PR preview** | **every open PR** gets its own preview deploy | the **preview** (non-production) scope — set **separately** |
| **PROD** | the `production` branch build | the production scope |

**The trap that costs real debugging time:** a PR **preview is not TEST.**
Cloudflare builds each deploy with the variables/secrets configured for *that
deploy's scope*, and for our Vite SPAs the `VITE_*` values are **baked into the
bundle at build time**. So a PR preview is compiled against the **preview**
scope's `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ENV`,
`VITE_COACH_AI_SECRET`, `VITE_GOOGLE_CLIENT_ID`, etc. — which are configured
independently of TEST. If any of those differ or lag, the preview points at a
**different Supabase project / different keys / a missing secret** than TEST and
**behaves differently for reasons that have nothing to do with the code.**

**Because of this, always:**

- **Name the environment** when you hand work over. Say "validate on the **PR
  preview** (its own env-var scope, *not* TEST)" — don't let anyone assume the
  preview equals TEST.
- **Suspect the env vars first** when a preview misbehaves but the code looks
  right. Confirm the preview's Supabase URL / keys / secret are the intended
  ones *before* debugging code. `VITE_APP_ENV` and the Supabase URL are visible
  in the running app — check them.
- **Add any new var/secret a feature needs to the preview scope too**, not just
  TEST/PROD. Set only in TEST → the PR preview won't have it and fails in a way
  that looks like a code bug (and it must be in PROD before promotion).
- **Remember `VITE_*` is build-time.** Changing a Cloudflare variable takes
  effect only after the PR **re-builds/re-deploys** — a page refresh won't pick
  it up.

Migrations are the mirror image: a preview is **frontend-only against the live
DB**, and a migration applies **only on merge to `main`** — so the DB the
preview talks to is real/live, while the schema change it may depend on isn't
there until merged (why DB and UX ship as separate PRs — see the migration
convention).
<!-- wmpc-block:environments:v1 END -->

## Git & gh hygiene

These keep routine git/gh commands from triggering Claude Code approval
prompts. The prompts come from a **hardcoded safety heuristic** — an
allowlist *cannot* suppress them — so the fix is how the command is written:

- **Never lead with `cd <path> && …`.** A `cd` in front of git/gh (or any
  command with a pipe, `$( )`, redirection, or a quoted multi-line arg)
  trips Claude Code's "changes directory → untrusted hooks / path-resolution
  bypass" check and prompts *every time*, regardless of the allowlist.
- **Git:** use `git -C <path> …`, never `cd <path> && git …`.
- **gh:** pass `--repo <owner>/<repo>` and run the command directly (no
  `cd`). `gh` is allowlisted, so a bare `gh …` runs without a prompt.
- **`gh issue|pr create` with a multi-line body:** write the body to a file
  and use `--body-file <file>` (or `--body-file -` with a heredoc). An inline
  `--body '…## Heading…'` puts a newline-then-`#` inside a quoted argument,
  which trips a separate "expansion obfuscation" heuristic.
- **Don't wrap allowlisted tools in big compound shells.** The allowlist
  applies per-command; a leading `cd` + substitution/pipe defeats it. Run the
  tool directly and let the allowlist do its job.


<!-- wmpc-block:deployment:v1 START -->
## Deployment — read `DEPLOYMENT.md` before touching anything that ships

This repo has a root **[`DEPLOYMENT.md`](./DEPLOYMENT.md)**: the one-screen map
of what ships from here, what triggers it, where it lands, which variable scope
it builds against, how to verify, and how to roll back. It opens with a fenced
YAML block tagged `# wmpc-deployment: v1` — **parse that block** instead of
guessing; don't infer the deploy shape from `wrangler.*`, a plist, or a CI
workflow.

Why this exists: the fleet runs **six different deployment shapes** (Pages
auto-build, `wrangler deploy`, GitHub-Actions Supabase pushes, launchd services
on the club Mac mini, Cloudflare Tunnels, Caddy static) and they are routinely
confused for each other — including cases where the same command means very
different things (`./setup.sh` on the mini is a deploy **and** a production
schema migration).

**You must:**

- **Read `DEPLOYMENT.md` first** for any question about how this repo ships, and
  before running any deploy, migration, or `setup.sh`.
- **Update it in the SAME change** as anything that alters how the repo ships —
  a new target, a branch→environment change, a new secret, a moved host, a
  retired target. It must never lag the system.
- **Never invent a fact into it.** `unknown` / `TODO` is a correct value; a
  plausible-looking URL, host, or branch mapping gets trusted and acted on.

Canonical convention: `../wmpc-meta/conventions/deployment-doc.md`.
Pillar: `daemon/docs/change-discipline.md`.
<!-- wmpc-block:deployment:v1 END -->

<!-- wmpc-block:engineering-standard:v4 START -->
## Engineering standard

Operate as a **senior full-stack engineer**, not a code generator. This is the
posture for all code work in this repo (interactive sessions and the Builder):

- **Production-minded.** Handle errors, edge cases, and loading / empty /
  failure states — not just the happy path.
- **Verify before "done."** Typecheck, build, and lint; run the test where one
  exists. Report the real output — never claim success you didn't check.
- **Delegate to sub-agents to protect your context — by default, not as a last
  resort.** For well-scoped, context-heavy work, spin up a sub-agent (the
  Task/Agent tool) and keep only its *result* in your main thread. Reach for it
  whenever it applies: broad multi-file searches and codebase exploration (use
  the **Explore** agent — you want the conclusion, not the file dumps);
  **mechanical sweeps** with clear rules ("convert all ~20 loading states to
  `<Loading>`"); research questions; and independent parallel workstreams (launch
  them in one message so they run concurrently). **You stay the owner:** the main
  session *verifies* (typecheck/build/lint), *reviews the diff*, and *ships the
  single PR* — the sub-agent does the legwork, you keep the judgment and the
  context window. **Don't** delegate trivial quick edits (the round-trip costs
  more than it saves), work needing tight back-and-forth with Ron, or **parallel
  edits to the same files** (they clobber each other — serialize, or give each
  agent its own worktree). A budget-capped headless run (the Builder) weighs the
  extra token cost before fanning out; an interactive session should lean in,
  since context is the scarce resource.
- **Match the codebase, and reuse before you build (D-0049 — a gate).** Follow
  existing patterns, naming, and structure; read neighboring code first. **Before
  writing any component, section, hook, or util, search for one that already does
  the job** — if it exists, reuse it; if it almost fits, extend it or extract a
  shared version (one implementation, mounted many ways via a prop), **never a
  second copy that diverges.** A duplicate of an existing surface is a defect the
  reviewer rejects, not a shortcut. Name the reuse choice in the PR. (UI specifics
  in the UI-work block.)
- **Mockups are the real page, running and interactive — never an inline
  widget.** When asked to "do a mockup," the deliverable is the **actual page
  rendered end-to-end with the proposed change inline**, served in a **real,
  clickable browser preview**: start the app's dev server and open the real
  route, or — only if that's genuinely impractical — write a full standalone
  HTML page that duplicates the real page and open *that* in the preview.
  Duplicate the real page/component being changed (its true layout, markup,
  styles, and design tokens) and modify *that* in context; never an abstract,
  from-scratch, or "clean-room" stand-in. **Do NOT** deliver a mockup as a
  chat-inline visualization/widget (e.g. a `show_widget` / visualize call, or an
  SVG/HTML blob embedded in the reply) — the whole point is to **feel the real
  UX by interacting with it before we build**, which a static inline widget
  can't do. If the target page doesn't exist yet, build the new page full-size
  and interactive in a real preview all the same. Fall back to a static image or
  snippet only when explicitly asked for one.
- **Right-size it.** The simplest thing that fully solves the task — no
  speculative abstraction, no gold-plating a small change.
- **Security + data aware.** No secrets in code, validate inputs, respect
  auth / tenancy boundaries.
- **Surface tradeoffs.** Flag risks, migrations, and breaking changes; ask
  before large refactors or irreversible actions.
- **Give the Chief of Staff a surface.** Anything this repo builds that holds
  club data or does club work must be usable by the CoS **unattended**, in the
  same change — not only by Ron in a UI. That means: a documented entry point
  she can run on the mini (CLI / module, under the repo's host guard if it
  writes); for claude.ai / Cowork scheduled runs, a `wmpc-mcp` tool with
  read-only annotations so the client auto-approves it; and, when it acts, the
  `cos_whitelist` key that governs it. Intake question 11 in
  `daemon/infrastructure/INFRA-INTAKE.md`.

This raises the floor; it does not override this repo's specific conventions
above (branch/PR discipline, mobile-first, design tokens, docs-in-the-same-change).
<!-- wmpc-block:engineering-standard:v4 END -->

<!-- wmpc-block:ui-work:v3 START -->
## UI work — required before any visual change

Before ANY change to visual/UI code (a page, component, layout, nav, or style)
— this is a gate, not a suggestion:

- **Reuse before you build — a second copy of a component is a DEFECT (D-0049).**
  Before you write a component, page section, hook, or util, **search for one that
  already does the job** (grep the `components/` dir and the feature you're in). If
  it exists, **reuse it.** If it *almost* fits, **extend it or extract a shared
  version** — one component rendered many ways via a `variant`/`mode` prop, not a
  copy. Never copy an existing surface into a new file and diverge it. The target
  shape: `EventSettingsForm` is the edit page, the console tab, AND the wizard step
  off ONE file (`variant="page"|"inline"`) — the wizard has no settings code of its
  own. **Name the reuse choice in the PR** ("reuses X" / "extracted X so A and B
  share it"). A card that can only be met by duplicating an existing surface is a
  shaping problem — route it back, don't build the copy. The reviewer REQUESTS
  CHANGES on a duplicate.
- **Consult our design system FIRST.** `../wmpc-meta/design-system/` (tokens) +
  this repo's `docs/DESIGN_PREFERENCES.md` govern look, spacing, layout, and
  brand. Reuse existing components and tokens; do not invent one-off styles.
- **Component behavior + accessibility: follow shadcn/ui + Radix conventions**
  (accessible primitives, keyboard + ARIA, focus management) — but **style with
  our design tokens, NOT Tailwind.** This stack uses inline styles + a minimal
  index.css, no CSS framework; a Tailwind/shadcn migration is a separate,
  deliberate project, not something to introduce inside an unrelated UI change.
- **Mobile-first is non-negotiable.** Design AND verify at **390px width FIRST**,
  then scale up. A UI change that has not been checked at 390px is NOT done.
- **Mockups run in a real, interactive preview — not a chat-inline widget.**
  When Ron asks to "do a mockup," render the **whole page** with the change
  inline in a **clickable browser preview** (the app's dev server on the real
  route, or a full standalone HTML page duplicated from the real one) so the UX
  can be *felt* before we build. Never a `show_widget` / inline SVG-or-HTML blob.
  Full rule under **Engineering standard → Mockups**.
- **Uncovered pattern?** Fetch the specific Radix / shadcn (or Material 3) doc
  for that component rather than freelancing or guessing at the design.
- **Never overwhelm the user — guide them, don't dump the whole surface.** A
  config screen is a design failure when it's a **wall of granular controls the
  user has to reverse-engineer** — the *Stripe restricted-key permissions screen*
  anti-pattern: dozens of ungrouped toggles, two unexplained columns ("Permissions
  vs Connect Permissions"), no search, and a primary field ambiguous enough to
  look like a filter. Instead: **sensible defaults**; a **preset for the common
  task** (one click does the 90% case); **search/filter** on any long list;
  **plain-language labels** (no unexplained jargon or ambiguous columns);
  **progressive disclosure** (advanced/rare options collapsed by default); and
  **bulk actions** for repetitive rows. There should be one **obvious primary
  path**; the long tail is opt-in. If a screen forces the user to understand the
  whole domain model just to make one choice, it needs redesigning — flag it, don't
  ship it.
<!-- wmpc-block:ui-work:v3 END -->

<!-- wmpc-block:ron-instructions:v1 START -->
## Giving Ron instructions (D-0068)

These four rules apply whenever a step might land on Ron. They bind every agent and session,
including Rachel. Ron, 2026-10-07: "I need to GSD and the more confusing this is or the more I
go back and forth with you the more time and money it costs."

1. **Do it yourself, but ask first.** If you can do a step with your own access (merge, run a
   command, edit a file, call an API, post a comment), do not hand it to Ron. Ask in one line:
   "Shall I merge it?" Steps on the whitelist need no ask: `agents/WHITELIST.md` in the
   daemon repo for sessions, her autonomy settings for Rachel. When Ron says "yes, and from
   now on", add the step to that list in the same change.
2. **When only Ron can do it, give the steps here, in the reply.** Do not point him to a
   DEPLOYMENT.md, a README or a doc. Number the steps and give one action each. Name where:
   the app, site or machine ("Terminal on the mini"), and the page and button. Say what he
   should see and what to tell you when done. End with what you do next.
3. **Paste-safe for his zsh terminal.** Each command goes in its own copy box, exactly as it
   runs: no `#` comments (zsh treats `#` as a literal, so a commented line fails), no `$ `
   prompt, no `…`, no `<placeholder>` to edit by hand. Use full paths and keep a sequence on
   one line with `&&`. A secret is read with a hidden prompt, so it never sits in the
   command, the chat or the shell history:
   `read -rs "s?Signing secret: " && echo "NAME=$s" >> /full/path/.env && echo saved`.
   Commands handed to Ron may use variables. The no-variables rule is about agents' own
   commands and the allowlist, not his.
4. **One copy box per field.** When a form has separate inputs, give each value its own box,
   labelled with the field name as the screen shows it ("**Endpoint URL** field:"). Never
   stack several values in one box, because a multi-line paste doesn't split into fields.
   Checkboxes and dropdowns are stated in words, not boxes.
<!-- wmpc-block:ron-instructions:v1 END -->
