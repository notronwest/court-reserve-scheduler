#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# White Mountain Pickleball — Court Reserve Scheduler
# Health check  (run any time to verify the install is working)
#
# Usage:
#   chmod +x check.sh
#   ./check.sh
# ─────────────────────────────────────────────────────────────────────────────

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
fail()  { echo -e "  ${RED}✗${RESET}  $*"; FAILURES=$((FAILURES+1)); }
warn()  { echo -e "  ${YELLOW}⚠${RESET}  $*"; WARNINGS=$((WARNINGS+1)); }
info()  { echo -e "  ${CYAN}→${RESET}  $*"; }
head()  { echo -e "\n${BOLD}$*${RESET}"; }

FAILURES=0
WARNINGS=0

echo -e "${BOLD}── White Mountain Pickleball — Health Check ─────────────────────────────${RESET}"

# ── Python & venv ─────────────────────────────────────────────────────────────
head "Python environment"
VENV="$INSTALL_DIR/venv"

if [[ -d "$VENV" ]]; then
    pass "Virtual environment exists"
else
    fail "Virtual environment missing — run ./setup.sh"
fi

if [[ -f "$VENV/bin/python" ]]; then
    version="$("$VENV/bin/python" --version 2>&1)"
    pass "Python: $version"
else
    fail "Python not found in venv"
fi

for pkg in anthropic playwright dotenv requests; do
    if "$VENV/bin/python" -c "import $pkg" 2>/dev/null; then
        ver=$("$VENV/bin/pip" show "$pkg" 2>/dev/null | grep "^Version:" | awk '{print $2}')
        pass "$pkg $ver"
    else
        fail "$pkg not installed — run: venv/bin/pip install -r requirements.txt"
    fi
done

# Playwright browser
if "$VENV/bin/python" -c "
from playwright.sync_api import sync_playwright
p = sync_playwright().__enter__()
b = p.chromium.launch()
b.close()
p.__exit__(None,None,None)
" 2>/dev/null; then
    pass "Playwright Chromium installed"
else
    fail "Playwright Chromium missing — run: venv/bin/python -m playwright install chromium"
fi

# ── .env ─────────────────────────────────────────────────────────────────────
head ".env credentials"
ENV="$INSTALL_DIR/.env"

if [[ ! -f "$ENV" ]]; then
    fail ".env missing — run ./setup.sh or copy from another machine"
else
    pass ".env exists"
    required_keys=(CR_BASE_URL CR_EMAIL CR_PASSWORD DISCORD_WEBHOOK_URL DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID ANTHROPIC_API_KEY)
    for key in "${required_keys[@]}"; do
        value="$(grep "^${key}=" "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'\''[:space:]')"
        if [[ -z "$value" || "$value" == *"your_"* || "$value" == *"YOUR_"* ]]; then
            fail "$key is not set or still has placeholder value"
        else
            masked="${value:0:8}…"
            pass "$key = $masked"
        fi
    done
fi

# ── Directories ───────────────────────────────────────────────────────────────
head "Runtime directories"
for dir in logs logs/screenshots cache history; do
    if [[ -d "$INSTALL_DIR/$dir" ]]; then
        pass "$dir/"
    else
        warn "$dir/ missing — will be created on first run"
    fi
done

if [[ -d "$INSTALL_DIR/cache/chrome_profile" ]] && [[ -n "$(ls -A "$INSTALL_DIR/cache/chrome_profile" 2>/dev/null)" ]]; then
    pass "cache/chrome_profile/ (Court Reserve session saved)"
else
    warn "cache/chrome_profile/ empty — will be prompted to log in to Court Reserve"
fi

if [[ -f "$INSTALL_DIR/history/history_latest.json" ]]; then
    age_days=$(( ( $(date +%s) - $(stat -f %m "$INSTALL_DIR/history/history_latest.json") ) / 86400 ))
    if [[ $age_days -le 7 ]]; then
        pass "history_latest.json ($age_days day(s) old)"
    else
        warn "history_latest.json is $age_days day(s) old — consider running: make history"
    fi
else
    warn "history_latest.json missing — recommendations will have no popularity data until Monday's fetch"
fi

# ── launchd services ─────────────────────────────────────────────────────────
head "launchd services"
for svc in com.whitemountain.listener com.whitemountain.scheduler com.whitemountain.fetch-history; do
    plist="$HOME/Library/LaunchAgents/${svc}.plist"
    if [[ ! -f "$plist" ]]; then
        fail "$svc.plist not installed — run ./setup.sh"
        continue
    fi
    # Check if loaded
    if launchctl list 2>/dev/null | grep -q "$svc"; then
        pid=$(launchctl list 2>/dev/null | grep "$svc" | awk '{print $1}')
        if [[ "$pid" == "-" ]]; then
            warn "$svc loaded but not running (will start on next trigger)"
        else
            pass "$svc running (pid $pid)"
        fi
    else
        fail "$svc not loaded — run: launchctl load $plist"
    fi
done

# ── Discord connectivity ──────────────────────────────────────────────────────
head "Discord connectivity"
if [[ -f "$ENV" ]]; then
    WEBHOOK_URL="$(grep "^DISCORD_WEBHOOK_URL=" "$ENV" | cut -d= -f2- | tr -d '"'\''[:space:]')"
    BOT_TOKEN="$(grep "^DISCORD_BOT_TOKEN=" "$ENV" | cut -d= -f2- | tr -d '"'\''[:space:]')"

    if [[ -n "$WEBHOOK_URL" && "$WEBHOOK_URL" != *"YOUR_"* ]]; then
        http_code=$(curl -s -o /dev/null -w "%{http_code}" "$WEBHOOK_URL" 2>/dev/null || echo "000")
        if [[ "$http_code" == "200" ]]; then
            pass "Discord webhook reachable"
        else
            fail "Discord webhook returned HTTP $http_code — check DISCORD_WEBHOOK_URL"
        fi
    else
        warn "DISCORD_WEBHOOK_URL not set — skipping webhook check"
    fi

    if [[ -n "$BOT_TOKEN" && "$BOT_TOKEN" != *"your_"* ]]; then
        http_code=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Authorization: Bot $BOT_TOKEN" \
            "https://discord.com/api/v10/users/@me" 2>/dev/null || echo "000")
        if [[ "$http_code" == "200" ]]; then
            pass "Discord bot token valid"
        else
            fail "Discord bot token returned HTTP $http_code — check DISCORD_BOT_TOKEN"
        fi
    else
        warn "DISCORD_BOT_TOKEN not set — skipping bot check"
    fi
else
    warn "No .env — skipping Discord checks"
fi

# ── Anthropic API ─────────────────────────────────────────────────────────────
head "Anthropic API"
if [[ -f "$ENV" ]]; then
    ANTHROPIC_KEY="$(grep "^ANTHROPIC_API_KEY=" "$ENV" | cut -d= -f2- | tr -d '"'\''[:space:]')"
    if [[ -n "$ANTHROPIC_KEY" && "$ANTHROPIC_KEY" != *"your_"* ]]; then
        result=$("$VENV/bin/python" - <<PYEOF 2>&1
import anthropic, os
os.environ["ANTHROPIC_API_KEY"] = "$ANTHROPIC_KEY"
c = anthropic.Anthropic()
r = c.messages.create(model="claude-haiku-4-5", max_tokens=5, messages=[{"role":"user","content":"hi"}])
print("ok")
PYEOF
        )
        if [[ "$result" == "ok" ]]; then
            pass "Anthropic API key valid"
        else
            fail "Anthropic API call failed — check ANTHROPIC_API_KEY"
        fi
    else
        warn "ANTHROPIC_API_KEY not set — skipping API check"
    fi
else
    warn "No .env — skipping Anthropic check"
fi

# ── Recent activity ───────────────────────────────────────────────────────────
head "Recent activity"
latest_booking=$(ls -t "$INSTALL_DIR/logs/booking_log_"*.json 2>/dev/null | head -1)
if [[ -n "$latest_booking" ]]; then
    bname=$(basename "$latest_booking")
    pass "Latest booking log: $bname"
else
    warn "No booking logs found yet"
fi

if [[ -f "$INSTALL_DIR/logs/listener.log" ]]; then
    last_line=$(tail -1 "$INSTALL_DIR/logs/listener.log" 2>/dev/null)
    pass "Listener log last entry: ${last_line:0:80}"
else
    warn "No listener log yet"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}────────────────────────────────────────────────────────────────────────────${RESET}"
if [[ $FAILURES -eq 0 && $WARNINGS -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All checks passed!${RESET}"
elif [[ $FAILURES -eq 0 ]]; then
    echo -e "${YELLOW}${BOLD}$WARNINGS warning(s) — system operational but review above${RESET}"
else
    echo -e "${RED}${BOLD}$FAILURES failure(s), $WARNINGS warning(s) — action required${RESET}"
fi
echo ""
exit $FAILURES
