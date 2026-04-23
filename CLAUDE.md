# CourtReserve Scheduler — CLAUDE.md

Automated scheduling system for White Mountain Pickleball Club.
Generates AI-powered recommendations, posts them to Discord for approval,
and books confirmed events on Court Reserve automatically.

## Architecture

Three launchd agents run persistently on macOS:

| Service | When | What |
|---|---|---|
| `com.whitemountain.scheduler` | Daily 8:00 AM | LLM recommendations → Discord → saves `pending_approval.json` |
| `com.whitemountain.listener` | Always-on | Polls Discord every 3s — approves recommendations, handles `!book`/`!move`/`!schedule`/`!help` |
| `com.whitemountain.fetch-history` | Mondays 7:00 AM | Fetches 3 months of attendance history |

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

## Hard Constraints (policy.json)

1. No same-court overlap with existing events
2. One primary court per recommended booking
3. Max 2 occurrences of same event per day
4. **2-hour minimum gap between same-event occurrences** (no back-to-back)
5. All 5 skill levels covered when possible
6. Fill toward 60% utilization target

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

## Environment Variables

Stored in `.env` (never committed):

```
DISCORD_WEBHOOK_URL   # Webhook for posting embeds
DISCORD_BOT_TOKEN     # Bot token for reading channel messages
DISCORD_CHANNEL_ID    # Channel ID for the listener
ANTHROPIC_API_KEY     # Claude API for LLM recommendations + !book parsing
```

Court Reserve credentials live in `cache/chrome_profile/` (Playwright persistent context).

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
