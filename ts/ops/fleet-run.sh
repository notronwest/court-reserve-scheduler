# Sourced by the launchd wrappers. Reports "started" / "finished" to the fleet recorder
# (daemon run-report.sh, D-0154) and can never hold up a booking:
#   - both calls are timeboxed to 2s and their result ignored (rule 2); a start that does not
#     answer in time is killed, WMPC_RUN_ID stays unset, and the end call is a no-op.
#   - every function returns 0 and prints nothing to the caller's stdout.
# Env overrides (tests): WMPC_DAEMON_DIR, WMPC_FLEET_START_TIMEBOX (tenths of a second).

_fleet_recorder() {
  printf '%s' "${WMPC_DAEMON_DIR:-$HOME/data/web/wmpc/projects/daemon}/infrastructure/heartbeat/run-report.sh"
}

# _fleet_call <stdout-file> <args...> — run the recorder, killed after the timebox.
_fleet_call() {
  local out="$1" rec pid i max="${WMPC_FLEET_START_TIMEBOX:-20}"; shift
  rec="$(_fleet_recorder)"
  [ -f "$rec" ] || return 1
  bash "$rec" "$@" > "$out" 2>/dev/null </dev/null &
  pid=$!
  for ((i = 0; i < max; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  pkill -P "$pid" 2>/dev/null   # the recorder's own children, so none outlive the timebox
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return 1
}

# fleet_run_start <job> [summary...] — call AFTER any host gate / lock, once there is work to do.
fleet_run_start() {
  local out
  unset WMPC_RUN_ID   # never close a run this wrapper did not open
  out="$(mktemp 2>/dev/null)" || return 0
  if _fleet_call "$out" start "$@"; then
    WMPC_RUN_ID="$(head -n 1 "$out" 2>/dev/null)"
    [ -n "$WMPC_RUN_ID" ] && export WMPC_RUN_ID
  fi
  rm -f "$out" 2>/dev/null
  return 0
}

# fleet_run_end <job> <ok|degraded|failed> [summary...]
fleet_run_end() {
  [ -n "${WMPC_RUN_ID:-}" ] || return 0
  _fleet_call /dev/null end "$@"
  return 0
}
