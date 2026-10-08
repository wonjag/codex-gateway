#!/usr/bin/env bash
set -euo pipefail

run_task() {
  if [ "${CODEX_GATEWAY_LIMIT_TASK:-0}" = 1 ]; then
    exec /usr/local/bin/codex-gateway-limited-task "$@"
  fi
  exec "$@"
}

# NAS workspaces are prepared once before the build. Application and browser containers reuse
# that workspace, so synchronizing here would remove files another container is still reading.
if [ "${E2E_NAS_MODE:-0}" = "1" ]; then
  run_task "$@"
fi

source_dir="${E2E_SOURCE_DIR:-/workspace/source}"
work_dir="/workspace/codex-gateway"

copy_entry() {
  local entry="$1"
  rm -rf "$work_dir/$entry"
  cp -a "$source_dir/$entry" "$work_dir/$entry"
}

for entry in app i18n public scripts server shared tests components.json nuxt.config.ts package.json playwright.config.ts pnpm-lock.yaml pnpm-workspace.yaml tailwind.config.ts tsconfig.json; do
  if [ -e "$source_dir/$entry" ]; then
    copy_entry "$entry"
  fi
done

run_task "$@"
