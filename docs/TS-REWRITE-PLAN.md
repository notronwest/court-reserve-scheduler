# TypeScript rewrite plan — courtreserve-scheduler

> **Status: PLANNED, not started.** Execute when Ron is open to disruption of the
> live booking system. This doc is the roadmap so any session can pick it up.

## Goal

Rewrite this scheduler from Python to **TypeScript**, with **zero Python** in the
repo, and route all Court Reserve access through the **`courtreserve-api` HTTP
service** instead of driving a browser here. End state:

- No `cr_client.py` / `book_event.py` / Playwright / browser in this repo.
- CR ops (`schedule`, `book`, `move`, `cancel`, …) are HTTP calls to
  `courtreserve-api` (running on the club Mac mini). This repo owns **no** CR
  browser code — one browser owner for the whole fleet.
- The scheduler brain (recommender, LLM ranking, Discord bot, policy) becomes TS.
- Reports health to the shared fleet `app_health` table (see the health mechanism —
  separate deliverable).

**Supersedes** the import-based cutover PRs (courtreserve-scheduler #12,
rating-session-manager #45): those had consumers *import* the Python package; the
rewrite goes further and calls the HTTP service, removing Python entirely.
rating-session-manager's two Python scripts get the same treatment (→ HTTP), making
that repo pure TS — a smaller, independent cutover that can happen anytime.

## Guiding principles (this is a LIVE booking system)

1. **Never break daily booking or the Discord approval loop.** Python keeps running
   until each TS piece is proven and cut over.
2. **Parity-first.** Port pure logic with tests that assert the TS output matches the
   Python for the same inputs (same recommendations for a given date + schedule).
3. **Incremental, per-job cutover.** The 4 launchd jobs
   (`scheduler`, `listener`, `fetch-history`, `check-waitlists`) move to Node one at
   a time, each verified before the next.
4. **Shadow-run before cutover.** Run the TS path in `--dry-run` beside the live
   Python, diff the results, cut over only when they agree.

## Target stack

- **Node + TypeScript.**
- **`@anthropic-ai/sdk`** — LLM ranking + command parsing (replaces the Python `anthropic`).
- **`discord.js`** — the persistent bot / approval listener + commands (replaces the raw Discord polling).
- **`fetch`** — HTTP calls to `courtreserve-api` (replaces `browser_session` + Playwright).
- **`vitest`** — tests (parity + unit).
- Keep `policy.json` as-is (data, not code). History/state: keep JSON files initially,
  or move to Supabase later (decide in phase 2).

## The courtreserve-api contract this depends on

Existing endpoints (see `courtreserve-api` `service.py` / `deploy/README.md`), all
`X-API-Key` gated:

| This repo used | → HTTP call |
|---|---|
| `fetch_schedule(start,end)` | `GET /schedule?start=&end=` |
| `book_event(...)` | `POST /book` |
| `move_occurrence(...)` | `POST /move` |
| `cancel_occurrence(...)` | `POST /cancel` |
| `edit_occurrence_multi_court(...)` | `POST /events/courts` |
| `fix_event_court(...)` | `POST /events/fix-court` |

**Gaps to add to `courtreserve-api` first** (the waitlist + check-in jobs use CR
actions the service doesn't expose yet):
- **check-in past attendees** (`checkin_past.py`) — no `/checkin` endpoint yet.
- **waitlist detection** (`check_waitlists.py`) — reads schedule (can use `/schedule`),
  but confirm it needs no extra CR interaction.

Add those endpoints to `courtreserve-api` as a prerequisite to porting those jobs.

## File-by-file map

| Python (now) | → TypeScript | Notes |
|---|---|---|
| `cr_client.py`, `book_event.py` | **deleted** | CR ops become HTTP calls to `courtreserve-api` |
| `recommender.py` | `src/recommender.ts` | pure logic — **parity tests** |
| `policy_loader.py` + `policy.json` | `src/policy.ts` (+ keep `policy.json`) | load JSON |
| `history_analysis.py` | `src/history.ts` | reads history data |
| `llm_ranker.py` | `src/llm/ranker.ts` | `@anthropic-ai/sdk` |
| `llm_parser.py` | `src/llm/parser.ts` | `@anthropic-ai/sdk` |
| `discord_notify.py` | `src/discord/notify.ts` | embeds + webhook |
| `discord_listener.py` | `src/discord/listener.ts` | `discord.js` bot — biggest piece |
| `run.py` | `src/cli.ts` | CLI entrypoint |
| `fetch_history.py` | `src/jobs/fetchHistory.ts` | `GET /schedule` → write history |
| `check_waitlists.py` | `src/jobs/checkWaitlists.ts` | needs the schedule + (verify) |
| `checkin_past.py` | `src/jobs/checkinPast.ts` | needs a new `/checkin` endpoint |
| `fix_imbalance.py` | `src/jobs/fixImbalance.ts` | book/cancel via HTTP |
| `test_connections.py` | `src/healthcheck.ts` | connectivity + `app_health` report |
| `ops/*.plist` | updated to run `node …` | swap per job at cutover |

## Phased plan

**Phase 0 — scaffold.** Node/TS project in this repo (`src/`, `tsconfig`, `vitest`,
`package.json`). Python stays untouched and running. A shared **CR client**
(`src/cr/client.ts`) wrapping the `courtreserve-api` HTTP calls + a typed schedule model.

**Phase 1 — CR via HTTP (the "new api architecture" part).** Prove the TS CR client
against the running service (`/schedule`, then a `--dry-run` `/book`). This alone
removes the browser dependency for anything built on it. *Verify:* TS pulls the same
schedule the Python does for a given range.

**Phase 2 — pure logic + policy + history.** Port `recommender`, `policy`, `history`.
**Parity tests:** feed the same schedule fixture to Python and TS, assert identical
recommendations. Decide history storage (JSON vs Supabase). *Verify:* parity suite green.

**Phase 3 — LLM.** Port `llm_ranker` + `llm_parser` (`@anthropic-ai/sdk`). *Verify:*
same structured recommendations for a fixed prompt (allow for model nondeterminism —
assert shape + court/time validity, spot-check parity).

**Phase 4 — Discord.** Port `discord_notify` + `discord_listener` (`discord.js`).
Run against a **test channel** first. *Verify:* post recommendations, approve via reply,
`!book`/`!move`/`!schedule` commands work end to end in the test channel.

**Phase 5 — scheduled jobs.** Port `fetchHistory`, `checkWaitlists`, `checkinPast`,
`fixImbalance` + `cli`. Add the missing `courtreserve-api` endpoints (`/checkin`) first.
Update the `ops/*.plist` to run `node`.

**Phase 6 — shadow-run + cutover.** Run TS `--dry-run` beside live Python for a week;
diff daily recommendations. When they agree: cut launchd over job-by-job (start with
`fetch-history`, end with the daily `scheduler` + `listener`). Delete the Python +
`requirements.txt` + venv. Repo is now pure TS.

## Cutover safety checklist (per job)

- [ ] TS job runs green in `--dry-run` and matches Python output.
- [ ] Discord goes to the **test** channel until the real one is deliberately enabled.
- [ ] Old Python plist unloaded only after the TS plist is loaded + verified.
- [ ] A rollback path: keep the Python on a branch/tag so we can reload it fast.

## Open decisions (resolve at Phase 0)

- **In-place vs new repo.** *Recommended:* in-place — build `src/` TS beside the Python,
  cut launchd per-job, delete Python at the end. Keeps history/policy/git-history in one place.
- **History/state store.** JSON files (as today) vs a Supabase `cr` schema. Lean JSON
  first; revisit if the dashboard wants the history.
- **Discord bot vs webhook-only.** The listener needs a bot (gateway) for the approval
  loop + commands → `discord.js`. Notify-only paths can stay webhook `fetch`.

## Prerequisites

- `courtreserve-api` service live on the Mac mini (**done** — verified pulling data).
- Add `/checkin` (and confirm waitlist needs) to `courtreserve-api` before Phase 5.
- The shared `app_health` table + TS reporter (separate deliverable) for health reporting.
