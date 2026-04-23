#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# White Mountain Pickleball — Court Reserve Scheduler
# Migration bundle creator  (run on the OLD machine)
#
# Usage:
#   chmod +x migrate.sh
#   ./migrate.sh
#
# Creates: migration_YYYYMMDD.tar.gz
# Transfer it to the new machine, then run:
#   ./setup.sh --restore migration_YYYYMMDD.tar.gz
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}  ✓${RESET}  $*"; }
info() { echo -e "${CYAN}  →${RESET}  $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET}  $*"; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_NAME="migration_$(date '+%Y%m%d').tar.gz"
BUNDLE_PATH="$INSTALL_DIR/$BUNDLE_NAME"
STAGING="$(mktemp -d)"

step "── White Mountain Pickleball — Migration Bundle Creator ─────────────────"
info "Source directory: $INSTALL_DIR"
info "Bundle: $BUNDLE_PATH"

# ── .env (required) ──────────────────────────────────────────────────────────
step "1. Bundling credentials (.env)"
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    echo -e "${RED}  ✗${RESET}  .env not found — run setup.sh first"
    exit 1
fi
cp "$INSTALL_DIR/.env" "$STAGING/.env"
ok ".env included"

# ── history/ (3-month attendance data) ───────────────────────────────────────
step "2. Bundling history data"
if [[ -d "$INSTALL_DIR/history" ]] && compgen -G "$INSTALL_DIR/history/*.json" > /dev/null 2>&1; then
    cp -r "$INSTALL_DIR/history" "$STAGING/history"
    n=$(ls "$STAGING/history/"*.json 2>/dev/null | wc -l | tr -d ' ')
    ok "History: $n JSON file(s) included"
else
    warn "No history files found — recommendations will have no popularity data for ~1 week"
    mkdir -p "$STAGING/history"
fi

# ── Chrome profile (saved Court Reserve session) ─────────────────────────────
step "3. Bundling browser session (Court Reserve login)"
PROFILE_DIR="$INSTALL_DIR/cache/chrome_profile"
if [[ -d "$PROFILE_DIR" ]] && [[ -n "$(ls -A "$PROFILE_DIR" 2>/dev/null)" ]]; then
    cp -r "$PROFILE_DIR" "$STAGING/chrome_profile"
    size=$(du -sh "$STAGING/chrome_profile" 2>/dev/null | cut -f1)
    ok "Chrome profile included ($size) — you may not need to re-login"
    warn "Browser profile portability is best-effort; you may still be prompted to log in"
else
    warn "No browser profile found — you will need to log into Court Reserve on the new machine"
    warn "(setup.sh handles this automatically)"
fi

# ── booking logs (audit trail, optional) ─────────────────────────────────────
step "4. Bundling booking history logs"
if compgen -G "$INSTALL_DIR/logs/booking_log_*.json" > /dev/null 2>&1; then
    mkdir -p "$STAGING/booking_logs"
    cp "$INSTALL_DIR/logs/booking_log_"*.json "$STAGING/booking_logs/"
    n=$(ls "$STAGING/booking_logs/"*.json 2>/dev/null | wc -l | tr -d ' ')
    ok "Booking logs: $n file(s) included"
else
    warn "No booking logs found — skipping"
fi

# ── Create archive ────────────────────────────────────────────────────────────
step "5. Creating archive"
tar -czf "$BUNDLE_PATH" -C "$STAGING" .
rm -rf "$STAGING"

size=$(du -sh "$BUNDLE_PATH" | cut -f1)
ok "Bundle created: $BUNDLE_NAME ($size)"

# ── Transfer instructions ─────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo ""
echo "  1. Transfer the bundle to the new machine:"
echo "     scp $BUNDLE_PATH newmachine:~/"
echo ""
echo "  2. On the new machine, clone the repo and run setup with restore:"
echo "     git clone git@github-notronwest:notronwest/CourtReserve-Scheduler.git"
echo "     cd CourtReserve-Scheduler"
echo "     chmod +x setup.sh"
echo "     ./setup.sh --restore ~/migration_$(date '+%Y%m%d').tar.gz"
echo ""
echo -e "  ${YELLOW}⚠  The bundle contains your .env credentials — treat it like a password file.${RESET}"
echo -e "  ${YELLOW}   Delete it from both machines once the migration is confirmed working.${RESET}"
echo ""
