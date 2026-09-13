# STATUS — CourtReserve Scheduler

> Append-only session front door. Newest entry on top. New entries supersede old;
> never rewrite history. Deeper detail lives in [`docs/TS-REWRITE-PLAN.md`](docs/TS-REWRITE-PLAN.md)
> and the GitHub issues/PRs linked below.

---
## 2026-09-13 (later) — Women's AI Thursday 16:00–18:00 is a scheduler RULE; Thursday re-timed; Pass 0 never drops a fixed event silently

**Supersedes the entry below.** Ron clarified: this is **not** a Court Reserve series and
must not be entered as one — the daily job (14 days out) books it as an occurrence of
CR event `1717124` every Thursday, and the other Thursday requirements shuffle to make
room. Nothing to do by hand in CR. Wednesday **9/16** still stays as already booked.

**State:** branch `claude/womens-schedule-wed-to-thu-n0wdsf`. TS typecheck clean,
**97/97 tests pass** (was 94), goldens re-baselined via `regen_goldens.py` and
`--check` exits 0. **⚠️ NOT DEPLOYED** — `git pull && ./setup.sh` on `wmpcMacMini1`.

### ✅ Done
- **Thursday `fixed_events` re-timed** so the 2-court women's block always fits under
  hard constraint 6 (max 3 concurrent courts):

  | Thursday | Before | After |
  |---|---|---|
  | Women's Advanced Intermediate (2 courts, `1717124`) | — (was Wed 15–17) | **16:00–18:00**, listed first so Pass 0 seats it first |
  | Co-Ed 3.25-3.5 Level Play | 17:00–19:00 | 17:00–19:00 (unchanged; the one other court in 16–18) |
  | Mens Advanced Plus | 17:00–19:00 | **18:00–20:00** |
  | Co-Ed Advanced Intermediate | 16:00–18:00 | **18:00–20:00** |

  Concurrency: 16–17 = 2 courts, 17–18 = 3, 18–19 = 3, 19–20 = 2. Dry run of the real
  policy for Thu 10/1: women's on courts 4+3, nothing skipped.
- **Pass 0 hardened in both engines** (`ts/src/recommender.ts`, `recommender.py`):
  - A 2-court fixed event with no free court **pair** now falls back to the best single
    court (`max_participants` scaled: 10 on 2 courts → 5 on 1) instead of vanishing —
    what `recommendation_rules.two_court_pair_note` always said should happen.
  - A fixed event with **no** court at all is recorded in `stats.skipped_fixed_events`
    with `reason: no_court`. Constraints 3/3b are now checked *before* court
    assignment, so an event already on the live schedule reads as `min_gap` /
    `max_occurrences`, and `no_court` means a genuine court shortage.
  - Goldens `2026-07-09` and `2026-07-13` gained skip entries that were silent before
    (the fixture schedule already carries those fixed events). Recommendations unchanged.
- 3 new tests in `ts/tests/fixed-events.test.ts` (single-court fallback, full pair kept
  when free, `no_court` reported).

### ⚠️ Open
- `skipped_fixed_events` is only in the stats JSON / booking log — nothing posts it to
  Discord yet. Worth surfacing so a dropped women's slot is seen the same morning.
- The Mens-Advanced-Plus vs Co-Ed-3.25 choice (which stays at 17:00) was an engineering
  call: Intermediate at 17:00 had recorded demand. Swap them in `policy.json` if wrong.
- `1717124` remains unverified against the events list widened to 1/15/2025.

### 🔜 Next
- Deploy: `git pull && ./setup.sh` on `wmpcMacMini1`. First Thursday the job books
  under the new rule is **10/1** (9/17 and 9/24 were booked under the old policy).

---
## 2026-09-13 — Women's Advanced Intermediate moved Wednesday → Thursday 16:00–18:00

**State:** `policy.json` only, on branch `claude/womens-schedule-wed-to-thu-n0wdsf`.
TS typecheck clean, **94/94 tests pass**, `regen_goldens.py --check` exits 0 (the test
fixture policy is untouched, so the goldens do not move).

**⚠️ NOT DEPLOYED** — needs `git pull && ./setup.sh` on `wmpcMacMini1`. **⚠️ CR series
NOT moved** — see below.

### ✅ Done
- **`fixed_events` entry moved** from Wednesday 15:00–17:00 to **Thursday 16:00–18:00**
  per club management (2026-09-13). `event_id: 1717124`, 2 courts, max 10 unchanged.
  The entry had been recorded as 15:00–17:00; management's instruction is 4–6, so the
  Thursday slot is 16:00–18:00. If the Wednesday series was in fact 15:00–17:00 in CR,
  the old policy time was right and only the new one matters.
- **Wednesday 2026-09-16 is intentionally untouched.** The daily job books 14 days out,
  so from tomorrow it targets 9/28 onward and never re-visits 9/16 or 9/17; the policy
  change only affects runs from the week of 9/28. An ad-hoc `!schedule 9/16` would now
  treat Wednesday as free at 15:00 — don't run one for that date.
- Dry-ran `ts/src/recommender.ts` on the real policy for Thu 10/1: Pass 0 places the
  women's series on courts 1+2, Co-Ed AI on 4, Mens Advanced Plus on 3.

### ⚠️ Open risks
- **Thursday 17:00–18:00 is over-subscribed by one court.** Women's (2) + Co-Ed
  Advanced Intermediate (1) + Mens Advanced Plus (1) + Co-Ed 3.25-3.5 Level Play (1) =
  5 courts on a 4-court club. In the dry run **Co-Ed 3.25-3.5 Level Play was silently
  dropped** — Pass 0 `continue`s when no court is free and does not record it in
  `skipped_fixed_events`. Management needs to decide which Thursday 17:00 event yields
  (or shrink the women's to 1 court). Worth a follow-up to report a `no_court` skip.
- **The CR recurring series `1717124` must be moved by hand in Court Reserve** — the
  code has no edit-series path (`!move` edits one occurrence). Edit the series from the
  **9/23** occurrence onward; leave **9/16** as is.
- `1717124` remains unverified against the events list widened to 1/15/2025.

### 🔜 Next
- Ron: move series `1717124` in CR (from 9/23), then decide the Thursday 17:00 court
  conflict, then `git pull && ./setup.sh` on `wmpcMacMini1`.
- Follow-up: make Pass 0 report a fixed event dropped for lack of a free court instead of
  skipping it silently.

---
## 2026-09-06 — Pass 0 min-gap gap FIXED in both engines

**State:** **MERGED to `main`** as `9514021` via
[#45](https://github.com/notronwest/CourtReserve-Scheduler/pull/45); branch deleted.
TS typecheck clean, **94/94 tests pass** (was 91). Python and the regenerated goldens
agree (`regen_goldens.py --check` exits 0).

**⚠️ NOT DEPLOYED** — needs `git pull && ./setup.sh` on `wmpcMacMini1`.

### ✅ Done
- **Pass 0 now enforces hard constraint 3b.** It gated only on
  `_max_occ_for(eid)` / `maxOccFor(eid)` and never called `event_gap_ok` /
  `eventGapOk`, so two fixed events resolving to the same event id at one hour — or
  one whose id was already on the live schedule then — booked a **zero-gap duplicate**.
  Fixed identically in `recommender.py` and `ts/src/recommender.ts`.
- **Skips are surfaced, not silent.** A declined fixed event is reported in
  `stats.skipped_fixed_events` with `reason: min_gap | max_occurrences`. Fixed events
  are policy-mandated, so dropping one quietly would be its own bug.
- **The bug was in the parity goldens.** `golden_2026-07-11` had Python booking a
  *second* `1633147` at 10:00–12:00 on Court #3 while the live schedule already had
  that event at 10:00–12:00 on Court #4 — proof it fired on real-shaped data, not just
  in theory. Regenerated; that duplicate is gone and the skip is recorded.
- **New `scripts/regen_goldens.py`.** The goldens are the reference TS is held to and
  had no generator checked in. Now re-baselining is a command, not hand-edited JSON;
  `--check` fails if they drift.
- **3 regression tests** covering the duplicate, the already-on-schedule case, and that
  a distinct `event_id` correctly lets both run.

### 🔜 Next
- **Thursday 17:00–19:00 Intermediate — the unblock is now proven.** A test shows two
  entries at one hour DO both book once the branded one has its own `event_id`. Supply
  the real CR id for **"Co-Ed 3.25-3.5 Level Play"** and the requested slot goes in.
- **Deploy:** `git pull && ./setup.sh` on `wmpcMacMini1` — merging alone ships nothing.
- Still open: verify `1240908` / `1717124` via the events list widened to 1/15/2025;
  Friday women's series still needs its 09:00 → 10:00 move by hand in CR.

## 2026-09-06 — Git & gh hygiene block recovered; Pass 0 caveats corrected

**State:** hygiene block **MERGED** as `9da03eb`
([#43](https://github.com/notronwest/CourtReserve-Scheduler/pull/43)). Branch cleanup
done. Correcting two `policy.json` caveats that the TS cutover made wrong.

### ✅ Done
- **Recovered stranded docs.** `chore/git-hygiene` was the only surviving copy of a
  21-line **Git & gh hygiene** block for `CLAUDE.md` — its remote had been deleted
  without merging and the content was not on `main`. Rebased onto current `main`
  (the commit predated the whole TS rewrite), resolved the `CLAUDE.md` conflict by
  keeping **both** main's `wmpc-block:*` sections and the new block, and merged.
- **Branch cleanup.** Deleted `docs/status-front-door`, `docs/deployment-md` (local +
  remote), `fix/discord-embed-1024-overflow`, `infra/bootstrap-shim` — all fully on
  `main` (the shim's only change was byte-identical). Pruned a dead worktree.
  Remaining: `origin/docs/status-book-guard-deployed` (someone else's, left alone).
- **Corrected `fixed_events.python_pass0_caveat`.** Written 2026-09-01 claiming the
  co-ed-clone defect was *production-affecting*. It no longer is: the TS cutover is
  live and `ts/src/recommender.ts` honours the fixed-event `event_id`, so the women's
  entries book as themselves. Rewritten as **latent / rollback-only** — `recommender.py`
  still ignores `event_id`, so the clones return if anyone runs `ts/ops/rollback.sh`.
- **Corrected `fixed_events.pass0_min_gap_caveat`.** It described `recommender.py`;
  verified `ts/src/recommender.ts:489` has the same hole (Pass 0 checks only
  `maxOccFor`, never `eventGapOk`; Pass 1/2 do check). Rescoped to **both engines**.

### 🔜 Next
- **Thursday 17:00–19:00 Intermediate is still held** — needs the real CR `event_id`
  for "Co-Ed 3.25-3.5 Level Play"; without it a second entry resolves to `1931656` and
  double-books with zero gap.
- **Verify `1240908` / `1717124`** against the events list widened to **1/15/2025** (a
  single-day fetch won't show a dormant series). Still unverified.
- Friday women's **recurring series** still needs its 09:00 → 10:00 move by hand in CR.
- Optional: port `event_id` to `recommender.py`, or retire the Python engine so the
  rollback path can't reintroduce the clones.

## 2026-09-05 — `!book` guard DEPLOYED; PRs must close a board issue

**State:** **LIVE on `wmpcMacMini1`** at `ae03181`. Supersedes the "Not yet on the
host" caveat in the entry below — the guard is running.

### ✅ Done
- **[#36](https://github.com/notronwest/CourtReserve-Scheduler/pull/36) (`ae03181`)
  and [#38](https://github.com/notronwest/CourtReserve-Scheduler/pull/38) (`0c9c45e`)
  merged**, closing [#39](https://github.com/notronwest/CourtReserve-Scheduler/issues/39)
  and [#40](https://github.com/notronwest/CourtReserve-Scheduler/issues/40).
- **Deployed by `git pull` + listener restart — no `./setup.sh`.** #36 is TS source
  only and changes no plist, so the always-on listener was the only thing needing a
  bounce (the cron-style jobs spawn fresh and pick up new code on their own).
  Listener came up clean, empty error log, and **`npm test` passes 91/91 on the host.**
- **The daily job has now auto-booked three consecutive days unattended:**
  9/17 (7/7), 9/18 (9/9), 9/19 (6/6) — zero failures, no human in the loop.

### 📌 Convention learned the hard way
**Every PR must CLOSE a board issue** — a CI check greps the body for a closing
keyword (`Closes #n` / `Fixes` / `Resolves`) and fails the PR without one. `Part of
#n` does not count. #35, #36 and #38 were all opened without one and had to be
retro-fitted with tracking issues; **#35 was merged red.** Open the issue *first*,
then the PR. Prerequisite work gets its own small tracking issue.

### 🔜 Next — one cleanup PR for three Python-era ops warts
All three are ops scripts still probing the dead Python path. None affects booking:
1. **`setup.sh` step 8** hits a `read -p` with no TTY, so `set -euo pipefail` aborts
   the run (exit 1) *after* the plists install, skipping the step 9 smoke test. It
   asks for a browser login the TS jobs don't use — CR goes through `courtreserve-api`.
   Should skip when there's no TTY.
2. **`check.sh`** fails on "Playwright Chromium missing" (rollback path only), reads
   the stale Python `logs/listener.log` instead of `launchd_listener.log`, and its
   "Latest booking log" line prints garbled output and `-1`.
3. **`make restart`** ends in `tail -f logs/listener.log` — the Python log. It hangs
   by design and shows a file the live TS listener never writes to.

Also still open: [#37](https://github.com/notronwest/CourtReserve-Scheduler/issues/37)
— `!move` can still retime an event on top of another (board: Backlog, Soon, bug).

---
## 2026-09-05 — `!book` overlap guard merged

**State:** **MERGED** via [#36](https://github.com/notronwest/CourtReserve-Scheduler/pull/36)
(closes [#39](https://github.com/notronwest/CourtReserve-Scheduler/issues/39)). Found
while diagnosing the scheduler regression two entries below. Supersedes the "`!book`
still unguarded in production" caveat in the entry below — that gap is now closed.
**Not yet on the host:** the listener needs a `git pull` + restart to pick it up.

### What broke
`!book Advanced Intermediate tomorrow @ 6PM` (no court named) booked **Court #1 on
9/3 6–8 PM**, on top of *Mens Advanced Plus Open Play* already there 5–7 PM.

`parseBookCommand` is a **pure text parser** — it sees `policy.json` and nothing
else, never the live schedule. With no court named, Haiku had no basis to choose
and returned the first court in the list. The only validation was "is this court
id in policy.json"; there was no overlap check anywhere on the path, at preview
or at confirm. Hard constraint #1 was enforced on the recommender path
(`recommender.ts` `existingFree`) and simply absent here.

### ✅ Done
- **New `ts/src/availability.ts`** — `occupiedSlots` / `conflictsFor` /
  `freeCourts`, extracted from the recommender's private parse block so both
  paths answer "is this court free?" the same way. `recommender.ts` now imports
  it; the parity suite still passes unchanged.
- **The parser no longer invents a court.** No court named → `court_num`/`court_id`
  come back `null`, and the booker fills them in.
- **`resolveCourt` in the listener** picks a free court (recommender's preference
  order) when none was named, and rejects a named court that overlaps — naming
  the conflicting event and suggesting the courts that *are* free.
- **Re-checked at confirm**, not just at preview: a preview can be minutes stale.
- **Fails closed.** If the schedule can't be fetched, the booking is refused —
  booking blind is exactly how this happened.
- 12 new tests (91 total, was 79), built on the real 9/3 schedule.

### ⚠️ Same bug still live in `!move`
`executeMove` changes an occurrence's time with **no check that the new slot is
free on that court** — it can move an event on top of another. Not fixed here:
the conflict set has to exclude the occurrence being moved, and the court-change
half of `!move` is already a known no-op pending Phase 5. Filed separately.
## 2026-09-03 — TS cutover DEPLOYED; daily auto-book confirmed working

**State:** **LIVE on `wmpcMacMini1`.** [#35](https://github.com/notronwest/CourtReserve-Scheduler/pull/35)
merged as `03a600d`, pulled on the host, and `./setup.sh` run there. Supersedes the
"NOT DEPLOYED" caveat in the entries below.

### ✅ Done
- **`./setup.sh` now installs the TS plists.** The exact command that caused the
  regression — `git pull && ./setup.sh` — installed all five agents from `ts/ops/`
  and left the listener on node/tsx (empty error log). The regression is closed at
  the source, not just patched by hand.
- **The daily job is auto-booking unattended again.** The 8:00 AM run on 2026-09-03
  booked **9/17: 7/7, 0 failed** with no human in the loop — the first fully
  automatic run since the 09-01 revert.
- **9/3 verified clean:** 12 court-blocks, **0 same-court overlaps**. Ron removed the
  bad 6–8 PM Court #1 booking by hand in CR.

### ⚠️ Known, deliberately not fixed here
- **`setup.sh` exits 1 non-interactively.** Step 8 (Court Reserve browser login)
  hits a `read -p` prompt; with no TTY and `set -euo pipefail` the script aborts —
  *after* step 7, so the plists do install, but step 9's smoke test is skipped.
  The login it wants belongs to the Python rollback path; the five live jobs reach
  CR through `courtreserve-api`. Step 8 should skip when there's no TTY.
- **`./check.sh` reports 1 failure / 5 warnings, none affecting the live system.**
  The failure is "Playwright Chromium missing" (rollback path only). It also reads
  the stale Python `logs/listener.log` instead of `launchd_listener.log`, and its
  "Latest booking log" line prints garbled output and `-1`.
- **`!book` still unguarded in production** until
  [#36](https://github.com/notronwest/CourtReserve-Scheduler/pull/36) lands. A
  no-court `!book` at 23:50 on 09-02 landed on a free Court #1 by luck, not by check.

### 🔜 Next
1. Rebase **#36** — it now conflicts with `main` on `STATUS.md` (both prepend a dated
   entry; keep both), then merge and re-run `./setup.sh` on the host.
2. Follow-up PR for the `setup.sh` step-8 TTY guard and the `check.sh` staleness above.
3. [#37](https://github.com/notronwest/CourtReserve-Scheduler/issues/37) — `!move`
   can still retime an event on top of another (board: Backlog, Soon, bug).

---
## 2026-09-03 — `setup.sh` was silently reverting the TS cutover

**State:** PR open against `main`. **Already fixed on the host by hand** —
`ts/ops/cutover.sh` re-run, TS listener live, 9/16 auto-booked 7/7.

### What broke
On 2026-09-01 at 23:25 a routine `git pull && ./setup.sh` on `wmpcMacMini1`
overwrote all four TS launchd plists with the Python ones from `ops/`. The labels
are identical (`com.whitemountain.*`), so `launchctl list` looked correct and
nothing surfaced an error. The next morning the 8:00 AM job was
`scripts/run_scheduler.sh` → `run.py --llm --book`, which **posts recommendations
for Discord approval instead of auto-booking**. Ron noticed only because the
approval embed appeared.

Evidence: the installed plists were byte-identical to the July 9 backups in
`~/Library/LaunchAgents/.python-plist-backup/`; `launchd_scheduler.log` shows
clean TS auto-book runs on 8/30, 8/31, 9/1 and nothing on 9/2, while
`scheduler_2026-09-02.log` (Python-only) shows "Pending approval saved". The TS-only
`checkin` plist survived — `setup.sh` didn't know about it.

### ✅ Done
- **`install_plist()` now reads `ts/ops/`**, not `ops/`, and installs the fifth
  agent (`com.whitemountain.checkin`). The `sed` prefix rewrite handles both the
  old and current repo-path spellings.
- **New setup step 4** installs the `ts/` node dependencies and warns when
  `ts/.env` is missing — without those the agents fail at load with a bare
  "cannot find module" in the launchd error log.
- **`check.sh` checks all five services** (was three — it never covered
  `check-waitlists` or `checkin`).
- **`DEPLOYMENT.md` rewritten to describe the TS deployment** it actually is:
  node/tsx sources, five agents, `ts/.env` as the config scope, CR reached through
  `courtreserve-api`, and rollback via `ts/ops/rollback.sh`.

### Trade-off
`./setup.sh` now *undoes* a deliberate `ts/ops/rollback.sh`, the mirror of the old
bug. That's the right default — TS is the live path — but a rollback holds only
until the next setup run. Documented in `DEPLOYMENT.md` under "Roll back".

### 🔜 Next
- Separate PR: `!book` has no same-court overlap check (see the entry below this
  one once filed) — `parseBookCommand` never sees the live schedule.

---
## 2026-09-01 — Permanent Intermediate slots + women's events made addressable

**State:** **MERGED to `main`** as `5341aa2` via PR
[#34](https://github.com/notronwest/CourtReserve-Scheduler/pull/34); branch deleted.
Main had moved 8 commits meanwhile — landing the `event_id` override
([#30](https://github.com/notronwest/CourtReserve-Scheduler/pull/30)), `DEPLOYMENT.md`
([#33](https://github.com/notronwest/CourtReserve-Scheduler/pull/33)), and the TS
launchd/cutover work — and conflicted on all three files this session touched.
Resolved by taking main's restructured `policy.json` / `CLAUDE.md` / `STATUS.md` and
re-applying this session's changes on top.

**⚠️ NOT DEPLOYED.** Per `DEPLOYMENT.md`, pushing to `main` deploys nothing — a human
runs `./setup.sh` on the club Mac. None of this is live yet.

### ✅ Done
- **New permanent Intermediate fixed events:** Monday **16:00–18:00**, Tuesday
  **11:00–13:00**.
- **Friday Women's Intermediate moved 09:00–11:00 → 10:00–12:00**, and pinned with
  `event_id: 1240908`.
- **Wednesday Women's Advanced Intermediate pinned** with `event_id: 1717124`.
  Both use the optional `event_id` field main added in
  [#30](https://github.com/notronwest/CourtReserve-Scheduler/pull/30).
- **Both women's series added to `approved_events`** so `!book`/`!move` can address
  them. `llm_parser` builds its entire event vocabulary from that block
  (`llm_parser.py:43`), so `!book womens intermediate` previously hit the prompt's
  "closest match" rule and silently resolved to co-ed `1931656`.
- **Guarded the level collision this creates.** Both women's entries share a `level`
  with a co-ed event, and `{level -> event_id}` maps built by iteration are last-wins.
  `fix_imbalance.py` `_BY_LEVEL` and `ts/src/jobs/fixImbalance.ts` `buildCtx` now skip
  `womens:true`. Verified with both entries present: Intermediate → `1931656`,
  Advanced Intermediate → `1672774`.
- **Documented Court Reserve event archiving** in `CLAUDE.md`: an event with no future
  instances is archived and vanishes from the events list; only visible by widening the
  range to **1/15/2025**. That is how a dormant series' `event_id` is recovered.

### ⚠️ Open risks
- **`event_id` is a TS-only fix.** `recommender.py` never reads it. Per `DEPLOYMENT.md`
  the live launchd agents still run the **Python** stack, so in production Pass 0 still
  books a **co-ed clone** of every distinct series at the same hour on a free court —
  verified: with the real Women's series live on Court #4, Pass 0 still books Co-ed
  Intermediate on Court #1. Recorded as `fixed_events.python_pass0_caveat`.
  **Port `event_id` to `recommender.py`, or finish the TS cutover.**
- **Both event ids are UNVERIFIED** (`1240908`, `1717124`) — read off the Events/Edit
  URL, not confirmed against Court Reserve. The `!book` preview renders the name from
  policy, so it will not catch a wrong id. Verify via the events list widened to
  1/15/2025 — a single-day schedule fetch won't show a dormant series.
- **Pushing to main deploys nothing.** A human runs `./setup.sh` on the club Mac.

### 🔜 Next
- Port the `event_id` override to `recommender.py` (or complete the cutover), then
  `./setup.sh` on the host.
- **Thursday 17:00–19:00 Intermediate is still held**: "Co-Ed 3.25-3.5 Level Play" has
  no `event_id` of its own and resolves to `1931656`, so adding a second entry produced
  two identical occurrences on courts 2 and 3 (Pass 0 never calls `event_gap_ok()` —
  `fixed_events.pass0_min_gap_caveat`). Supply that event's real id to unblock it.
- Friday women's **recurring series** still needs its 09:00 → 10:00 move by hand in
  Court Reserve; `!move` shifts single occurrences only.
- No backfill booked. A full `run.py --book` re-run on already-booked days adds ~4
  duplicate events per day rather than skipping them; four surgical `!book`s
  (Mon 9/7, Tue 9/8, Mon 9/14, Tue 9/15) are the route.

## 2026-07-08 — TS rewrite through Phase 5 (all jobs ported)

**State:** The Python → TypeScript rewrite (`ts/`) is **functionally complete through
Phase 5**. The scheduler brain, Discord listener, daily scheduler CLI, and all 5 jobs
are ported to TS and route Court Reserve access through the `courtreserve-api` HTTP
service (no Playwright in this repo). **The live Python is still the system of record —
nothing has been cut over yet.** Only **Phase 6** (launchd → node, shadow-run, delete
Python) remains. Plan: [`docs/TS-REWRITE-PLAN.md`](docs/TS-REWRITE-PLAN.md).

### ✅ Done (merged to `main`)
- Phases 0–3: scaffold, CR HTTP client, recommender/policy/history (parity-tested), LLM
  ranker + `!book`/`!move` parser.
- **Phase 4** — Discord listener (`ts/src/discord/`). Live-verified in test channel
  `1511935694107312179`: `!help`, `!book`→preview, `!move`→preview, `cancel`, approval
  routing. REST polling (no privileged `MESSAGE_CONTENT` intent); no browser lock.
- **Phase 5** — scheduler CLI + all jobs (`ts/src/scheduler.ts`, `ts/src/jobs/`):
  `runScheduler` (recommendLlm→post→pending), `fetchHistory`, `fixImbalance`,
  `checkWaitlists`, `checkinPast`. `!schedule` spawns the TS CLI now.
- **courtreserve-api** endpoints added + merged: `GET /waitlists`, `GET /checkin/scan`,
  `POST /checkin`. Service runs as launchd `com.wmpc.courtreserve-api` on `:8787`.
- All TS: **75/75 tests, typecheck clean.** Each piece verified live against the running
  service, EXCEPT the two deliberate mutations (below).

### ⏳ In flight
- (nothing mid-merge — all session PRs are merged)

### 🔜 Next
- **Phase 6 — cutover (the only remaining phase).** Point `ops/*.plist` at `node`,
  shadow-run TS `--dry-run` beside the live Python for a week and diff daily recs
  (`npm run recommend <date> --llm` is the diff tool), then cut launchd over job-by-job
  and **delete the Python** + venv + requirements.txt.
- **Court-aware `/move`** — the last endpoint gap ([#21](https://github.com/notronwest/CourtReserve-Scheduler/issues/21),
  open). TS `!move` changes time only; a requested court change is surfaced, not applied.
- **Manual mutation tests** (never auto-run — they hit real Court Reserve):
  - `!book … confirm` in the test channel → a real booking (use a throwaway slot).
  - `cd ts && npm run checkin-past -- --event <id> --execute` → first live check-in.
- **Housekeeping:** close superseded PR
  [#12](https://github.com/notronwest/CourtReserve-Scheduler/pull/12) (import-based extraction,
  superseded by the rewrite) and stale docs PR
  [#1](https://github.com/notronwest/CourtReserve-Scheduler/pull/1).

### 🖥️ Picking up on another machine
1. `cd ts && npm install`. Copy `ts/.env.template` → `ts/.env` and fill in: `CRAPI_URL`
   (+`CRAPI_KEY` from the `courtreserve-api` service `.env`), `ANTHROPIC_API_KEY`, and the
   Discord bot token + a **webhook bound to the channel you poll** (they must match —
   `DISCORD_CHANNEL_ID` == the webhook's channel).
2. `npm test` (mocked — no services needed). `npm run health` checks the CR service.
3. Read-only smoke: `npm run recommend <date> --llm`, `npm run checkin-past -- --dry-run`,
   `npm run check-waitlists -- --dry-run`.
4. The `courtreserve-api` service must be running (launchd `com.wmpc.courtreserve-api`,
   `:8787`) for anything hitting Court Reserve. Restart it with
   `launchctl kickstart -k gui/$(id -u)/com.wmpc.courtreserve-api`.
