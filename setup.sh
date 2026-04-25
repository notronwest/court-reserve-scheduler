#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# White Mountain Pickleball — Court Reserve Scheduler
# Setup script for macOS
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# What this does:
#   1. Checks prerequisites (macOS, Python 3.9+)
#   2. Creates a Python virtual environment and installs dependencies
#   3. Installs Playwright browser (Chromium)
#   4. Creates .env from .env.example if it doesn't exist
#   5. Installs and loads the three launchd services
#   6. Opens Court Reserve in a browser window so you can log in (first time only)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}  ✓${RESET}  $*"; }
info() { echo -e "${CYAN}  →${RESET}  $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET}  $*"; }
err()  { echo -e "${RED}  ✗${RESET}  $*"; exit 1; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

# ── Paths ─────────────────────────────────────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
VENV="$INSTALL_DIR/venv"
PYTHON_MIN="3.9"
RESTORE_BUNDLE=""

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --restore)
            shift
            RESTORE_BUNDLE="${1:-}"
            [[ -z "$RESTORE_BUNDLE" ]] && { echo "Usage: ./setup.sh --restore <bundle.tar.gz>"; exit 1; }
            shift
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

step "── White Mountain Pickleball — Scheduler Setup ─────────────────────────"
info "Install directory: $INSTALL_DIR"

# ── 0. Restore migration bundle (if provided) ─────────────────────────────────
if [[ -n "$RESTORE_BUNDLE" ]]; then
    step "0. Restoring migration bundle"

    [[ ! -f "$RESTORE_BUNDLE" ]] && err "Bundle not found: $RESTORE_BUNDLE"

    STAGING="$(mktemp -d)"
    tar -xzf "$RESTORE_BUNDLE" -C "$STAGING"

    # .env
    if [[ -f "$STAGING/.env" ]]; then
        cp "$STAGING/.env" "$INSTALL_DIR/.env"
        ok ".env restored"
    else
        warn "No .env in bundle — you will be prompted to fill it in"
    fi

    # History data
    if [[ -d "$STAGING/history" ]]; then
        mkdir -p "$INSTALL_DIR/history"
        cp -r "$STAGING/history/." "$INSTALL_DIR/history/"
        n=$(ls "$INSTALL_DIR/history/"*.json 2>/dev/null | wc -l | tr -d ' ')
        ok "History restored ($n file(s))"
    fi

    # Chrome profile (Court Reserve session)
    if [[ -d "$STAGING/chrome_profile" ]]; then
        mkdir -p "$INSTALL_DIR/cache"
        cp -r "$STAGING/chrome_profile" "$INSTALL_DIR/cache/chrome_profile"
        ok "Browser profile restored — will attempt to reuse Court Reserve session"
    fi

    # Booking logs
    if [[ -d "$STAGING/booking_logs" ]]; then
        mkdir -p "$INSTALL_DIR/logs"
        cp "$STAGING/booking_logs/"*.json "$INSTALL_DIR/logs/" 2>/dev/null || true
        ok "Booking logs restored"
    fi

    rm -rf "$STAGING"
    info "Bundle applied — continuing with setup"
fi

# ── 1. Platform check ─────────────────────────────────────────────────────────
step "1. Checking prerequisites"

if [[ "$(uname -s)" != "Darwin" ]]; then
    err "This setup script requires macOS (uses launchd for scheduling)."
fi
ok "macOS detected"

# Find Python 3.9+
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate" &>/dev/null; then
        version="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
        major="${version%%.*}"; minor="${version##*.}"
        min_minor="${PYTHON_MIN##*.}"
        if [[ "$major" -ge 3 && "$minor" -ge "$min_minor" ]]; then
            PYTHON="$candidate"
            break
        fi
    fi
done
[[ -z "$PYTHON" ]] && err "Python $PYTHON_MIN or later is required. Install via: brew install python@3.13"
ok "Python $("$PYTHON" --version 2>&1 | awk '{print $2}') found at $(which "$PYTHON")"

# ── 2. Virtual environment ────────────────────────────────────────────────────
step "2. Setting up virtual environment"
cd "$INSTALL_DIR"

if [[ ! -d "$VENV" ]]; then
    info "Creating venv..."
    "$PYTHON" -m venv "$VENV"
    ok "Virtual environment created"
else
    ok "Virtual environment already exists"
fi

# Activate
# shellcheck disable=SC1091
source "$VENV/bin/activate"

info "Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -r "$INSTALL_DIR/requirements.txt"
ok "Dependencies installed"

# ── 3. Playwright browser ─────────────────────────────────────────────────────
step "3. Installing Playwright browser"

if python -c "from playwright.sync_api import sync_playwright; sync_playwright().__enter__().chromium.launch().close()" 2>/dev/null; then
    ok "Playwright Chromium already installed"
else
    info "Installing Playwright Chromium (this takes ~2 minutes)..."
    python -m playwright install chromium
    ok "Playwright Chromium installed"
fi

# ── 4. Environment file ───────────────────────────────────────────────────────
step "4. Environment configuration"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    warn ".env created from template — you MUST fill in these values before running:"
    echo ""
    echo "      $INSTALL_DIR/.env"
    echo ""
    echo "  Required values:"
    echo "    CR_BASE_URL          — https://app.courtreserve.com"
    echo "    CR_EMAIL             — your Court Reserve admin email"
    echo "    CR_USERNAME          — your Court Reserve admin email"
    echo "    CR_PASSWORD          — your Court Reserve admin password"
    echo "    DISCORD_WEBHOOK_URL  — webhook URL from Server Settings → Integrations"
    echo "    DISCORD_BOT_TOKEN    — bot token from discord.com/developers"
    echo "    DISCORD_CHANNEL_ID   — right-click channel → Copy Channel ID"
    echo "    ANTHROPIC_API_KEY    — from console.anthropic.com/settings/keys"
    echo ""
    read -r -p "  Press Enter once you have filled in .env, or Ctrl+C to exit and do it now... "
else
    ok ".env already exists"
fi

# Validate required keys are non-empty
required_keys=(CR_BASE_URL CR_EMAIL CR_PASSWORD DISCORD_WEBHOOK_URL DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID ANTHROPIC_API_KEY)
missing=()
while IFS='=' read -r key _; do
    [[ "$key" =~ ^# ]] && continue
    [[ -z "$key" ]] && continue
    :
done < "$INSTALL_DIR/.env"

for key in "${required_keys[@]}"; do
    value="$(grep "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'\''[:space:]')"
    if [[ -z "$value" || "$value" == *"your_"* || "$value" == *"YOUR_"* ]]; then
        missing+=("$key")
    fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
    warn "The following keys in .env still have placeholder values:"
    for k in "${missing[@]}"; do echo "    • $k"; done
    warn "The scheduler will not work correctly until these are set."
fi

# ── 5. Required directories ───────────────────────────────────────────────────
step "5. Creating runtime directories"
mkdir -p "$INSTALL_DIR/logs/screenshots"
mkdir -p "$INSTALL_DIR/cache/chrome_profile"
mkdir -p "$INSTALL_DIR/history"
mkdir -p "$HOME/Library/Logs/court_reserve"
ok "Directories ready"

# ── 6. launchd agents ────────────────────────────────────────────────────────
step "6. Installing launchd agents"
mkdir -p "$PLIST_DIR"

install_plist() {
    local name="$1"
    local src="$INSTALL_DIR/ops/${name}.plist"
    local dst="$PLIST_DIR/${name}.plist"

    if [[ ! -f "$src" ]]; then
        warn "Plist not found: $src — skipping"
        return
    fi

    # Substitute install path and username into plist
    sed \
        -e "s|/Users/notronwest/data/court_reserve_scheduling|${INSTALL_DIR}|g" \
        -e "s|/Users/notronwest/Library|${HOME}/Library|g" \
        "$src" > "$dst"

    # Unload first if already loaded (ignore errors)
    launchctl unload "$dst" 2>/dev/null || true
    launchctl load "$dst"
    ok "Loaded: $name"
}

install_plist "com.whitemountain.scheduler"
install_plist "com.whitemountain.fetch-history"
install_plist "com.whitemountain.listener"

# ── 7. Court Reserve login (first time) ──────────────────────────────────────
step "7. Court Reserve browser login"

if [[ -f "$INSTALL_DIR/cache/chrome_profile/Default/Cookies" ]]; then
    ok "Browser profile already exists — Court Reserve session likely saved"
else
    info "Opening Court Reserve in a browser window so you can log in."
    info "After logging in, close the browser — your session will be saved."
    echo ""
    read -r -p "  Press Enter to open the browser now (or Ctrl+C to do it later)... "
    python "$INSTALL_DIR/cr_client.py" --login 2>/dev/null || \
    python - <<'PYEOF'
import sys
sys.path.insert(0, '.')
from cr_client import browser_session
import time
print("  Browser opening... Log into Court Reserve, then close this window.")
with browser_session(headless=False) as page:
    page.goto("https://app.courtreserve.com")
    print("  Waiting for you to log in and close the browser...")
    try:
        page.wait_for_url("**/Dashboard**", timeout=300000)
        print("  Login detected — saving session.")
        time.sleep(2)
    except Exception:
        pass
PYEOF
    ok "Browser session saved"
fi

# ── 8. Smoke test ─────────────────────────────────────────────────────────────
step "8. Smoke test"

info "Checking listener is running..."
if launchctl list | grep -q "com.whitemountain.listener"; then
    ok "Discord listener is running"
else
    warn "Listener not detected — check: $HOME/Library/Logs/court_reserve/launchd_listener_err.log"
fi

info "Checking scheduler is scheduled..."
if launchctl list | grep -q "com.whitemountain.scheduler"; then
    ok "Daily scheduler is loaded (runs at 8:00 AM)"
fi

info "Checking history fetcher..."
if launchctl list | grep -q "com.whitemountain.fetch-history"; then
    ok "History fetcher is loaded (runs Mondays at 7:00 AM)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Setup complete!${RESET}"
echo ""
echo "  Daily scheduler:   runs at 8:00 AM, books 14 days out"
echo "  Discord listener:  always running — reply to approve recommendations"
echo "  History fetch:     runs every Monday at 7:00 AM"
echo ""
echo "  Manual run:  cd $INSTALL_DIR"
echo "               venv/bin/python run.py 4/28/2026 --llm --book"
echo ""
echo "  Discord commands:"
echo "    all / 1,3,5 / none  — approve daily recommendations"
echo "    !book <request>     — add an event ad-hoc"
echo ""
echo "  Logs:"
echo "    $HOME/Library/Logs/court_reserve/"
echo "    $INSTALL_DIR/logs/"
echo ""
