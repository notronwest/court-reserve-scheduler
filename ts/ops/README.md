# launchd cutover — Python → TypeScript

These plists + wrappers run the four scheduler jobs on **node/tsx** instead of
Python. They reuse the same `com.whitemountain.*` labels and the same schedules,
so cutover is a swap, not a new set of jobs. All Court Reserve access still goes
through the `courtreserve-api` HTTP service — nothing here drives a browser.

| Label | Runs | Schedule |
|---|---|---|
| `com.whitemountain.listener` | `run-listener.sh` → `src/discord/listener.ts` | always-on (RunAtLoad + KeepAlive) |
| `com.whitemountain.scheduler` | `run-scheduler.sh` → `cli.ts schedule <14d-out>` | daily 8:00 AM |
| `com.whitemountain.fetch-history` | `run-fetch-history.sh` → `jobs/fetchHistory.ts` | Mondays 7:00 AM |
| `com.whitemountain.check-waitlists` | `run-check-waitlists.sh` → `jobs/checkWaitlists.ts` | 9/11/13/15/17 daily |

Wrappers add `/opt/homebrew/bin` to `PATH` (launchd's PATH is minimal) and `cd`
into `ts/` before running `npx tsx`.

## Prerequisites

1. `courtreserve-api` running: `curl localhost:8787/health`
2. `cd ts && npm install`, and `ts/.env` populated (see `.env.template`)
3. If the TS listener is running in the foreground, **Ctrl-C it first** — otherwise
   cutover loads a second listener and you get double bookings on the live channel.

## Cut over

```bash
bash ts/ops/cutover.sh
tail -f ~/Library/Logs/court_reserve/launchd_listener.log
```

`cutover.sh` unloads each Python job, backs its plist up to
`~/Library/LaunchAgents/.python-plist-backup/`, installs the TS plist under the
same label, and loads it.

## Roll back

```bash
bash ts/ops/rollback.sh
```

Restores the Python plists from the backup. The Python code stays in the repo
root, so rollback is fully functional — keep it until the TS jobs have a few
clean days.
