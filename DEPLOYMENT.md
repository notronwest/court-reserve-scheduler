# Deployment — court-reserve-scheduler

No cloud host and no web frontend. This is a **node/tsx** system installed on
**one always-on Mac** as five launchd agents: a daily auto-booker, a daily
waitlist checker, a weekly history fetch, a weekly past-event check-in, and a
persistent Discord listener. "Deploying" is `./setup.sh` on that machine.
Pushing to `main` deploys nothing.

**The jobs run TypeScript, not Python.** `setup.sh` installs the plists from
[`ts/ops/`](./ts/ops/); the Python tree at the repo root is the rollback path
([`ts/ops/rollback.sh`](./ts/ops/rollback.sh)), not the live one. Court Reserve
access goes through the [`courtreserve-api`](../courtreserve-api) HTTP service —
**none of these five jobs drives a browser.**

It still has to be a real Mac, one step removed: `courtreserve-api` drives
**non-headless Chrome** against a saved browser profile, on the club's
residential IP. Headless breaks Cloudflare's bot check, and a datacenter IP gets
challenged.

```yaml
# wmpc-deployment: v1
repo: court-reserve-scheduler
archetype: mac-mini-launchd
branches:
  main: n/a — pushing to main deploys NOTHING; a human runs ./setup.sh on the host
  production: n/a — this repo has no production branch
targets:
  - name: scheduler
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.scheduler — daily at 8:00 AM (installed/reloaded by ./setup.sh)
    source: ts/ops/run-scheduler.sh → ts/src/cli.ts schedule <14d-out>
    env: PROD
    url: n/a — books directly (auto-book), then posts a confirmation embed to Discord
    host: the machine ./setup.sh was run on (single install; not fleet-replicated)
    config_scope: ts/.env on that machine (CRAPI_URL/KEY, Discord webhook + bot token, Anthropic API key) + policy.json + courts.json
    verify: ./check.sh, and the logs under ~/Library/Logs/court_reserve/
    rollback: git checkout an earlier commit and re-run ./setup.sh
  - name: catch-up
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.catch-up — daily at 8:30 AM (installed/reloaded by ./setup.sh)
    source: ts/ops/run-catch-up.sh → ts/src/cli.ts catch-up --book
    env: PROD
    url: n/a — re-books any date in today..today+14 the 8:00 run left empty or never finished (#50); posts one Discord embed only when it found something; heartbeats daemon job scheduler-catch-up on exit 0
    host: same machine
    config_scope: same ts/.env; reads logs/booking_log_*.json written by the 8:00 run
    verify: ~/Library/Logs/court_reserve/launchd_catch_up.log — every date lists OK / MISSED / EMPTY / THIN / UNKNOWN with hours vs target
    rollback: launchctl unload the plist
  - name: check-waitlists
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.check-waitlists — 9:00, 11:00, 13:00, 15:00, 17:00 daily
    source: ts/ops/run-check-waitlists.sh → ts/src/jobs/checkWaitlists.ts
    env: PROD
    url: n/a
    host: same machine
    config_scope: same .env
    verify: the job's log under ~/Library/Logs/court_reserve/
    rollback: launchctl unload the plist
  - name: fetch-history
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.fetch-history — weekly, Monday 7:00 AM
    source: ts/ops/run-fetch-history.sh → ts/src/jobs/fetchHistory.ts
    env: PROD
    url: n/a — writes into history/
    host: same machine
    config_scope: same .env
    verify: a fresh dated file in history/
    rollback: launchctl unload the plist
  - name: listener
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.listener — persistent (RunAtLoad + KeepAlive)
    source: ts/ops/run-listener.sh → ts/src/discord/listener.ts
    env: PROD
    url: n/a — handles !book / !move / !schedule and waitlist expansions in Discord
    host: same machine
    config_scope: same ts/.env (Discord bot token / webhook)
    verify: launchctl list | grep com.whitemountain.listener; react in Discord and confirm it acts
    rollback: launchctl unload the plist
  - name: checkin
    kind: mac-mini-launchd
    trigger: launchd com.whitemountain.checkin — weekly, Monday 6:00 AM
    source: ts/ops/run-checkin.sh → ts/src/jobs/checkinPast.ts --execute --days 8
    env: PROD
    url: n/a — checks in players on past events so attendance history is accurate
    host: same machine
    config_scope: same ts/.env
    verify: the job's log under ~/Library/Logs/court_reserve/
    rollback: launchctl unload the plist
  - name: cr-browser-session
    kind: none
    trigger: MANUAL, interactive — step 8 of ./setup.sh opens a browser to log in
    note: used by the Python rollback path only; the five TS jobs reach CR via courtreserve-api
    source: cache/chrome_profile/
    env: PROD
    url: n/a
    host: same machine
    config_scope: the saved Chrome profile — NOT in the repo, NOT recreatable by a deploy
    verify: cache/chrome_profile/Default/Cookies exists and the scheduler can fetch a schedule
    rollback: delete the profile and re-run `python cr_client.py --login`
```

## What ships from this repo

| Target | Trigger | Runs |
|---|---|---|
| `scheduler` | launchd | daily 8:00 AM |
| `catch-up` | launchd | daily 8:30 AM — re-books what 8:00 missed |
| `check-waitlists` | launchd | 9:00 · 11:00 · 13:00 · 15:00 · 17:00 daily |
| `fetch-history` | launchd | Mondays 7:00 AM |
| `checkin` | launchd | Mondays 6:00 AM |
| `listener` | launchd | persistent (`KeepAlive`) |
| `cr-browser-session` | hand-run, once | — |

## Targets

### Install / update — `./setup.sh`

```bash
cd ~/data/web/wmpc/projects/court-reserve-scheduler
git pull && ./setup.sh
```

It builds the venv, installs dependencies and Playwright's Chromium, installs
the `ts/` node dependencies, creates `.env`, **installs and reloads all five
launchd agents from [`ts/ops/`](./ts/ops/)**, and walks the first-time Court
Reserve login. `./setup.sh --restore <bundle.tar.gz>` restores a prior install's
`.env`, history, browser profile, and booking logs.

**`setup.sh` installs the TS plists — never the Python ones.** It used to read
`ops/*.plist`, which meant a routine `git pull && ./setup.sh` silently undid a
completed [`ts/ops/cutover.sh`](./ts/ops/cutover.sh): the labels are identical,
so nothing looked wrong, and the next morning's 8 AM scheduler quietly dropped
from auto-book back to post-and-approve. To go back to Python deliberately, run
[`ts/ops/rollback.sh`](./ts/ops/rollback.sh) — never by re-running setup.

**The plists are templates, not literals.** `ts/ops/*.plist` hardcode
`/Users/notronwest/data/web/wmpc/projects/court-reserve-scheduler`, and
`install_plist()` rewrites that prefix to the actual install directory (and
`$HOME/Library`) with `sed` as it copies each one into `~/Library/LaunchAgents`.
So a checkout under a different directory name still works — but only because the
substitution happens at install time, which is why a **moved repo needs
`./setup.sh` re-run**, not just a `git pull`.

Uninstall: `./uninstall.sh` — unloads the agents, removes the plists and the logs
under `~/Library/Logs/court_reserve/`, and offers to delete the project
directory. It does not touch Discord, the Anthropic key, or Court Reserve itself.

### cr-browser-session — the part no deploy can recreate

The saved Chrome profile in `cache/chrome_profile/` **is** the Court Reserve
session. It is created by a human logging in through a real browser window and is
not in the repo. If it's missing or expired, every scheduled job fails at login
and the system looks broken in a way no redeploy fixes:

```bash
python cr_client.py --login
```

## Environments & variable scopes

One environment, one machine. Everything is **`ts/.env`** on that machine, plus
two committed policy files:

- **`ts/.env`** — `CRAPI_URL`/`CRAPI_KEY` for `courtreserve-api`, Discord webhook
  / bot token, Anthropic API key, and optionally `CR_STATE_DIR` (defaults to
  `../state`). Gitignored; see [`ts/.env.template`](./ts/.env.template). The
  repo-root `.env` still feeds the Python rollback path — keep both populated
  on the host.
- **`policy.json`** — booking policy the recommender applies; also the fallback
  seed for the standing weekly pattern (`fixed_events`, D-0056) when
  `courtreserve-api GET /fixed-events` and the local cache are both unavailable.
- **`courts.json`** — court inventory.
- **`state/fixed-events.json`** — last-good cache of the `GET /fixed-events`
  read, written on every successful fetch (not committed). On a failed read the
  scheduler falls back to this cache, then to `policy.json`'s seed, and posts a
  Discord alert either way. A row whose `until` has passed is dropped on every
  source, so a stale cache cannot resurrect a retired slot — see `CLAUDE.md` →
  The standing weekly pattern (D-0056).

Both JSON files are **committed**, so changing them is a code change and takes
effect on the next scheduled run — no restart needed for the cron-style jobs, but
the persistent `listener` needs a reload to pick up code changes.

**This is a single install, not a fleet install.** Unlike the daemon agents, the
scheduler has no host gate — whichever machine you run `./setup.sh` on starts
running the jobs. Running it on a second machine would double-book.

## Verify a deploy

```bash
./check.sh
```

Plus:

```bash
curl -s localhost:8787/health          # courtreserve-api must be up
launchctl list | grep com.whitemountain
```

The scheduler leaves two durable traces of each auto-book run: a confirmation
embed in Discord, and `logs/booking_log_<date>.json` listing every reservation
with its CR occurrence id.

Logs live under `~/Library/Logs/court_reserve/`.

## Roll back

`git checkout <earlier-commit>` and re-run `./setup.sh` — it reloads all five
agents. To stop a single job, `launchctl unload ~/Library/LaunchAgents/<label>.plist`.
To remove everything, `./uninstall.sh`.

To fall back from TypeScript to the Python jobs, run
[`ts/ops/rollback.sh`](./ts/ops/rollback.sh), which restores the plists backed up
under `~/Library/LaunchAgents/.python-plist-backup/`. Note that a later
`./setup.sh` re-installs the TS plists, so a rollback holds only until the next
setup run.

## Does NOT deploy from here

- **Pushing to `main`.** No CI. Merged code is live only after `./setup.sh` on
  the host.
- **The Court Reserve HTTP service.** [`courtreserve-api`](../courtreserve-api)
  is the shared service other apps call; it's a separate repo with its own
  launchd jobs and its own CR session. This repo is the *booking brain*, not the
  API.
- **`session-manager`'s CR scraping.** It imports `cr_client` from this repo as a
  **sibling checkout on disk** — that's a code dependency, not a deploy.
- **The browser session.** Never recreated by a deploy; a human has to log in.

## Deeper docs

- [`README.md`](./README.md) — quick start, manual setup, and what each piece does.
- [`docs/`](./docs/) — the TS rewrite plan and design notes.
- [`MANIFESTO.md`](./MANIFESTO.md) — intent.
- `../wmpc-meta/conventions/deployment-doc.md` — why this file exists and its shape.
