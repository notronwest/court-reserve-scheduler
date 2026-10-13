# STATUS — CourtReserve Scheduler

> Append-only session front door. Newest entry on top. New entries supersede old;
> never rewrite history. Deeper detail lives in [`docs/TS-REWRITE-PLAN.md`](docs/TS-REWRITE-PLAN.md)
> and the GitHub issues/PRs linked below.

---
## 2026-10-12 — Reviewer: PR #73 (issue #72) → APPROVE

**Done:** Reviewed [PR #73](https://github.com/notronwest/court-reserve-scheduler/pull/73)
(`Closes #72` — adds `ppa_calendar.py`, fetching PPA Championship Sundays from the tour's
own events page instead of carrying a hardcoded list) per `agents/reviewer/PROMPT.md`.
Confirmed in a scratch clone: the 13-test suite passes, and ran the live fetch
(`python ppa_calendar.py --refresh`) against `ppatour.com/events/` directly — it correctly
derived 19 Sundays through May 2027, matching an independent read of the same page. The
live→cache→seed fail-safe chain and the thin-parse/archive-page plausibility floor both
work as described, not just in test doubles. Noted one non-blocking gap: the Dec→Jan
year-wrap parsing (`ppa_calendar.py:60-76`) is untested against real data — no cross-year
range exists on the live page today — and a note that the new capability lives in the
repo-root Python tree (not `ts/`) but is read-only with a CLI entry point, which satisfies
this repo's CoS-surface requirement; wiring it into the command-bar/cadence feature that
originally needed it is reasonably follow-on work in a different repo. Posted
`VERDICT: APPROVE`, added label `reviewed:approve`.

**Next:** Per D-0052 the dispatcher merges on this APPROVE and moves the card to Done —
no Ron click needed.

---
## 2026-10-11 — RECOVERED: 7 entries that were written but never committed

Written into this checkout's `STATUS.md` between 2026-10-02 and
2026-10-08 and never committed. The hourly sync job healed its dirty tree with a
`git stash push` that nothing ever surfaced, so they sat on no branch while every
later session read a `STATUS.md` without them. Recovered verbatim from that
machine's stashes and uncommitted working tree, and appended here under one banner —
they were never part of this log's history, so they are not interleaved into it as
though they had been.

Cause and fix: daemon `infrastructure/sync-heal/DESIGN.md` (D-0118 rule 5 applied
fleet-wide). Detector: `audit-stashes.sh`. Fleet total: 102 entries, 9 repos.

---

## 2026-10-12 — Reviewer: PR #71 (issue #70) → APPROVE

**Done:** Reviewed [PR #71](https://github.com/notronwest/court-reserve-scheduler/pull/71)
(`Closes #70` — syncs `.github/workflows/pr-linked-issue.yml` from the stale
pre-2026-10-08 copy to the canonical `wmpc-meta` template) per `agents/reviewer/PROMPT.md`.
Confirmed the new file is byte-identical (same git blob `ab656a8`) to
`templates/pr-linked-issue.yml` as proposed in the still-open `wmpc-meta#44`, and that
the pre-PR file (`b1ce1a6`) genuinely lacked both fixes #70 names: the `main`→`production`
promotion exemption, and the live-API body read (vs. the stale event payload that made
the gate unclearable after a dropped `edited` event). The PR's own `check` run is green,
proving the live-read path on this exact PR. No UI, no new component (D-0049 n/a).
`mergeable_state: clean`, not a draft, base is `main`. Posted `VERDICT: APPROVE`,
added label `reviewed:approve`; noted as a non-blocking caveat that `claude-bootstrap.sh`
re-syncing from wmpc-meta's still-pre-#44 `main` could revert this file later if
`wmpc-meta#44` doesn't land first.

**Next:** Per D-0052 the dispatcher merges on this APPROVE and moves the card to Done
— no Ron click needed. `wmpc-meta#44` (the same fix, upstream) is still open; merging
it is what keeps a future bootstrap run from reverting this repo's copy.

---
## 2026-10-08 (later) — Reviewer: PR #68 (issue #62, D-0056) → APPROVE

**Done:** Reviewed [PR #68](https://github.com/notronwest/court-reserve-scheduler/pull/68)
(`Closes #62` — the standing pattern off courtreserve-api, the `items`-vs-`events`
read-bug fix, the `until` retirement cutoff on every source, `preferred_courts`
going live, `no_court` skips now logged/persisted) per `agents/reviewer/PROMPT.md`/
`ROLE.md`. Hit the same GraphQL rate-limit flakiness the prior Reviewer session on
PR #66 noted (`gh pr view`/`gh pr diff`/`gh pr comment` all 429'd; REST via `gh api`
worked throughout, including posting the verdict and the label — note `-F key=@file`,
not `-f`, to read a comment body from a file, or it posts the literal `@path` string).
Verified rather than trusted: checked out the PR branch into an isolated `git worktree`,
symlinked `ts/node_modules`, ran the full suite myself (**159/159 pass**, `tsc --noEmit`
clean); confirmed the one call site of the now-extended `saveBookingLog` was updated;
read `recommender.ts`'s pre-existing `preferred_courts`/`no_court` logic directly to
confirm the PR's description of it (untouched in this diff) is accurate. Chased down
what looked like 2 real pre-existing failures on `main` (`catchUp.test.ts` timeouts)
that would have contradicted the PR's "main was green 142/142" claim — root cause was
a stray local `.env` in my own checkout making `dotenv/config` pull in real config
during that job's tests, not a `main` defect; confirmed `main` is green once isolated.
No UI in this diff, so design-system/phone-gate checks don't apply; no new Ron-facing
steps (D-0068 n/a — deploy is the already-documented `./setup.sh` on the mini).
`mergeable_state: clean`, not a draft. Posted `VERDICT: APPROVE` with cited findings,
added label `reviewed:approve`.

**Next:** Per D-0052 the dispatcher merges on this APPROVE and moves the card to Done
— no Ron click needed. Per the PR body, two things still block the chain end to end,
neither in this repo: **(1)** redeploy `courtreserve-api` on the host so `GET
/fixed-events` actually exists (today it 404s and the scheduler books from the
`policy.json` seed — safe, loud, but the dashboard's court pins stay cosmetic until
then), and **(2)** the `preferred_courts int[]` column on `courtreserve.fixed_events`
(parallel contract work, not this repo).

---

## 2026-10-06 — Builder: read the standing fixed-events pattern from courtreserve-api (issue #62)

**Done:** Opened [PR #63](https://github.com/notronwest/court-reserve-scheduler/pull/63)
(`Closes #62`, branch `feature/issue-62-fixed-events-api`, built in an isolated
worktree — `main` untouched) for D-0056's consumer side. Adds
`CourtReserveClient.fixedEvents()` (`GET /fixed-events`) and a new
`ts/src/fixedEvents.ts` resolver: live read → cache to
`state/fixed-events.json` on success; on failure, falls back to that cache
(alerting Discord with the cache's date) or, with no cache, to `policy.json`'s
own `fixed_events.events` seed (alerting the same way) — never a silent stale
fallback. Wired into `runScheduler` (covers the 8 AM auto-book job,
`--recommend`/`--dry-run`, and catch-up, since all three call it) ahead of
every recommend/book pass. Added tests for the resolver, the client call, two
`runScheduler` integration cases (API down with/without a cache), and a
regression test against the *real* `policy.json` confirming the four
resurrected "Co-Ed Advanced Structured Play" slots (event 1135589) each book
on 2 courts without colliding with the generic Advanced Open Play — 128
tests green, `tsc --noEmit` clean. Docs updated: `DEPLOYMENT.md`, root
`CLAUDE.md` (State Files), `ts/.env.template` (new optional `CR_STATE_DIR`),
`.gitignore` (`state/`).

**Infra note (same recurring issue as below, now 5-for-5):** `gh project
field-list` / `gh project item-list` hit the account's GraphQL secondary rate
limit mid-session even though the primary quota showed ~4800/5000 remaining —
cleared on its own after a few minutes of unrelated work (no retry loop
needed). `git push`/`gh issue view`/`gh pr create` over REST were unaffected
throughout, so the branch, PR, and board moves all still completed in one
session once the window passed.

**Next:** `courtreserve-api` does not implement `GET /fixed-events` yet, so
every live run will hit the fallback path and post the "Fixed events read
failed" Discord alert daily until that endpoint ships on the
`courtreserve-api` side (flagged in the PR's reviewer notes). Ron's review +
merge is the remaining gate; board card is **In Review** (Type = feature).

---

## 2026-10-06 — Reviewer: PR #63 (issue #62) → APPROVE

**Done:** Reviewed [PR #63](https://github.com/notronwest/court-reserve-scheduler/pull/63)
(`Closes #62`, D-0056: read the standing fixed-events pattern from
`courtreserve-api GET /fixed-events` with a local cache, `policy.json` as
fallback seed) against the issue's three acceptance criteria, D-0056's
build spec in `DECISIONS.md`, and CLAUDE.md conventions — no UI touched,
so the design/phone gates didn't apply. Checked out the branch in an
isolated worktree (`.pr63-review`, removed after) and ran the full suite
independently rather than trusting the PR body: `tsc --noEmit` clean,
**128/128 tests pass** including the three new files
(`fixedEvents.test.ts`, the two new `scheduler.test.ts` cases, and
`structuredPlay.test.ts` against the real `policy.json`). Confirmed the
live→cache→seed fallback chain always alerts on any non-live path (never
a silent stale fallback, per D-0056 §3), `deps.policy` is never mutated,
`resolveFixedEvents` runs at the start of every `runScheduler` entry point
(8 AM auto-book, `--recommend`/`--dry-run`, catch-up), and the new
`fixedEvents.test.ts` doesn't duplicate the pre-existing
`fixed-events.test.ts` (that one tests the recommender's event-collision
logic from PR #30 — different code, D-0049 clean). Posted `VERDICT:
APPROVE` with cited findings and the `reviewed:approve` label per
`agents/reviewer/PROMPT.md`.

**Next:** Per D-0052 the dispatcher merges on this APPROVE and moves the
board card to Done — nothing further needed here. Once `courtreserve-api`
implements `GET /fixed-events` (out of scope for #62 — consumer side
only), every production run until then will hit the fallback path and
post a "Fixed events read failed" Discord alert daily; that's flagged in
the PR body as expected-but-possibly-noisy, worth watching once this
merges.

---

## 2026-10-02 — Builder: issue #50 (silent scheduler failures) → PR #59 opened

**Done:** Single-item Builder run on issue #50 ("Daily scheduler fails
silently: a dead /schedule fetch or failed bookings leave a hole in the
14-day horizon with no alert"). Confirmed #50 had no existing sub-issues/PRs
(not mis-queued), branched `feature/issue-50-silent-scheduler-failures` off
`origin/main` in an isolated worktree, and shipped all three asks in one PR:
(1) `runScheduler` now posts a red Discord alert + rethrows (non-zero exit)
on a dead schedule fetch, and alerts on zero recommendations in auto-book
mode; (2) `bookAll` retries `503 browser busy` / `aborted` booking errors up
to 3 attempts with backoff before counting a slot failed; (3) new `catch-up
[--book]` CLI (`ts/src/jobs/catchUp.ts`) walks today..today+14, flags
empty/short dates by reusing the existing rule-based `recommend()` engine,
and `--book` re-runs the normal recommend+book path only on flagged dates
(an already-full day is never touched). `npm run typecheck` + `npm test`
both green (117 tests, 8 new). PR
[#59](https://github.com/notronwest/court-reserve-scheduler/pull/59) opened
with `Closes #50` as the first body line — confirmed linked via the issue's
cross-reference timeline. Worktree removed after push; main checkout
untouched.

**Blocked (infra, not scope) — GraphQL rate limit, now 5-for-5:** Same
recurring failure as #51/#52/#53/#56 below: the account's GraphQL quota was
fleet-wide exhausted for the entire run (`gh project field-list`, `gh pr
create`, `gh issue comment` all refused with `API rate limit already
exceeded`, even while REST showed quota remaining — a secondary/fleet-shared
GraphQL limit, not the per-hour REST one). Every GitHub write in this
session — PR creation, the issue comment — was done via raw `gh api
repos/.../pulls` / `.../issues/.../comments` REST POSTs instead of the
GraphQL-backed `gh pr create` / `gh issue comment`. The one GraphQL-only
operation with no REST fallback, **moving the board card's Status to In
Review** (`gh project item-edit`, Projects v2 is GraphQL-only), could not be
done this run — left a comment on #50 flagging this explicitly so the card
doesn't silently sit in `In Progress`.

**Next:** Ron (or a later run once GraphQL quota resets) should move #50's
board card to **In Review** manually — the PR is open and ready for review.
The daemon ticket for the recurring GraphQL rate-limit block is now overdue
at 5-for-5 across #51/#52/#53/#56/#50 — worth escalating as its own fix
(e.g. a dedicated token, or a REST-first fallback baked into the Builder/
Reviewer prompts for every GraphQL-backed `gh` subcommand, not just the ones
already patched here).

---

## 2026-10-02 (even later) — Reviewer: PR #57 (issue #52) → APPROVE

**Done:** Reviewed [PR #57](https://github.com/notronwest/court-reserve-scheduler/pull/57)
(`Closes #52`, policy provenance recording + stale-checkout Discord warning)
against the issue's four acceptance criteria, `DECISIONS.md`, and CLAUDE.md —
no UI touched (Discord embed text only), so the design/phone gates didn't
apply. Checked out the PR branch into an isolated worktree (`/tmp/pr57-review`,
cleaned up after) and actually ran the suite rather than trusting the diff:
`tsc --noEmit` clean, full `vitest run` green at 109/109 across all 10 test
files including the two new ones (`policyProvenance.test.ts`,
`discord.test.ts` additions). Confirmed `scheduler.ts` is the only booking-log
writer and the only caller of the touched `discord/notify.ts` exports, so
nothing else could have silently broken. Noted the implementation does a real
`git fetch origin main` (not the ticket's suggested `--dry-run`) to avoid
under-reporting drift from a stale cached remote-tracking ref — a deliberate,
explained, correctness-motivated deviation, not a defect. Posted `VERDICT:
APPROVE` with cited findings and the `reviewed:approve` label.

**Blocked (infra, not scope) — same recurring issue, now 5-for-5:** `gh pr
comment` and `gh pr edit --add-label` again hit the account's GraphQL rate
limit on the very first call of the session (even `gh pr view`/`gh pr diff`
failed), despite `gh api rate_limit` showing the GraphQL quota mostly
unused (4892/5000) — so this reads as a secondary/abuse throttle on specific
mutating or PR-shaped GraphQL calls, not primary quota exhaustion. Worked
around it the same way as #56: REST calls (`gh api repos/.../pulls/57`,
`.../issues/57/comments`, `.../issues/57/labels`) instead of the GraphQL-backed
`gh pr`/`gh api -f labels[]` subcommands.

**Next:** Per D-0052 the dispatcher merges on the APPROVE and moves the board
card to Done; nothing further needed here unless the dispatcher's own GraphQL
calls hit the same throttle. The recurring GraphQL rate-limit block
(#51/#52/#53/#56) is now 5-for-5 at #57 — still overdue for a daemon-side fix
(or at minimum a documented REST fallback in the reviewer's own runbook) so
each review session doesn't have to rediscover the workaround.

---

## 2026-10-02 (even later still) — Reviewer: PR #58 (issue #53) → REQUEST CHANGES

**Done:** Reviewed [PR #58](https://github.com/notronwest/court-reserve-scheduler/pull/58)
(`Closes #53`, headless `redate` command) against the issue's acceptance
criteria and `DECISIONS.md` — no UI touched, so the design/phone gates didn't
apply. The happy path, dry-run output, registrant-count guard, and fail-closed
book→verify→cancel ordering all match the issue; it composes existing
`book_event.py` primitives rather than adding a duplicate surface (no D-0049
concern).

Found a real gap against the issue's own "never a third state" requirement:
`book_event()` can return `occurrence_id: null` on a *successful* booking —
the PR body itself cites this happening in production
(`booking_log_09-30-2026.json`) — and when that happens for the **target**
booking while courts/max assignment is still needed (`run.py:444-449`, true
for the PR's own documented `--courts 3,4 --max 10` example), or the
courts/max edit fails (`456-460`), or verification can't find the new
occurrence (`470-474`), the command bails out leaving a new **incomplete**
target occurrence live on Court Reserve *and* the source occurrence
untouched — a third state, not one of the two the acceptance criteria allow.
Suggested two concrete fixes in the review: resolve `target_occ_id` from the
target-date grid (the verification step already does that lookup, just needs
to also capture the matched `Id`), or cancel the stray target occurrence
before returning on those bail-out paths. Posted `VERDICT: REQUEST CHANGES`
with cited line numbers and the `reviewed:changes` label — created that label
on the repo since it didn't exist yet (only `reviewed:approve` did). Per
D-0052 this re-queues the card to the Builder's rework lane, not Ron.

**Next:** Builder picks up PR #58 on the same branch, fixes the null-
occurrence-id / rollback gap, pushes, and the reviewer re-reviews on the new
commit.

---

## 2026-10-02 (latest) — Reviewer: PR #59 (issue #50) → VERDICT: APPROVE

**Done:** Reviewed PR #59 (`feature/issue-50-silent-scheduler-failures`,
closes #50) per `daemon/agents/reviewer/PROMPT.md`. Checked the diff against
all three #50 acceptance criteria (failure alert + non-zero exit on a dead
`/schedule` fetch, bounded retry on `503`/`aborted` booking errors with the
existing `sendAutoBookSummary` already covering the "N booked, M failed"
run-summary, and the new `catch-up [--book]` CLI reusing `recommend()` +
`runScheduler` rather than duplicating booking logic — no D-0049 hit).
Confirmed the daily launchd job (`ts/ops/run-scheduler.sh`) actually runs the
patched `cli.ts schedule` path. Did not trust the PR body's claims —
checked out the PR branch into a scratch worktree (`/tmp/pr59-review`,
removed after) and ran `npm test` (117/117 green, including the 5 new tests)
and `npx tsc --noEmit` (clean) myself. No UI in this diff, so the
design-system/phone gates don't apply. Posted `VERDICT: APPROVE` with cited
findings, added label `reviewed:approve`
([comment](https://github.com/notronwest/court-reserve-scheduler/pull/59#issuecomment-5946692913)).
Per D-0052 this hands off to the dispatcher to merge to `main` and move the
board card to Done — no further action here.

**Next:** None from this review; watch for the dispatcher's merge of #59.

---

## 2026-10-08 — D-0056 finished: the standing pattern comes off the feed, and a never-worked read bug

**Context:** D-0056's ticket (#62, "Read the standing pattern from courtreserve-api
(GET /fixed-events) with a local cache; policy.json becomes the fallback seed; alert
on read failure") was handed over as *closed without being built*. It was not: PR #63
(`af597c2`) built `ts/src/fixedEvents.ts`, wired it into `runScheduler`, and shipped
the cache + alert + seed-fallback. Verified on `origin/main` before writing anything.
What was actually missing is smaller and worse.

**Done:**

- **Fixed a read that has never worked.** `CourtReserveClient.fixedEvents()` read
  `data.events`; the service returns the rows under `items` (courtreserve-api
  `queries.fixed_events`, the same shape as `/schedule`, from the endpoint's first
  commit). So a *successful* read resolved `undefined`, Pass 0 iterated an empty
  pattern, and **nothing alerted** — the whole standing weekly schedule would stop
  being booked in silence. `ts/tests/cr-client.test.ts` mocked `{ events }`, so the
  test asserted the bug and passed. A payload with no `items` array is now a failed
  read, which routes to the cache and fires the Discord alert.
  This was **latent, not yet firing**: the courtreserve-api instance at the
  scheduler's configured `CRAPI_URL` does not serve `/fixed-events` at all (41
  endpoints, no `/fixed-events`), so today every read 404s, falls back to the
  `policy.json` seed and alerts — correct, loud behaviour. The silent-empty failure
  would have struck the *day courtreserve-api was redeployed* and the feed came up.
- **`until` is now honoured, on every source.** A row whose `until` is on or before
  today is not booked. The service filters it server-side, but the cache and the seed
  do not — so a slot retired yesterday came back from a stale cache. The cache is
  stored unfiltered and the cutoff re-applied on each read, so it is judged against
  today's date, not the date it was written. This is the mechanism that makes the
  dashboard's retirement switch actually reach the booker.
- **An empty pattern alerts.** "Everything is retired" and "the read quietly returned
  nothing" are indistinguishable to the recommender, and the second one has now
  happened once.
- **`preferred_courts` is live.** The `preferred_courts` branch in Pass 0 was already
  correct; nothing ever *set* it, so pinning a court from the dashboard was a control
  with no effect. It now receives values off the feed. A pin is an instruction, not a
  hint: the slot takes the free subset of its pins and does not spill onto an unpinned
  court; if every pinned court is taken it is skipped as `no_court`.
- **An unplaced fixed event is no longer invisible.** `stats.skipped_fixed_events` was
  computed and then dropped on the floor on the auto-book path (`stats` is never
  written there). Each skip is now logged, and `logs/booking_log_<date>.json` carries
  `fixed_events` (`source`, `skipped`, `expired`).
- **Corrected `policy.json`'s `retired_events_note`**, which claimed "Nothing reads
  this block". courtreserve-api's seed sync does read it, to stamp `until` on the
  matching table rows — that is the whole retirement path.
- 159 tests pass (142 before; +17), typecheck clean, no pre-existing failures.
  `ts/src/recommender.ts` is untouched: no booking decision changed, and no mutating
  Court Reserve call was added anywhere.

**Next:** Review and merge
[PR #68](https://github.com/notronwest/court-reserve-scheduler/pull/68). Then two
things are needed before the chain actually works end to end, neither in this repo:
**(1)** redeploy courtreserve-api on the host so `GET /fixed-events` exists, and
**(2)** add the `preferred_courts int[]` column (the parallel contract work). Until
(1), the scheduler books from the `policy.json` seed and alerts daily — safe, but the
dashboard's court assignment stays cosmetic. This repo ships by `./setup.sh` on the
club Mac mini; merging to `main` deploys nothing.

---
## 2026-10-07 (later) — Reviewer: PR #66 (issue #65) → APPROVE

**Done:** Reviewed [PR #66](https://github.com/notronwest/court-reserve-scheduler/pull/66)
(`Closes #65`, retires the four Level Play fixed events) against the issue's
acceptance criteria, per `agents/reviewer/PROMPT.md`/`ROLE.md`. `gh pr diff`/
`gh pr view`/`gh pr comment` hit `GraphQL: API rate limit already exceeded`
repeatedly (REST calls to the same endpoints worked fine — looks like a
GraphQL-specific throttle, same flakiness class the Builder noted above);
worked around it by using `gh api` REST endpoints throughout, including for
posting the verdict comment and the label. Verified directly rather than
trusting the PR body: fetched the head commit's `policy.json` and parsed it
— 15 active `fixed_events.events`, zero matching `/level play/i`, exactly
the four issue-table entries in the new `retired_events` block with
`day_of_week`/`start_time`/`end_time`/`courts`/`level`/`event_id` preserved
byte-for-byte; grepped `ts/src/recommender.ts`, `ts/src/policy.ts`,
`ts/src/fixedEvents.ts`, `recommender.py` to confirm none reads
`fixed_events.retired_events`; diffed `main` against the PR branch to
confirm zero `approved_events` lines touched (satisfies the issue's
"do not touch" constraint on 1982138/1986151); confirmed
`ts/tests/fixtures/policy.json` is a separate file from the root
`policy.json` this PR edits, so the Level Play references in
`fixed-events.test.ts` are correctly left alone. No UI in this diff (pure
JSON), so design-system/phone-gate/D-0049 checks don't apply; no steps
handed to Ron (D-0068 n/a); CI ("PR links an issue") green,
`mergeable_state: clean`, not a draft. Posted `VERDICT: APPROVE` as a PR
comment with cited findings, added label `reviewed:approve`.

**Next:** Per D-0052 the dispatcher merges on this APPROVE (CI green, not
draft/conflicting) and moves the board card to Done — no Ron click needed
for this one. Once merged, the daily 8 AM scheduler stops
recommending/booking Level Play, as tracked in the Builder entry below.

---
## 2026-10-07 — Builder: PR #66 (issue #65) → retire the four Level Play fixed events

**Done:** Single-item Builder run on issue #65 ("Stop generating recurring
Level Play events"). Confirmed #65 had no existing sub-issues/open PRs (clean
build, not rework), moved the card In Progress → In Review, worked in an
isolated worktree (`/tmp/wt-issue-65`, removed on completion). Edited
`policy.json` only: moved the four Level Play entries (Mon 17:00, Tue 17:00,
Thu 18:00, Fri 12:00) out of `fixed_events.events` into a new sibling
`fixed_events.retired_events` block, preserved verbatim with
`retired_on`/`retired_reason`, so club management can reinstate a slot by
copying it back. No code touched — confirmed both engines
(`ts/src/recommender.ts` prod, `recommender.py` rollback-only) only ever
iterate `fixed_events.events`. Verified: `npm run typecheck` clean, full
vitest suite green (128/128 — the `fixed-events.test.ts` / golden fixtures
the issue flagged load their own `tests/fixtures/policy.json` copy, untouched
and unaffected), and a 5-day Mon–Fri dry-run diffed against the pre-change
policy showed the only delta is the four Level Play slots disappearing (freed
capacity absorbed by the recommender's normal demand-fill, not a replacement
event, per the issue's own instruction not to backfill). Opened
[PR #66](https://github.com/notronwest/court-reserve-scheduler/pull/66)
(`Closes #65`), confirmed GitHub's closing-issue link registered (lagged a
few seconds behind a run of transient GraphQL 500s on `gh project item-edit`
— same class of flakiness as the recurring rate-limit note below, retried
until it took), moved the board card to In Review.

**Flagged, not fixed:** the issue's "Constraints" section asserts `1982138`
and `1986151` "stay in the `approved_events` whitelist" — checked, and
neither ID is actually present in `approved_events` in the current
`policy.json`; `!book`/`!move` validation only accepts IDs that are keys
there, not in `fixed_events`. So ad-hoc `!book` of these two by number wasn't
working before this change either, and this PR doesn't change that (both IDs
are preserved verbatim in `retired_events`; `approved_events` itself is
untouched, as the issue explicitly required). Noted in the PR's Reviewer
notes rather than guessing at a fix — restoring that would need an explicit
`approved_events` addition, which is a separate ask.

**Next:** Ron reviews and merges PR #66 (the only gate); once merged the
daily 8 AM scheduler stops recommending/booking Level Play. The three
already-booked zero-registrant Level Play occurrences (10/9, 10/16, 10/19)
are being cancelled separately through the approval rail per the issue —
not part of this PR.

---
## 2026-10-02 (later still) — Reviewer: PR #56 (issue #51) → APPROVE

**Done:** Reviewed [PR #56](https://github.com/notronwest/court-reserve-scheduler/pull/56)
(`Closes #51`, non-interactive `--yes`/`--only` booking path) against the
issue's acceptance criteria, `DECISIONS.md`, and CLAUDE.md conventions —
no UI touched, so the design/phone gates didn't apply. All five ACs verified
by reading the diff directly (dry-run preview, live `booked=N failed=M`
output, idempotent re-run via the pre-existing `_check_conflict`/`_overlaps`
guard, `--only` time filtering, unchanged behavior with the flag absent).
CI (`check`) green on the PR head. Posted `VERDICT: APPROVE` with cited
findings, one non-blocking observation (`--yes` alone, without `--book`,
now also triggers a live booking — untested as a standalone case but
violates no written AC), and the `reviewed:approve` label, per
`agents/reviewer/PROMPT.md`.

**Blocked (infra, not scope) — same recurring issue, now 4-for-4:** `gh pr
comment` and `gh pr edit --add-label` both hit the account's GraphQL rate
limit (same failure mode as the #51/#52/#53 sessions logged below). Worked
around it by posting the verdict comment and the `reviewed:approve` label
via the REST API (`gh api repos/.../issues/56/comments`,
`.../issues/56/labels`) instead of the GraphQL-backed `gh pr` subcommands.
First attempt at the REST comment post also mis-used `gh api -f
body=@file` (which sends the literal string, not file contents) — caught
it immediately, deleted the bad comment, and reposted with `-F` (which
does interpret `@file`). No reviewer-authored comment was left wrong on
the PR.

**Next:** Per D-0052 the dispatcher — not this review session — merges on
the APPROVE and moves the board card to Done; nothing further needed here
unless the dispatcher's own GraphQL calls hit the same rate limit, in
which case the card may need a manual move like #53 did. The daemon
ticket for the recurring GraphQL rate-limit block (flagged below as
3-for-3) is now overdue at 4-for-4 across #51/#52/#53/#56.

---
## 2026-10-02 (later) — Builder: GraphQL rate limit cleared, #53 board card now In Review

**Update to the entry below:** the GraphQL rate limit recovered later in the
same session. Card #53 is now correctly **In Review** (linked to PR #58) with
**Type = feature** set. No manual board move needed on this one — the
"Blocked (infra, not scope)" / "Next" notes below are superseded on the board
move specifically; the daemon-ticket suggestion for the recurring rate limit
still stands (3-for-3 across #51/#52/#53 before it cleared).

---
## 2026-10-02 — Builder: headless, fail-closed `redate` command (issue #53)

**Done:** Opened [PR #58](https://github.com/notronwest/court-reserve-scheduler/pull/58)
(`Closes #53`, branch `feature/issue-53-redate-headless`, built in an isolated
worktree — `main` untouched). Adds `python run.py redate`, composing the
existing `book_event` / `edit_occurrence_multi_court` / `cancel_occurrence`
primitives into one fail-closed date-move:

- Resolves the source occurrence live from the occurrences grid by
  `--event-id` + `--from` date (never trusts `booking_log_*.json`, which can
  record `occurrence_id: null` even on a successful booking).
- Reports the registrant count before touching anything; refuses unless
  `--force` when it's > 0.
- Books the target date/time/courts, assigns extra courts + `MaxPeople` if
  given, then **verifies** the new occurrence actually landed by re-reading
  the target date's grid — only *after* that succeeds does it cancel the
  source. Any failure along the way (booking, court/max assignment,
  verification) leaves the source untouched.

Verified: `py_compile`, `--help` for all three subcommands, and a mocked
control-flow harness exercising every branch (dry-run, refuse-without-force,
force-through, full success, booking failure, verification failure,
single-court no-op) — no live Court Reserve creds in this environment, so the
actual Playwright/Kendo interaction is unverified by the agent (the PR body
calls this out; `book_event`/`edit_occurrence_multi_court`/
`cancel_occurrence` themselves are unchanged — this PR only composes them).

**Blocked (infra, not scope):** Same GraphQL rate-limit issue as the #51 and
#52 sessions — **third consecutive session** this has blocked a board move.
`gh project`/`gh pr create` need GraphQL, which returned a persistent
rate-limit error for most of the session despite the REST quota reporting
fully available; REST calls (issue read, PR create) worked fine throughout.
PR creation went through the REST API directly as a fallback. A background
poll was left running to move the #53 card to **In Review** the moment
GraphQL recovers, but if this session ends first, the card still needs a
manual move. Given this is now 3-for-3, it's worth a daemon ticket on its own
merits rather than waiting for a 4th occurrence.

**Next:** Ron reviews PR #58 — validation steps in the body are CLI-based
(this repo has no web preview) and call out the untested-against-live-CR gap
explicitly. Separately: file the daemon ticket on the recurring GraphQL
rate-limit block mentioned above.

---
## 2026-10-01 (later) — Builder: policy provenance tracking + staleness alert (issue #52)

**Done:** Opened [PR #57](https://github.com/notronwest/court-reserve-scheduler/pull/57)
(`Closes #52`, branch `feature/issue-52-policy-provenance`, built in an isolated
worktree — `main` untouched). Addresses the #51/#52 incident (a merged
`policy.json` change sat un-pulled on the mini for 12 days with nothing
reporting the gap) by making staleness **visible, not auto-fixed**:

- New `ts/src/policyProvenance.ts`: resolves `policy_sha` (last commit to
  touch `policy.json`), `head_sha` (working-tree HEAD), and
  `behind_origin_main` (via a quiet, 10s-capped `git fetch` + `git rev-list
  --count`; `null` on any failure — no network, bad remote, timeout — never
  throws).
- `runScheduler` now writes `policy_provenance: { policy_sha, head_sha,
  behind_origin_main }` into `logs/booking_log_<date>.json`, and both the
  auto-book and `--recommend` Discord embeds get a `policy @ <short-sha>`
  footer plus a visible `⚠️ STALE POLICY` warning line when
  `behind_origin_main > 0`.
- Extracted `buildAutoBookSummaryEmbed` as a pure function (matching the
  existing `buildRecommendationsEmbed` pattern) so the new logic is
  unit-tested directly.
- Reporting only — exit code stays 0, booking behavior unchanged. Whether the
  mini should auto-pull `origin/main` before each run is explicitly **out of
  scope**, routed to daemon separately (an unreviewed auto-pull would book
  live courts off unreviewed code).

Verified: `tsc --noEmit` clean, full suite **109/109 passing** (4 new tests in
`policyProvenance.test.ts` exercise all four ticket acceptance scenarios
directly: in-sync, behind-origin, and network-failure cases).

**In flight:** Same GraphQL rate-limit issue as the #51 session recurred —
the WMPC Roadmap board card for #52 could not be moved to **In Review**
(Projects v2 requires GraphQL, which returned a persistent rate-limit error
all session despite the REST quota showing fully available). PR creation
itself went through the REST API as a fallback and succeeded cleanly. Left a
comment on issue #52 flagging the stuck card for a manual move or a later
run once GraphQL recovers.

**Next:** Ron reviews PR #57 (no live Court Reserve/Discord creds in this
environment, so the Discord embed rendering and a real stale-checkout repro
are unverified by the agent — validation steps in the PR body walk through
both). Separately: whoever runs the next Builder session should check
whether the GraphQL rate limit is a recurring/systemic issue worth a daemon
ticket, since it's now blocked two consecutive board moves.

---
## 2026-10-01 — Builder: non-interactive `--yes` booking path for approved backfills (issue #51)

**Done:** Opened [PR #56](https://github.com/notronwest/court-reserve-scheduler/pull/56)
(`Closes #51`, branch `feature/issue-51-non-interactive-booking`, built in an
isolated worktree — `main` untouched). Adds `--yes` / `--non-interactive` and
`--only "<HH:MM,...>"` to `run.py run` so an already-approved backfill can book
end to end with no Discord reply or terminal prompt:

- Skips the Discord-wait / terminal-prompt selection path entirely; books
  every recommendation (or just the `--only` subset) directly.
- Still posts results to Discord afterward, but never posts-and-waits for a
  retry reply in this mode.
- Last stdout line is a machine-readable `booked=N failed=M`; exits non-zero
  only on a genuine booking failure.
- Idempotence: reuses the existing pre-booking live-schedule conflict check
  (`_check_conflict` / `_overlaps`) and does **not** count a conflict-skip as
  a failure, so re-running against an already-completed date converges to
  `booked=0 failed=0` / exit 0 instead of failing forever — satisfies the
  issue's constraint that a half-completed run must be safely re-runnable.
- `--yes` absent → behavior is byte-for-byte unchanged (same Discord/terminal
  flow, same retry loop).

Verified: `python3 -m py_compile`, `--help` output, and a direct check of the
new `--only` time parser — no live Court Reserve credentials in this
environment, so the actual booking/idempotence behavior against live data is
**unverified by the agent**; the PR's validation steps call this out and lead
with a `--dry-run` check before a real `--yes` run.

**In flight:** `gh`'s GraphQL quota was fully exhausted when moving the board
card — a background watcher is moving issue #51's board card to **In Review**
once the quota resets (~02:11 UTC); if STATUS.md says this and the board
still shows it elsewhere, the move may need to be done by hand.

**Next:** Ron reviews PR #56 on a real backfill date with `--dry-run` first
per the validation steps, then merges.

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
  | Mens Advanced Plus | 17:00–19:00 | 17:00–19:00 (unchanged — Ron's call; the one other court in 16–18) |
  | Co-Ed 3.25-3.5 Level Play | 17:00–19:00 | **18:00–20:00** |
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
- The earlier "Thursday 17:00–19:00 Intermediate" ask (STATUS 2026-09-06) is now moot
  as specified: 17:00–18:00 is full (women's ×2 + Mens). An Intermediate slot would
  have to be 18:00–20:00 alongside Co-Ed 3.25-3.5, which resolves to the same
  `1931656` — still needs its own `event_id`.
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
