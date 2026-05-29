# White Mountain Pickleball — Court Reserve Scheduler
# Common operations. Run `make help` to see all commands.

SHELL  := /bin/bash
PYTHON := venv/bin/python
PIP    := venv/bin/pip

# Default DATE is 14 days out (the scheduler's booking horizon)
DATE   ?= $(shell python3 -c "from datetime import date,timedelta; d=date.today()+timedelta(14); print(f'{d.month}/{d.day}/{d.year}')")

.PHONY: help setup check test run dry-run show-prompt history logs status restart migrate push uninstall fix-imbalance fix-imbalance-execute

# ── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  White Mountain Pickleball — Court Reserve Scheduler"
	@echo ""
	@echo "  Daily operation:"
	@echo "    make status          Check all three launchd services"
	@echo "    make logs            Tail the Discord listener log"
	@echo "    make restart         Restart the Discord listener"
	@echo ""
	@echo "  Manual runs:"
	@echo "    make run             Recommend + book (14 days out: $(DATE))"
	@echo "    make run DATE=5/7/2026"
	@echo "    make dry-run         Preview recommendations (no booking)"
	@echo "    make dry-run DATE=5/7/2026"
	@echo "    make show-prompt     Print the AI prompt without calling the API"
	@echo "    make show-prompt DATE=5/7/2026"
	@echo "    make fix-imbalance         Preview AI/Intermediate fixes for next 14 days"
	@echo "    make fix-imbalance-execute Apply the fixes (cancel excess AI, add Intermediate)"
	@echo "    make history         Fetch 3 months of attendance history now"
	@echo ""
	@echo "  Setup & maintenance:"
	@echo "    make setup           Run the full setup script"
	@echo "    make check           Health check (env, services, API keys)"
	@echo "    make test            Live connectivity test (CR login, Discord, Anthropic)"
	@echo "    make migrate         Create a migration bundle for a new machine"
	@echo "    make uninstall       Completely remove the scheduler from this Mac"
	@echo "    make push            Push latest changes to GitHub"
	@echo ""

# ── Setup ─────────────────────────────────────────────────────────────────────
setup:
	chmod +x setup.sh && ./setup.sh

check:
	chmod +x check.sh && ./check.sh

test:
	$(PYTHON) test_connections.py

# ── Daily operation ───────────────────────────────────────────────────────────
status:
	@echo ""
	@launchctl list | grep whitemountain | \
	    awk '{status=$$1=="-"?"stopped":"running(pid "$$1")"; print "  "$$3": "status}' \
	    || echo "  No whitemountain services loaded"
	@echo ""

logs:
	tail -f logs/listener.log

restart:
	launchctl unload ~/Library/LaunchAgents/com.whitemountain.listener.plist
	launchctl load  ~/Library/LaunchAgents/com.whitemountain.listener.plist
	@echo "Listener restarted and running in background."
	@echo "Tailing log — Ctrl+C to stop watching (listener keeps running):"
	@sleep 2 && tail -f logs/listener.log

# ── Manual runs ───────────────────────────────────────────────────────────────
run:
	$(PYTHON) run.py $(DATE) --llm --book

dry-run:
	$(PYTHON) run.py $(DATE) --llm --dry-run

show-prompt:
	$(PYTHON) run.py $(DATE) --llm --show-prompt

history:
	$(PYTHON) fetch_history.py

# ── Migration ─────────────────────────────────────────────────────────────────
migrate:
	chmod +x migrate.sh && ./migrate.sh

# ── Imbalance fix ─────────────────────────────────────────────────────────────
fix-imbalance:
	$(PYTHON) fix_imbalance.py

fix-imbalance-execute:
	$(PYTHON) fix_imbalance.py --execute

# ── Uninstall ─────────────────────────────────────────────────────────────────
uninstall:
	chmod +x uninstall.sh && ./uninstall.sh

# ── Git ───────────────────────────────────────────────────────────────────────
push:
	git push origin main
