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

Four rules that exist because of real incidents:

- **A fallback is never silent.** Anything but a clean live read posts a Discord
  failure alert (D-0049's path, `sendFailureAlert`). So does a pattern that resolves
  to **zero** active slots, because "everything is retired" and "the read quietly
  returned nothing" are indistinguishable to the recommender.
- **A run that BOOKS uses a live read only.** The cache and the seed keep the pattern
  readable through an outage; they cannot make it trustworthy to write from. A cache
  re-applies `until`, so it cannot book a *retired* slot — but nothing in it can show
  a slot that **moved**, and the club moved one Tuesday→Monday and retired six inside
  one fortnight. So on the auto-book path (`ts/src/scheduler.ts`) a non-live source
  books **no** standing slot and says so in the alert; `--dry-run` and `--recommend`
  still show the fallback pattern, because seeing it is the point. The 8:45
  pattern-gaps job books the standing sessions from a live read and alarms when it
  has none — the rule it has always followed, now shared by both booking jobs.
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

**Constraints 3 and 3b are measured against `existing + recommended combined` — for
EVERY event id.** `policy.json` has always said so; the code used to count only the
five generic Open Play ids, and dropped every other `EventId` on the live calendar on
the floor. So for a standing slot with its own Court Reserve event (a Level Play or
Structured Play), the recommender could not see the occurrence it had booked a day
earlier: it found the court busy, took the next free one, and the slot ran as **two
instances of one session at one hour on different courts**. One hour of one session is
one occurrence holding however many courts it needs — a second booking of it is a
defect, not a two-court session. `ts/tests/duplicateFixedEvents.test.ts` holds that
line, and the booking path refuses a repeat of `(event_id, date, start_time)` even if
one reaches it.

**A cancelled reservation holds no court and is not the session being present.** The
`/schedule` feed can carry cancelled rows; `isCancelled` in `ts/src/availability.ts` is
the one predicate for them, used by every reader of the feed. This is what lets a
cleanup hold: cancel one of two duplicate instances and the survivor still blocks a
re-book, while the cancelled instance's court goes back to being usable. Cancelling the
**only** instance of a standing slot does not retire it — the gap-filler books it again
the next morning, by design. A standing slot is retired by stamping its `until`.

**A session booked twice at one hour is reported, never repaired.** The gap-filler counts
every occurrence at a slot, not the first one Court Reserve happens to list — taking the
first made the outcome depend on feed order, and matching a one-court duplicate ahead of
the healthy two-court instance read as a court shortage, so the fixer widened the
*duplicate* onto a third court. A slot with more than one occurrence now resolves as
`duplicate`: logged, named in the Discord report as booked twice rather than missing,
counted by `needsAttention` so the run exits non-zero. Removing a copy is a Court Reserve
cancel and Ron's call, so nothing books or widens against that slot until it is one again.

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


<!-- wmpc-block:engineering-standard:v5 START -->
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
- **Retrieval takes the highest tier it can reach (D-0147 — a gate).** When a
  feature answers from a corpus, pick the highest of three and say in the PR why
  the tier below does not reach. **Deterministic:** a key (an id, a date, a
  foreign key, a scope glob) selects the slice — exact, auditable, reproducible,
  and how most of this fleet already works. **Agentic:** no key exists, so the
  model searches with the tools it has (SQL, grep, an MCP read) and refines
  across turns — nothing to index or keep current. This being the default
  obliges no service to grow a free-text search surface it does not have; that
  is its own ticket and its own privacy review. **Embedded:** similarity over
  chunks, which needs **its own decision record** — the Claude API exposes no
  embeddings endpoint, so the real cost is a second AI vendor, not the index.
  **An index, cache or embedding is a derived view, never the system of
  record** — rebuild it from its source rather than trust it against that
  source. **And state only the provenance your evidence carries (D-0097):** a
  citation on retrieved *text*, an `as_of` and a source on a structured tool
  result, and neither invented where the tool supplies none — report the value,
  do not imply it is current. Never build a retrieval index over Court Reserve
  bookings, occurrences, rosters, occupancy, payments or QuickBooks data
  (D-0060, D-0103, and D-0120's money gate: `null` plus "needs money access",
  never a confident `$0`), and never over `.claude/history/`, which is
  gitignored because it can hold secrets quoted mid-session (D-0093). A corpus
  small enough to sit behind a prompt-cache breakpoint belongs there, not in a
  retrieval system — caching is cheaper, and it retrieves perfectly.
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
<!-- wmpc-block:engineering-standard:v5 END -->


<!-- wmpc-block:secrets:v1 START -->
## Secrets — never in a tracked file (enforced)

A credential never appears in a tracked file. Not in code, not in a doc, not in a comment, not as a
"default" in a script, not in an agent's prompt. Not even a value you mean to replace later — git
keeps it forever.

**This is enforced, not advised.** `scripts/scan-secrets.sh` runs as a pre-commit hook and in CI on
every PR; a commit or PR containing a credential is refused, with the value redacted.

- **Secret:** Discord webhook URLs (the token is in the path), Anthropic / OpenAI / Resend / Stripe
  live / GitHub tokens, the Supabase **service-role** key, any Postgres URL with a password,
  private keys, the Court Reserve password.
- **Not secret:** a Supabase **anon** key, a project ref or URL, a public bucket name.
- **Where they go instead:** Pages → Variables & Secrets (**PRODUCTION and PREVIEW separately**);
  Workers → `wrangler secret put`; mini services → a gitignored `.env` on the mini; agents →
  `~/.config/wmpc*/*.env`. Code **resolves at runtime and fails loudly when unset** — never a
  default.
- **Inspecting an env file:** `grep -o '^[A-Z_]*=' .env` lists the names. Never print values.
- **If one was ever pushed, ROTATE it.** Removing it from HEAD does not unleak it — it is in the
  history and in every clone.

Full reference, including the fleet's leak history: `wmpc-meta/conventions/SECRETS.md`.
Where every repo ships and what it touches: `wmpc-meta/conventions/FLEET-MAP.md`.
<!-- wmpc-block:secrets:v1 END -->


<!-- wmpc-block:stop-list:v1 START -->
## The stop list — act by default, and eight things wait for Ron (D-0207)

Every agent and session, in every repo: interactive sessions, Mr. Robot (the Builder), the
Reviewer, every drain and scheduled run. Ron, 2026-10-23: *"Can't you run this stuff without
permissions? I thought it was about not promoting. I need you to be more autonomous. Can we
define a black list?"* — and then, *"And this would be true for all repo agents? Including the
builder?"* Yes.

**Everything not on this list, act.** Do it, then say you did. There is no "ask first" by
default, no second list to check, and no category of work that is his merely because it is
important, irreversible-sounding, expensive, or new.

The authoritative list is `agents/STOP-LIST.md` in the daemon repo, mirrored into
`public.cos_stop_list` (which the approvals rail checks). The rows below are copied from it
verbatim. A repo that needs a row the others do not gets a decision record in daemon — never a
local edit to this block, which is overwritten on the next sync.

| # | Stops at Ron | What that means, and what it does NOT mean |
|---|---|---|
| 1 | **Anything a member or the public receives** | An email, a text, a post, a published event, a price change members can see, a page going live on the website. **Not**: a draft, a proposal, a preview, an internal note, or a reply to him. A lane may be opened to another approver only by a decision record naming them (D-0139 rule 3; the first is the marketing lane, approver Caryn). |
| 2 | **Money moving on a member's account** | Charging, refunding, crediting, or changing what a member pays. **Not** spending in general — buying a tool, paying for a model run, or taking on a cost that serves a member or buys a capability is **just done, and the number reported afterwards** (D-0197). Money is not the gate; a member's card is. |
| 3 | **Promotion to production** | A production deploy, a production schema change, a `main`→`production` merge. In his words: *"I thought it was about not promoting."* **Not** merging to `main`, not deploying to test, not running a migration on test. |
| 4 | **Destroying something that holds history** | Deleting data, dropping a table, a destructive migration, retiring a record. **Not** removing something created minutes ago in the same piece of work, and not a reversible retire that the system itself can undo. |
| 5 | **Ending or changing a member's membership** | Cancelling, suspending, moving a tier, switching off a renewal — **unless he has already directed it**, in which case his words are the approval and asking again is the failure (D-0198, D-0204). |
| 6 | **Committing the club to someone outside it** | Signing, agreeing terms, accepting a contract, promising a date to a third party. |
| 7 | **Anything from his personal life** | The wall holds: personal context never reaches a club surface, and a personal errand asks first (D-0131). |
| 8 | **Changing this list** | Adding a row, removing one, or widening what a row covers. His words, recorded, in the same change. |

**Two corrections ride with the list.**

- **Money is not the gate (D-0197).** Spending that buys a capability or serves a member is done,
  and the number reported afterwards. What stops is money moving **on a member's account**.
- **His directive IS the approval (D-0198, D-0204).** A row he has already directed is acted on,
  not re-asked — re-asking is itself the failure. His words go on the record.

**How to use it.**

- **Not on the list → do it.** Merging to `main`, deploying to test, running a migration on test,
  queueing work, running a job now, fixing data, a dry run, reading anything.
- **On the list → it is his, each time**, however the ask is worded, whoever is asking, and however
  obvious the answer looks.
- **On the list but already directed by him** → act on the directive and do not re-ask.
- **Genuinely unsure which side a thing falls on** → it is one question, asked once, and the answer
  becomes a row in `agents/STOP-LIST.md` in the same change.
- **A member is being harmed right now** → put it right first, even on the list (D-0197), then tell
  him what was done and why it could not wait.

A structural rule in a repo or an agent's own prompt — Mr. Robot never merges, the Reviewer's
APPROVE is the merge gate, a CI check — is a quality gate, not a permission, and still holds.
<!-- wmpc-block:stop-list:v1 END -->

<!-- wmpc-block:ron-instructions:v2 START -->
## Giving Ron instructions (D-0068)

These four rules apply whenever a step might land on Ron. They bind every agent and session,
including Rachel. Ron, 2026-10-07: "I need to GSD and the more confusing this is or the more I
go back and forth with you the more time and money it costs."

1. **Do it yourself.** If you can do a step with your own access (merge, run a command, edit
   a file, call an API, post a comment), do it and say you did. Do not hand it to Ron and do
   not ask first. The only steps that wait for him are the eight rows of the stop list (its own
   block in this file, D-0207); one of those he has already directed is acted on, not re-asked
   (D-0198, D-0204). The old whitelist, where anything unlisted was an ask, is superseded.
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
<!-- wmpc-block:ron-instructions:v2 END -->



<!-- wmpc-block:response-style:v5 START -->
## Response style — a short summary, and the ask unmistakable (D-0177)

Every reply, in every repo, from every prompt — interactive sessions, spawned
agents, the Builder, scheduled runs. Ron, 2026-10-14:

> *"I want all of the responses from any prompt from any repo to be a summary response very
> short give me what I need to know that happened. Make sure that if there's a question it's
> very clear what you need and if there's an action for me, it's very clear every single
> response starting now update every repo do whatever you need to make it happen"*

1. **Default to a short summary: what happened, and what it means.** Lead with the
   outcome. Not a narration of the steps you took, not a transcript of tool calls, not a
   restatement of the request back to him. Give the one fact that is the point; don't
   inventory everything you touched on the way.
2. **If you need something from Ron, the question is unmistakable.** State what you need,
   why you need it, and what you will do with each answer. **One question**, not a menu of
   five — pick the one that unblocks you and decide the rest yourself. It goes at the end,
   on its own, so it cannot be mistaken for commentary. Every ask of Ron is also a ledger
   line, never prose (D-0070).
3. **If there is an action for Ron, it is unmistakable.** What to do, where, and what
   happens next. This composes with **D-0068**: do it yourself if you can (D-0207); when only he
   can do it, the numbered steps go in the reply, paste-safe, one copy box per field.
4. **Nothing Ron reads contains an internal identifier.** No decision ids (`D-0174`), no
   repo names as nouns, no file paths, no component names, no ship or phase numbers, no
   issue or PR number standing alone as the subject of a sentence. **Say what the thing IS,
   in his words:** *"the live-stream rule was missing the line that says what enforces it"*
   — never *"D-0174 lacks `enforced-by`"*. A link is fine as something to click; it is not
   the name of the thing, so never *"see #646"* in place of saying what #646 changes. This
   is the plain-language rule (D-0054), already database-enforced on the dashboard cards Ron
   reads, applied to every reply in every repo — which is where it was always meant to be.
   It **composes with rules 1-3 and replaces none of them**: a short reply full of codes
   still fails.

5. **Don't repeat what his phone has already told him.** Ron, 2026-10-23: *"I'm getting
   discord priority messages so I don't need you to repeat those here."* The cards are an
   action inbox, not a copy of the reply — an ask, a decision or a finished thing that has
   already gone out as a card **has already reached him**. So name it in one clause and link
   it; do not restate its wording, its two choices, or its numbered steps in the reply. A
   reply that re-renders a card he is holding spends the attention the card was built to
   save, and makes him read the same thing twice to check whether it is the same thing.
   **The exception is when he asks about it** — then answer the question. Answering is not
   repeating.

6. **Do the work without narrating it; say what happened when it is done.** A turn is
   **silent between its tool calls**. Ron, 2026-10-17, on a turn rendered as eight lines of
   running commentary — *"Let me see how the dashboard does sections…"*, *"Now the tabs. Let
   me wire the URL, the shell, and the two tab bodies."*, *"Two unbalanced brackets from
   that edit — let me close them properly."* — offered a cap on the total or silence, chose
   silence. Each line was short; the stack of them was a wall, and none of it was anything
   he could act on.

   **Three exceptions, and only three.**
   - **A genuine question** that must be answered before the work can continue. Ask it and
     stop; do not ask it and keep going.
   - **A warning that cannot wait** — the next step is destructive, or you have found
     something he needs before the work finishes.
   - **One brief note before a single long-running step.** A ten-minute silent gap with no
     sign of life is its own problem, so this one survives: *one* line, before *one* long
     step. One note is a sign of life; a third of one is a commentary.

   Everything else — what you are about to read, which pattern you found, that a bracket was
   unbalanced, what you plan to do next — waits for the summary, or goes in `STATUS.md`, the
   PR body or the record where it is retrievable. **And write to him in the second person:**
   *"you asked for tabs inside Rally"*, never *"Ron wants tabs inside Rally"*. He is the one
   reading it; talking about him in the third person while talking to him is the same
   writing fault one level up.

**This is about the REPLY, not the work.** Two halves, and both matter:

- **Detail still gets written down** — `STATUS.md`, the PR body, the decision record, a
  component's `DESIGN.md`. Nothing here reduces verification, testing or record-keeping:
  shortening the reply while skipping the check is the one failure mode this rule must not
  cause. Write the long version where it is retrievable; hand Ron the summary and the link.
- **Those places SHOULD carry the identifiers.** Commit messages, PR bodies, decision
  records, `STATUS.md` entries, issue titles and code comments name ids, paths, repos and
  components — that traceability is the whole point of them, and rule 4 does not touch it.
  The ban is on the chat surface Ron reads, nowhere else.

**Why.** Ron's time is the constraint. But rule 4 exists because of a sharper cost, in his
words, 2026-10-14 — reading a reply that listed three open items as "D-0174", "D-0178" and
"ship 3":

> *"you're understanding of my capicity is incorrect -- I am smart but I have no idea what
> D-0174 is"*

That is the second time this exact rule has had to be learned: it was already written and
database-enforced for the cards on the dashboard, and the reply surface simply never
inherited it. An id is a pointer into a filing system Ron does not read. Handing him one
makes him ask what it is, which is the round trip the whole convention exists to remove.

**Forbids.** A step-by-step narration of what you did as the body of a reply. A reply that
restates the request before answering it. Several questions stacked for Ron to sort out. A
question or an action buried mid-paragraph. Padding a short answer to look thorough —
"this was already done" is a complete reply. Any identifier used as a noun in a reply:
an id, a path, a repo, a component, a phase number, a bare issue number. And restating a
card he has already been sent — its text, its choices or its steps — when a clause and a
link would do.
<!-- wmpc-block:response-style:v5 END -->
