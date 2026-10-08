#!/usr/bin/env bash
# Source this file from build/test orchestration. Call gateway_heavy_job_end from the caller's
# EXIT trap so its existing cleanup still runs before releasing the shared host lock.

gateway_heavy_job_check_space() {
  local disk_path="${1:-/}"
  local minimum_bytes="${CODEX_GATEWAY_MIN_FREE_BYTES:-3221225472}"
  local reserve_bytes="${CODEX_GATEWAY_RESERVE_BYTES:-0}"
  local available_bytes required_bytes
  if [[ ! "$minimum_bytes" =~ ^[0-9]{1,15}$ ]] || [[ ! "$reserve_bytes" =~ ^[0-9]{1,15}$ ]]; then
    echo 'CODEX_GATEWAY_MIN_FREE_BYTES and CODEX_GATEWAY_RESERVE_BYTES must be nonnegative byte counts.' >&2
    return 2
  fi
  # Base 10 prevents a leading zero in a caller's setting from becoming shell octal syntax.
  required_bytes=$((10#$minimum_bytes + 10#$reserve_bytes))
  available_bytes="$(df -PB1 -- "$disk_path" | awk 'NR == 2 { print $4 }')" || return 2
  if [[ ! "$available_bytes" =~ ^[0-9]+$ ]]; then
    printf 'Cannot determine local free space at %s.\n' "$disk_path" >&2
    return 2
  fi
  printf '[heavy-job] disk=%s free_bytes=%s required_bytes=%s\n' \
    "$disk_path" "$available_bytes" "$required_bytes"
  if (( available_bytes < required_bytes )); then
    echo 'Insufficient local disk headroom for this heavy job; preserve space for live databases.' >&2
    return 2
  fi
}

gateway_heavy_job_begin() {
  local label="${1:-build-or-test}"
  local disk_path="${2:-/}"
  local lock_file="${CODEX_GATEWAY_HEAVY_LOCK_FILE:-/tmp/codex-gateway-heavy-${UID}.lock}"
  if [ -n "${gateway_heavy_job_lock_fd:-}" ]; then
    echo 'This process already owns a heavy-job lock.' >&2
    return 2
  fi
  if [[ "$lock_file" != /* ]] || [ -L "$lock_file" ] || \
    { [ -e "$lock_file" ] && [ ! -O "$lock_file" ]; }; then
    echo 'The heavy-job lock must be an absolute, non-symlink path owned by the current user.' >&2
    return 2
  fi
  (umask 077; : >> "$lock_file") || return 2
  exec {gateway_heavy_job_lock_fd}>>"$lock_file" || return 2
  if ! flock --nonblock "$gateway_heavy_job_lock_fd"; then
    exec {gateway_heavy_job_lock_fd}>&-
    unset gateway_heavy_job_lock_fd
    printf 'Another Gateway build/test is already using this host (%s). Retry after it finishes.\n' "$lock_file" >&2
    return 2
  fi
  if ! gateway_heavy_job_check_space "$disk_path"; then
    exec {gateway_heavy_job_lock_fd}>&-
    unset gateway_heavy_job_lock_fd
    return 2
  fi
  gateway_heavy_job_label="$label"
  gateway_heavy_job_started_at="$(date +%s)"
  printf '[heavy-job] start=%s label=%s\n' "$gateway_heavy_job_started_at" "$gateway_heavy_job_label"
}

gateway_heavy_job_end() {
  local status="${1:-0}"
  if [ -n "${gateway_heavy_job_lock_fd:-}" ]; then
    printf '[heavy-job] end label=%s status=%s elapsed_seconds=%s\n' \
      "$gateway_heavy_job_label" "$status" "$(( $(date +%s) - gateway_heavy_job_started_at ))"
    flock --unlock "$gateway_heavy_job_lock_fd"
    exec {gateway_heavy_job_lock_fd}>&-
    unset gateway_heavy_job_lock_fd
  fi
}
