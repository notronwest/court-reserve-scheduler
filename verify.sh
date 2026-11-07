#!/usr/bin/env bash
# Release gate (D-0293): run from the release clone after setup.sh. Exit 0 is the only pass.
# Wraps check.sh, which exits with its failure count; warnings (a quiet listener log,
# no booking log yet) do not fail a release.
set -uo pipefail
cd "$(dirname "$0")"
exec ./check.sh
