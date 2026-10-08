# launchd cutover — Python → TypeScript

These plists + wrappers run the four scheduler jobs on **node/tsx** instead of
Python. They reuse the same `com.whitemountain.*` labels and the same schedules,
so cutover is a swap, not a new set of jobs. All Court Reserve access still goes
through the `courtreserve-api` HTTP service — nothing here drives a browser.

| Label | Runs | Schedule |
|---|---|---|
| `com.whitemountain.listener` | `run-listener.sh` → `src/discord/listener.ts` | always-on (RunAtLoad + KeepAlive) |
| `com.whitemountain.scheduler` | `run-scheduler.sh` → `cli.ts schedule <14d-out>` | daily 8:00 AM |
| `com.whitemountain.catch-up` | `run-catch-up.sh` → `cli.ts catch-up --book` | daily 8:30 AM |
| `com.whitemountain.fetch-history` | `run-fetch-history.sh` → `jobs/fetchHistory.ts` | Mondays 7:00 AM |
| `com.whitemountain.check-waitlists` | `run-check-waitlists.sh` → `jobs/checkWaitlists.ts` | 9/11/13/15/17 daily |
| `com.whitemountain.checkin` | `run-checkin.sh` → `jobs/checkinPast.ts --execute --days 8` | Mondays 6:00 AM |

**Auto-book:** the `schedule` command books directly (no Discord approval gate).
`--recommend` reverts to the post-and-approve flow; `--dry-run` previews without
booking.

**Self-heal (#50):** the 8:00 run's live schedule fetch is retried (20 s, then
60 s) before it alerts — one flaky Court Reserve page-load used to cost a whole
day (10/05, 10/06, 10/14). The 8:30 `catch-up --book` then walks today..today+14
and re-books any date that is **empty** or **missed** (no `booking_log_<date>.json`
from the daily run, or one with 0 booked, while the engine still has room to
fill). A **thin** day (under half the policy target but the daily run did finish)
is reported to Discord, never refilled — a day Ron deliberately thinned must not
grow back every morning. A clean horizon posts nothing; liveness is the heartbeat.

**Heartbeats:** both wrappers call daemon's `infrastructure/heartbeat/heartbeat.sh`
(jobs `scheduler-daily` and `scheduler-catch-up`) **only on exit 0**. `schedule`
exits 1 when it booked nothing it meant to book; `catch-up` exits 1 when a date
could not be read or a re-book threw. The fleet watchdog alarms on 48 h of silence,
so a dead morning is noticed even if nobody reads Discord.

Every auto-book run is tracked two ways:
- **Discord confirmation** — one embed per run listing each reservation:
  green `✅ Booked N/N · <day>` when all land, amber/red `⚠️ Booked N/M — K failed`
  with the error lines when any fail. Positive proof each booking worked.
- **Booking log** — `logs/booking_log_<date>.json`, a per-run ledger of each
  event (date/time/court/level/event_id), booked-or-failed, CR occurrence_id,
  and a timestamp. The durable "started + completed" record.

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
