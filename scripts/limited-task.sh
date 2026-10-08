#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 command [arguments...]" >&2
  exit 2
fi

cpu_count="${CODEX_GATEWAY_TASK_CPUS:-2}"
if [[ ! "$cpu_count" =~ ^[1-9][0-9]{0,2}$ ]]; then
  echo 'CODEX_GATEWAY_TASK_CPUS must be a positive integer below 1000.' >&2
  exit 2
fi
for required_command in taskset nice; do
  if ! command -v "$required_command" >/dev/null; then
    printf 'The build/test environment requires %s for process resource protection.\n' "$required_command" >&2
    exit 2
  fi
done

# Restrict the actual worker's affinity before it spawns compiler/browser children. Restricting
# the host-side Docker CLI would not constrain daemon-created container processes.
allowed_cpus="$(awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)"
IFS=',' read -r -a cpu_ranges <<< "$allowed_cpus"
selected_cpus=()
for cpu_range in "${cpu_ranges[@]}"; do
  if [[ ! "$cpu_range" =~ ^([0-9]+)(-([0-9]+))?$ ]]; then
    echo 'Cannot parse the current Linux CPU affinity.' >&2
    exit 2
  fi
  first_cpu="${BASH_REMATCH[1]}"
  last_cpu="${BASH_REMATCH[3]:-$first_cpu}"
  for ((cpu = first_cpu; cpu <= last_cpu; cpu++)); do
    selected_cpus+=("$cpu")
    if [ "${#selected_cpus[@]}" -ge "$cpu_count" ]; then
      break 2
    fi
  done
done
if [ "${#selected_cpus[@]}" -eq 0 ]; then
  echo 'No usable CPUs in the current Linux affinity mask.' >&2
  exit 2
fi
cpu_list="$(IFS=','; echo "${selected_cpus[*]}")"
taskset --pid --cpu-list "$cpu_list" "$$" >/dev/null

export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-${#selected_cpus[@]}}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-${#selected_cpus[@]}}"
export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-1}"
printf '[limited-task] cpus=%s nice_increment=10 rayon=%s uv=%s turbo=%s\n' \
  "$cpu_list" "$RAYON_NUM_THREADS" "$UV_THREADPOOL_SIZE" "$TURBO_CONCURRENCY"
# Affinity and niceness are inherited by child processes, including native build workers.
# This does not claim a memory limit, exclusive CPU reservation, or NAS I/O isolation.
exec nice -n 10 "$@"
