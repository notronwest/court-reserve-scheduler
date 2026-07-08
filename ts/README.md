# courtreserve-scheduler — TypeScript rewrite (in progress)

The Python scheduler is being rewritten to TypeScript per
[`../docs/TS-REWRITE-PLAN.md`](../docs/TS-REWRITE-PLAN.md). All Court Reserve access
goes through the **`courtreserve-api` HTTP service** — there is **no Playwright /
browser in this repo**, which is what makes it immune to the browser-version drift
that used to break the Python version.

**Status:** Phase 0 (scaffold), Phase 1 (CR HTTP client), Phase 2 (recommender + policy +
history, rule-based path), and Phase 3 (LLM ranker + command parser) — done. The rule-based
path has parity tests asserting byte-identical output to the Python; the LLM modules have
mocked-SDK tests plus a live end-to-end verify. Discord bot and scheduled jobs remain.

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

## What's next (see the plan)

- **Phase 4** — Discord bot + approval loop (`discord.js`).
- **Phase 5** — scheduled jobs (`src/jobs/*`) + launchd → node. Needs a `/checkin`
  endpoint added to `courtreserve-api` first.
- **Phase 6** — shadow-run beside the Python, then cut over job-by-job and delete the Python.
