#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# White Mountain Pickleball — Court Reserve Scheduler
# Uninstaller  (completely removes the scheduler from this Mac)
#
# Usage:
#   chmod +x uninstall.sh
#   ./uninstall.sh
#
# What this removes:
#   1. Stops and unloads all three launchd services
#   2. Deletes launchd plist files from ~/Library/LaunchAgents/
#   3. Deletes log files from ~/Library/Logs/court_reserve/
#   4. Optionally deletes the project directory (asks first)
#
# What this does NOT touch:
#   - Your Discord server, bot, or webhook
#   - Your Anthropic API key
#   - Court Reserve itself
#   - Any other apps on your computer
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}  ✓${RESET}  $*"; }
info() { echo -e "${CYAN}  →${RESET}  $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET}  $*"; }
err()  { echo -e "${RED}  ✗${RESET}  $*"; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/court_reserve"

echo -e "${BOLD}── White Mountain Pickleball — Uninstaller ─────────────────────────────${RESET}"
echo ""
warn "This will stop and remove the Court Reserve Scheduler from this Mac."
echo ""
read -r -p "  Are you sure you want to uninstall? [y/N] " confirm
echo ""

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  Uninstall cancelled."
    exit 0
fi

# ── 1. Stop and unload launchd services ──────────────────────────────────────
step "1. Stopping launchd services"

SERVICES=(
    "com.whitemountain.scheduler"
    "com.whitemountain.fetch-history"
    "com.whitemountain.listener"
)

for svc in "${SERVICES[@]}"; do
    plist="$PLIST_DIR/${svc}.plist"
    if launchctl list 2>/dev/null | grep -q "$svc"; then
        launchctl unload "$plist" 2>/dev/null && ok "Stopped: $svc" || err "Could not stop $svc (may already be stopped)"
    else
        info "$svc was not running"
    fi
done

# ── 2. Remove plist files ─────────────────────────────────────────────────────
step "2. Removing launchd plist files"

for svc in "${SERVICES[@]}"; do
    plist="$PLIST_DIR/${svc}.plist"
    if [[ -f "$plist" ]]; then
        rm -f "$plist"
        ok "Removed: $plist"
    else
        info "Not found: $plist"
    fi
done

# ── 3. Remove system log directory ───────────────────────────────────────────
step "3. Removing system logs"

if [[ -d "$LOG_DIR" ]]; then
    rm -rf "$LOG_DIR"
    ok "Removed: $LOG_DIR"
else
    info "Not found: $LOG_DIR"
fi

# ── 4. Optionally remove project directory ────────────────────────────────────
step "4. Project directory"

echo ""
echo "  Project directory: $INSTALL_DIR"
echo ""
echo "  This contains:"
echo "    • All scheduler code and scripts"
echo "    • Your .env credentials (Discord, Anthropic API key)"
echo "    • Browser session cache (Court Reserve login)"
echo "    • Attendance history and booking logs"
echo ""
warn "If you want to keep a backup, cancel and run 'make migrate' first."
echo ""
read -r -p "  Delete the entire project directory? [y/N] " confirm_dir
echo ""

if [[ "$confirm_dir" =~ ^[Yy]$ ]]; then
    # cd out of the project directory first so we can delete it
    cd "$HOME"
    rm -rf "$INSTALL_DIR"
    ok "Removed: $INSTALL_DIR"
    echo ""
    echo -e "${GREEN}${BOLD}Uninstall complete.${RESET} The scheduler has been fully removed from this Mac."
else
    echo "  Project directory kept at: $INSTALL_DIR"
    echo ""
    echo -e "${GREEN}${BOLD}Services uninstalled.${RESET} The scheduler will no longer run automatically."
    echo "  The project files remain — you can delete them manually or reinstall with: ./setup.sh"
fi

echo ""
