#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/../.." && pwd)"
compose_file="$script_dir/docker-compose.yml"
project_name="${E2E_COMPOSE_PROJECT_NAME:-codex-gateway-e2e}"
compose=(docker compose --ansi never --progress "${E2E_BUILD_PROGRESS:-quiet}" -p "$project_name" -f "$compose_file")

if [ "${1:-}" = "--turn" ]; then
  export E2E_CODEX_TURN=1
  shift
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

export E2E_UID="${E2E_UID:-12345}"
export E2E_GID="${E2E_GID:-12345}"
export E2E_CODEX_HOME="${E2E_CODEX_HOME:-$HOME/.codex}"
# Keep the MFA fixture on the same Codex version as the application protocol gate. The dedicated
# legacy fixtures own upgrade coverage; mixing a 130 MB upgrade into the MFA browser flow makes
# authentication timing depend on installation work that the test is not exercising.
export E2E_SUPPORTED_CODEX_VERSION="$(
  node --experimental-strip-types --input-type=module -e \
    "import('./server/utils/gateway/infra/codex/codex-version.ts').then(({ SUPPORTED_CODEX_VERSION }) => process.stdout.write(SUPPORTED_CODEX_VERSION))"
)"

nas_local_run_dir=""
if [ -n "${E2E_NAS_ROOT:-}" ]; then
  if [[ "$E2E_NAS_ROOT" != /* ]]; then
    echo 'E2E_NAS_ROOT must be an absolute path on the Docker daemon host.' >&2
    exit 2
  fi
  # Each run has its own source snapshot. Only package/browser caches are shared; neither a
  # browser run nor a concurrent source edit can overwrite the build container's workspace.
  umask 077
  mkdir -p "$E2E_NAS_ROOT"/{runs,cache,browsers}
  export E2E_PNPM_STORE="${E2E_PNPM_STORE:-$E2E_NAS_ROOT/cache/pnpm-store}"
  if [[ "$E2E_PNPM_STORE" != /* ]]; then
    echo 'E2E_PNPM_STORE must be an absolute path on the Docker daemon host.' >&2
    exit 2
  fi
  mkdir -p "$E2E_PNPM_STORE"
  export E2E_NAS_RUN_DIR
  E2E_NAS_RUN_DIR="$(mktemp -d "$E2E_NAS_ROOT/runs/run.XXXXXXXX")"
  mkdir -p "$E2E_NAS_RUN_DIR"/{workspace,build-output,gateway-tmp}
  # Keep SQLite WAL and small runtime state on a local filesystem. A bind mount also works
  # with platform Docker proxies that do not support named volumes.
  local_root="${E2E_LOCAL_ROOT:-$HOME/.cache/codex-gateway-e2e}"
  if [[ "$local_root" != /* ]]; then
    echo 'E2E_LOCAL_ROOT must be an absolute path on a local filesystem.' >&2
    exit 2
  fi
  mkdir -p "$local_root"
  export E2E_LOCAL_RUN_DIR
  E2E_LOCAL_RUN_DIR="$(mktemp -d "$local_root/run.XXXXXXXX")"
  nas_local_run_dir="$E2E_LOCAL_RUN_DIR"
  mkdir -p "$E2E_LOCAL_RUN_DIR"/{data,bark-requests,runner-home}
  tar -C "$project_dir" \
    --exclude=node_modules --exclude=dist --exclude=.turbo --exclude='*.log' \
    -cf - app i18n packages patches public scripts server shared tests \
    components.json nuxt.config.ts package.json playwright.config.ts pnpm-lock.yaml \
    pnpm-workspace.yaml turbo.json tailwind.config.ts tsconfig.json \
    | tar -C "$E2E_NAS_RUN_DIR/workspace" -xf -
  compose+=(-f "$script_dir/docker-compose.nas.yml")
  echo "E2E source, dependencies and build artifacts: $E2E_NAS_RUN_DIR"
fi

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" logs --no-color \
      gateway-under-test ssh-target ssh-target-legacy-node ssh-target-npm-codex \
      ssh-target-mfa >&2 || true
  fi
  if "${compose[@]}" down --remove-orphans >/dev/null 2>&1; then
    if [ -n "$nas_local_run_dir" ]; then
      rm -rf "$nas_local_run_dir"
    fi
  fi
}
trap cleanup EXIT

"${compose[@]}" build \
  build-runner ssh-target ssh-target-legacy-node ssh-target-npm-codex ssh-target-mfa
if [ -n "${E2E_NAS_ROOT:-}" ]; then
  "${compose[@]}" run --rm --no-deps build-runner \
    bash -lc 'pnpm install --frozen-lockfile --store-dir /cache/pnpm-store --package-import-method copy'
fi
# Build, application server, and browser runner use separate 2 GiB cgroups. Sharing only the
# gateway network namespace preserves the production-like nip.io subdomain routing used by browser
# preview tests without coupling process memory.
"${compose[@]}" run --rm build-runner \
  bash -lc 'rm -rf .output .nuxt .data-e2e/* /e2e-output/* && pnpm exec nuxt build --logLevel=silent --extends ./tests/e2e/nuxt-layer && cp -a .output/. /e2e-output/ && node scripts/create-user.mjs "$E2E_GATEWAY_USERNAME" "$E2E_GATEWAY_PASSWORD"'
"${compose[@]}" up -d --wait \
  gateway-under-test browser-preview-ingress
"${compose[@]}" run --rm test-runner \
  bash -lc 'if [ "${E2E_NAS_MODE:-}" = "1" ]; then pnpm exec playwright install --with-deps chromium webkit && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* || exit $?; fi; exec pnpm exec playwright test --reporter=dot "$@"' \
  e2e "$@"
