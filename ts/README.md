# courtreserve-scheduler — TypeScript rewrite (in progress)

The Python scheduler is being rewritten to TypeScript per
[`../docs/TS-REWRITE-PLAN.md`](../docs/TS-REWRITE-PLAN.md). All Court Reserve access
goes through the **`courtreserve-api` HTTP service** — there is **no Playwright /
browser in this repo**, which is what makes it immune to the browser-version drift
that used to break the Python version.

**Status:** Phase 0 (scaffold) + Phase 1 (CR HTTP client) — done and runnable.
Recommender, LLM ranking, Discord bot, and the scheduled jobs are the remaining phases.

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
- `src/cli.ts` — dev CLI (`health`, `schedule`; more commands per phase).
- `tests/` — vitest unit tests (mocked).

## What's next (see the plan)

- **Phase 2** — port `recommender` + `policy` + `history` (`src/recommender.ts`,
  `src/policy.ts`) with **parity tests** asserting the same recommendations as the Python.
- **Phase 3** — LLM ranker/parser (`@anthropic-ai/sdk`).
- **Phase 4** — Discord bot + approval loop (`discord.js`).
- **Phase 5** — scheduled jobs (`src/jobs/*`) + launchd → node. Needs a `/checkin`
  endpoint added to `courtreserve-api` first.
- **Phase 6** — shadow-run beside the Python, then cut over job-by-job and delete the Python.
