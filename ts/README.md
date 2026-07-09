# courtreserve-scheduler — TypeScript rewrite (in progress)

The Python scheduler is being rewritten to TypeScript per
[`../docs/TS-REWRITE-PLAN.md`](../docs/TS-REWRITE-PLAN.md). All Court Reserve access
goes through the **`courtreserve-api` HTTP service** — there is **no Playwright /
browser in this repo**, which is what makes it immune to the browser-version drift
that used to break the Python version.

**Status:** Phase 0 (scaffold), Phase 1 (CR HTTP client), Phase 2 (recommender + policy +
history, rule-based path), Phase 3 (LLM ranker + command parser), and Phase 4 (Discord
listener) — done. The rule-based path has parity tests asserting byte-identical output to
the Python; the LLM + Discord modules have mocked tests. Scheduled jobs (Phase 5) remain.

Phase 1 was verified live (TS client → local `courtreserve-api` → Court Reserve returned
the identical schedule the Python browser path did). Phase 3's ranker was verified live
against the Claude API — a real `book_slots` tool call parsed into valid, approved,
free-slot bookings covering all five levels.

The Python scheduler at the repo root keeps running until the TS version is proven and
cut over per the plan (parity + shadow-run). Nothing here touches it.

## Run it

```bash
cd ts
npm install
cp .env.template .env        # set CRAPI_URL + CRAPI_KEY (from the courtreserve-api service)

npm run health               # is the service up?
npm run schedule 7/22/2026   # pull the live CR schedule via the service
npm test                     # unit tests (mocked fetch — no live service needed)
npm run typecheck
```

`CRAPI_URL` is the `courtreserve-api` service (e.g. the Mac mini on the LAN,
`http://<mini-ip>:8787`); `CRAPI_KEY` is that service's `X-API-Key`.

## Layout

- `src/cr/client.ts` — typed HTTP client for `courtreserve-api` (schedule / book / move / cancel / …).
- `src/cr/types.ts` — CR payload + request shapes.
- `src/recommender.ts` — rule-based recommender (Pass 0 fixed events, Pass 1 level
  coverage, Pass 2 utilization fill). Port of `recommender.py` minus the LLM path.
- `src/policy.ts` — `policy.json` loader + types.
- `src/history.ts` — historical popularity scoring (`loadPopularity` / `popularityScore`,
  plus `loadPopularityFull` / `loadTimePatterns` for the LLM prompt).
- `src/llm/ranker.ts` — LLM Pass 1+2 (`callLlmRanker`): builds the prompt, forces the
  `book_slots` tool call, and re-validates every booking. Port of `llm_ranker.py`.
- `src/llm/parser.ts` — `!book` / `!move` natural-language parser (`parseBookCommand` /
  `parseMoveCommand`), Claude Haiku. Port of `llm_parser.py`.
- `src/datetime.ts` — timezone-free datetime + Python-compatible rounding, so date math
  and stats match the Python exactly.
- `src/cli.ts` — dev CLI (`health`, `schedule`; more commands per phase).
- `src/discord/` — the persistent listener (Phase 4). `rest.ts` (REST polling — no
  gateway, no privileged intent), `notify.ts` (embeds + reply parsers, port of
  `discord_notify.py`), `state.ts` (listener/pending files), `execute.ts` (book/move/expand
  via `courtreserve-api`, the layer that was Playwright in Python), `listener.ts` (routing +
  poll loop, port of `discord_listener.py`).
- `tests/` — vitest: mocked client tests + **parity tests** (`tests/fixtures/` holds
  real CR schedule data and Python-generated golden outputs).

## Parity tests

`tests/recommender.parity.test.ts` + `tests/history.parity.test.ts` feed the same
schedule + policy (+ optional history) to the TS recommender and assert the output
equals a golden captured from the Python `recommend()`. Fixtures cover real-schedule
days, empty-schedule full-fill days, and a synthetic-history case where popularity
changes the placement. Regenerate goldens from the Python if the rules change.

The LLM modules keep the Python's exact model IDs (`claude-sonnet-4-6` ranker,
`claude-haiku-4-5` parser) so the TS path can be shadow-run and diffed against the Python
during cutover; override with `CR_RANKER_MODEL` / `CR_PARSER_MODEL`. Wiring the ranker into
an async `recommend()` path lands with the CLI/jobs (Phase 5) — `callLlmRanker` already has
the signature to slot in.

## Discord listener (Phase 4)

```bash
cp .env.template .env    # set DISCORD_BOT_TOKEN + DISCORD_WEBHOOK_URL; CHANNEL_ID
                         # defaults to the TEST channel
npm run listen           # start the persistent listener (REST polling)
```

Design notes / deliberate deviations from the plan:
- **REST polling, not `discord.js` gateway.** Reading channel history over REST needs only
  "Read Message History" — **not** the privileged `MESSAGE_CONTENT` gateway intent — so the
  bot works with zero portal toggles, matching the Python. Only `rest.ts` + the loop change
  if we later want a gateway.
- **No browser lock.** CR actions are HTTP calls to the single `courtreserve-api` process,
  which owns the one browser and serializes them; the Python `browser.lock` is gone.
- **`/move` changes time only** (the endpoint takes no court). A requested court change is
  surfaced in the result but not applied — safe for a live system; a proper endpoint is a
  Phase 5 item.
- **`!schedule`** spawns `CR_SCHEDULE_CMD` (date appended). Until Phase 5 wires the TS
  scheduler, leave it unset (logs + no-ops) or point it at the Python during cutover.
- CR mutation responses are normalized (`normalizeCrResult`). **Verified** against the live
  `courtreserve-api` (`booking.py`): `/book` → `{success, occurrence_id, error}`, `/events/courts`
  → `{success, error}`. A read-only `/schedule` fetch through the TS client against the running
  service also returned the real Court Reserve schedule.

State files (`pending_approval.json`, `listener_state.json`, `pending_waitlist.json`) default
to `../logs` so the TS listener shadow-runs against the same run.py output; override with
`CR_LOGS_DIR`.

## What's next (see the plan)

- **Phase 5** — scheduled jobs (`src/jobs/*`) + launchd → node. Needs a `/checkin`
  endpoint added to `courtreserve-api` first. Also add a court-aware `/move` (or `/reschedule`).
- **Phase 6** — shadow-run beside the Python, then cut over job-by-job and delete the Python.
