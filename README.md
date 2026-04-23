# CourtReserve Scheduler — White Mountain Pickleball

Automated scheduling system for Court Reserve. Generates AI-powered recommendations, posts them to Discord for approval, and books confirmed events automatically.

---

## Quick Start (new machine)

```bash
git clone git@github-notronwest:notronwest/CourtReserve-Scheduler.git
cd CourtReserve-Scheduler
chmod +x setup.sh
./setup.sh
```

The setup script handles everything: Python venv, dependencies, Playwright browser, `.env` creation, launchd service installation, and first-time Court Reserve login.

---

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| macOS | 12+ | — |
| Python | 3.9+ | `brew install python@3.13` |
| Git | any | `brew install git` |

---

## Manual Setup (step by step)

If you prefer to understand each step:

### 1. Clone and enter the repo
```bash
git clone git@github-notronwest:notronwest/CourtReserve-Scheduler.git
cd CourtReserve-Scheduler
```

### 2. Create virtual environment
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Install Playwright browser
```bash
python -m playwright install chromium
```

### 4. Create .env

```bash
cp .env.example .env
# Edit .env and fill in all four values
```

#### `DISCORD_WEBHOOK_URL`
The webhook is used to post recommendation and booking result embeds to your channel.

1. Open your Discord server → right-click the channel you want to use → **Edit Channel**
2. Go to **Integrations** → **Webhooks** → **New Webhook**
3. Give it a name (e.g. "Pickleball Scheduler"), confirm the channel, click **Copy Webhook URL**
4. Paste that URL as the value of `DISCORD_WEBHOOK_URL`

#### `DISCORD_BOT_TOKEN`
The bot token lets the listener read replies in the channel so it can detect approvals and commands.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → give it a name → **Create**
2. In the left sidebar, click **Bot**
3. Click **Reset Token** → confirm → copy the token that appears
4. On the same page, scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** (required to read message text)
5. Click **Save Changes**
6. To add the bot to your server: left sidebar → **OAuth2** → **URL Generator** → check `bot` scope → check `Read Messages/View Channels` + `Read Message History` permissions → open the generated URL and authorize it for your server
7. Paste the token as the value of `DISCORD_BOT_TOKEN`

#### `DISCORD_CHANNEL_ID`
This tells the listener which channel to watch for replies.

1. In Discord: **User Settings** → **Advanced** → turn on **Developer Mode**
2. Right-click the channel you're using → **Copy Channel ID**
3. Paste it as the value of `DISCORD_CHANNEL_ID`

> The webhook channel and the bot channel should be the same channel.

#### `ANTHROPIC_API_KEY`
Used for LLM-powered daily recommendations and `!book` / `!move` command parsing.

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Click **Create Key** → give it a name → copy the key (shown only once)
3. Paste it as the value of `ANTHROPIC_API_KEY`

> Cost: ~$0.001/day for daily recommendations (Claude Sonnet), ~$0.0002 per `!book`/`!move` command (Claude Haiku). Approval polling is free.

### 5. Create runtime directories
```bash
mkdir -p logs/screenshots cache/chrome_profile history
mkdir -p ~/Library/Logs/court_reserve
```

### 6. Log into Court Reserve
The scheduler uses a saved browser session. Run this once to log in:
```bash
venv/bin/python - <<'EOF'
from cr_client import browser_session
import time
with browser_session(headless=False) as page:
    page.goto("https://app.courtreserve.com")
    print("Log in to Court Reserve, then close this script with Ctrl+C")
    time.sleep(300)
EOF
```
Log in with your Court Reserve admin credentials. Your session is saved to `cache/chrome_profile/` and reused on every subsequent run — you won't need to log in again unless the session expires.

### 7. Install launchd services
```bash
# Substitute your actual install path
INSTALL_DIR="$(pwd)"

for plist in ops/com.whitemountain.*.plist; do
    name="$(basename "$plist")"
    sed "s|/Users/notronwest/data/court_reserve_scheduling|${INSTALL_DIR}|g; \
         s|/Users/notronwest/Library|${HOME}/Library|g" \
        "$plist" > ~/Library/LaunchAgents/"$name"
    launchctl load ~/Library/LaunchAgents/"$name"
done
```

---

## Services

Three launchd agents run in the background:

| Service | Schedule | What it does |
|---|---|---|
| `com.whitemountain.scheduler` | Daily 8:00 AM | Generates recommendations, posts to Discord, saves pending state |
| `com.whitemountain.listener` | Always on | Polls Discord every 3s — approves recommendations, handles `!book` commands |
| `com.whitemountain.fetch-history` | Mondays 7:00 AM | Fetches 3 months of attendance history from Court Reserve |

### Managing services
```bash
# Check status
launchctl list | grep whitemountain

# Restart listener after a code change
launchctl unload ~/Library/LaunchAgents/com.whitemountain.listener.plist
launchctl load  ~/Library/LaunchAgents/com.whitemountain.listener.plist

# View logs
tail -f ~/Library/Logs/court_reserve/listener.log       # or listener.log in logs/
tail -f ~/Library/Logs/court_reserve/scheduler_*.log
```

---

## Daily workflow

At 8:00 AM the scheduler runs automatically and posts recommendations to Discord:

```
🏓 Schedule Recommendations — Friday, April 24 2026
1. 🔵 9:00 AM – 11:00 AM  Court #3 — Co-Ed Advanced Beginner Open Play
2. 🟡 11:00 AM – 1:00 PM  Court #4 — Co-ed Intermediate Open Play
3. 🔴 2:00 PM – 4:00 PM   Courts #1 & #2 — Co-ed Advanced Open Play  (max 8)
```

Reply anytime (no timeout):
```
all         → book everything
1,3         → book specific items
none        → skip all
```

---

## Ad-hoc bookings via Discord

Send a `!book` command at any time:

```
!book Intermediate open play 4/28 at 2pm Court 3
!book Advanced Open Play Saturday 5/2 noon Courts 3 and 4
!book beginner tuesday at 10am court 1
```

The bot replies with a preview embed. Reply `confirm` to book or `cancel` to skip.

Cost: ~$0.0002 per command (Claude haiku). Daily recommendation polling is free.

---

## Manual runs

```bash
cd /path/to/CourtReserve-Scheduler
source venv/bin/activate

# Recommend + book (posts to Discord, waits for your reply)
python run.py 4/28/2026 --llm --book

# Dry run (posts preview to Discord, doesn't book)
python run.py 4/28/2026 --llm --dry-run

# Recommend only (no Discord, no booking)
python run.py 4/28/2026

# Fix a court assignment
python run.py fix 4/28/2026 --event-id 1633147 --start '2:00 PM' --court 1
```

---

## Project layout

```
CourtReserve-Scheduler/
├── run.py                  Main CLI entry point
├── recommender.py          Recommendation engine (rule-based + LLM hybrid)
├── llm_ranker.py           Claude API for Pass 1+2 recommendations
├── llm_parser.py           Claude haiku parser for !book commands
├── book_event.py           Playwright automation for Court Reserve
├── cr_client.py            Court Reserve API client
├── discord_notify.py       Discord webhook integration
├── discord_listener.py     Persistent listener (approval + !book)
├── history_analysis.py     Attendance history analysis
├── fetch_history.py        Fetches history from Court Reserve
├── policy.json             All business rules (edit this, not the code)
├── policy_loader.py        Shared policy loader
├── requirements.txt        Python dependencies
├── setup.sh                Setup script for new machines
├── .env.example            Environment variable template
├── .env                    Your credentials (never committed)
│
├── logs/                   Runtime logs and booking records
│   ├── booking_log_*.json  Per-day booking results
│   ├── listener.log        Discord listener log
│   ├── screenshots/        Playwright screenshots (audit trail)
│   ├── pending_approval.json  State shared between scheduler and listener
│   └── listener_state.json   Listener cursor and pending !book state
│
├── history/                Court Reserve attendance history
│   └── history_latest.json Used by recommender for popularity scoring
│
├── cache/
│   └── chrome_profile/     Saved Court Reserve browser session
│
├── scripts/                launchd shell wrappers
│   ├── run_scheduler.sh
│   ├── run_listener.sh
│   └── run_fetch_history.sh
│
└── ops/                    launchd plist templates
    ├── com.whitemountain.scheduler.plist
    ├── com.whitemountain.listener.plist
    └── com.whitemountain.fetch-history.plist
```

---

## Configuration

All business rules live in `policy.json`. Edit this file to change:
- Approved events and their IDs
- Two-court priority pairs
- Utilization targets and operating windows
- Fixed events (always on the schedule)
- LLM model and cost settings
- Multi-court MaxPeople limits

The code reads policy at runtime — no redeploy needed for policy changes.

---

## GitHub SSH setup (two accounts)

This repo uses a custom SSH host alias so pushes authenticate as `notronwest`
rather than the default `wmpc-nh` account.

`~/.ssh/config`:
```
# wmpc-nh (default)
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519

# notronwest
Host github-notronwest
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_notronwest
```

Clone with:
```bash
git clone git@github-notronwest:notronwest/CourtReserve-Scheduler.git
```

---

## Troubleshooting

**Listener not starting**
```bash
cat ~/Library/Logs/court_reserve/launchd_listener_err.log
```

**Scheduler timed out / nothing posted to Discord**
```bash
cat ~/Library/Logs/court_reserve/scheduler_$(date +%Y-%m-%d).log
```

**Court Reserve session expired (browser keeps asking to log in)**
```bash
rm -rf cache/chrome_profile
# Re-run the login step from section 6
```

**`No module named 'dotenv'` or similar**
```bash
source venv/bin/activate
pip install -r requirements.txt
```

**launchd exit code 78 (EX_CONFIG)**  
The plist path is wrong — re-run `setup.sh` or check that the path in  
`~/Library/LaunchAgents/com.whitemountain.*.plist` matches your install directory.
