#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/../.." && pwd)"
compose_file="$script_dir/docker-compose.yml"
project_name="${E2E_COMPOSE_PROJECT_NAME:-codex-gateway-e2e}"
compose=(docker compose --ansi never --progress "${E2E_BUILD_PROGRESS:-quiet}" -p "$project_name" -f "$compose_file")

source "$project_dir/scripts/heavy-job-guard.sh"
nas_local_run_dir=""
compose_started=0
ssh_fixtures=(ssh-target)
cleanup() {
  local status=$?
  if [ "$compose_started" -eq 1 ]; then
    if [ "$status" -ne 0 ]; then
      "${compose[@]}" logs --no-color gateway-under-test "${ssh_fixtures[@]}" \
        browser-preview-ingress bark-target >&2 || true
    fi
    if "${compose[@]}" down --remove-orphans >/dev/null 2>&1; then
      [ -z "$nas_local_run_dir" ] || rm -rf "$nas_local_run_dir"
    fi
  elif [ -n "$nas_local_run_dir" ]; then
    rm -rf "$nas_local_run_dir"
  fi
  gateway_heavy_job_end "$status"
}
trap cleanup EXIT

phase_started_at=$SECONDS
finish_phase() {
  printf '[e2e] phase=%s elapsed_seconds=%s\n' "$1" "$((SECONDS - phase_started_at))"
  phase_started_at=$SECONDS
}

# Normalize archive metadata while retaining file contents, names, permissions, and symlinks.
# Browser tests and orchestration can change without invalidating the app or fixture images.
source_fingerprint() {
  tar -C "$1" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --exclude=node_modules --exclude=dist --exclude=.turbo --exclude='*.log' \
    --exclude=scripts/build-on-data-disk.sh \
    -cf - app i18n packages patches public scripts server shared \
    tests/e2e/nuxt-layer tests/e2e/docker tests/e2e/docker-compose.yml \
    tests/e2e/runner.Dockerfile tests/e2e/runner.Dockerfile.dockerignore \
    tests/e2e/runner-entrypoint.sh \
    components.json nuxt.config.ts package.json playwright.config.ts pnpm-lock.yaml \
    pnpm-workspace.yaml turbo.json tailwind.config.ts tsconfig.json \
    | sha256sum | cut -d ' ' -f 1
}

output_fingerprint() {
  tar -C "$1" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . \
    | sha256sum | cut -d ' ' -f 1
}

image_fingerprint() {
  local image_names
  image_names="$("${compose[@]}" config --images \
    build-runner "${ssh_fixtures[@]}" | sort -u)"
  while IFS= read -r image_name; do
    docker image inspect --format '{{.Id}}' "$image_name" || return 1
  done <<< "$image_names" | sha256sum | cut -d ' ' -f 1
}

if [ "${1:-}" = "--turn" ]; then
  export E2E_CODEX_TURN=1
  shift
fi

if [ "${1:-}" = "--" ]; then
  shift
fi

export E2E_FIXTURE_PROFILE="${E2E_FIXTURE_PROFILE:-full}"
case "$E2E_FIXTURE_PROFILE" in
  core) ;;
  full)
    compose+=(--profile extended)
    ssh_fixtures+=(ssh-target-legacy-node ssh-target-npm-codex ssh-target-mfa)
    ;;
  *) echo 'E2E_FIXTURE_PROFILE must be full or core.' >&2; exit 2 ;;
esac
export E2E_BROWSERS="${E2E_BROWSERS:-chromium webkit}"
case "$E2E_BROWSERS" in
  'chromium webkit'|'webkit chromium') export E2E_BROWSERS='chromium webkit' ;;
  chromium|webkit) ;;
  *) echo 'E2E_BROWSERS must be chromium, webkit, or "chromium webkit".' >&2; exit 2 ;;
esac
# Explicitly constrain Playwright projects when installing only one engine. Reject an
# incompatible explicit project before preparing any build or fixture.
test_arguments=("$@")
selected_projects=()
for ((arg_index=0; arg_index<${#test_arguments[@]}; arg_index++)); do
  argument="${test_arguments[$arg_index]}"
  if [[ "$argument" == --project=* ]]; then
    selected_projects+=("${argument#--project=}")
  elif [ "$argument" = --project ]; then
    arg_index=$((arg_index + 1))
    selected_projects+=("${test_arguments[$arg_index]:-}")
  fi
done
if [ "$E2E_BROWSERS" != 'chromium webkit' ]; then
  for selected_project in "${selected_projects[@]}"; do
    case "$E2E_BROWSERS:$selected_project" in
      chromium:chromium|chromium:mobile-chrome|webkit:mobile-webkit-core-scroll) ;;
      *) echo 'The explicit Playwright project does not match E2E_BROWSERS.' >&2; exit 2 ;;
    esac
  done
  if [ "${#selected_projects[@]}" -eq 0 ]; then
    if [ "$E2E_BROWSERS" = chromium ]; then
      set -- "$@" --project=chromium --project=mobile-chrome
    else
      set -- "$@" --project=mobile-webkit-core-scroll
    fi
  fi
fi

gateway_heavy_job_begin e2e /
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

nas_resume=0
dependency_workspace="${E2E_DEPENDENCY_WORKSPACE:-}"
if [ -n "$dependency_workspace" ] && [ -z "${E2E_NAS_ROOT:-}" ]; then
  echo 'E2E_DEPENDENCY_WORKSPACE requires E2E_NAS_ROOT.' >&2
  exit 2
fi
if [ -n "${E2E_NAS_RESUME_RUN_DIR:-}" ] && [ -z "${E2E_NAS_ROOT:-}" ]; then
  echo 'E2E_NAS_RESUME_RUN_DIR requires E2E_NAS_ROOT.' >&2
  exit 2
fi
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
  if [ -n "${E2E_NAS_RESUME_RUN_DIR:-}" ]; then
    if [[ "$E2E_NAS_RESUME_RUN_DIR" != /* ]] || [ ! -d "$E2E_NAS_RESUME_RUN_DIR" ]; then
      echo 'E2E_NAS_RESUME_RUN_DIR must be an existing absolute run directory.' >&2
      exit 2
    fi
    nas_runs_root="$(cd "$E2E_NAS_ROOT/runs" && pwd -P)"
    E2E_NAS_RUN_DIR="$(cd "$E2E_NAS_RESUME_RUN_DIR" && pwd -P)"
    if [[ "${E2E_NAS_RUN_DIR%/*}" != "$nas_runs_root" ]] || \
      [[ "${E2E_NAS_RUN_DIR##*/}" != run.* ]]; then
      echo 'The resume directory must be a direct run.* child of E2E_NAS_ROOT/runs.' >&2
      exit 2
    fi
    if [ -f "$E2E_NAS_RUN_DIR/.dependency-workspace" ]; then
      saved_dependency_workspace="$(cat "$E2E_NAS_RUN_DIR/.dependency-workspace")"
      if [ -n "$dependency_workspace" ] && [ "$dependency_workspace" != "$saved_dependency_workspace" ]; then
        echo 'A resumed run must use its original dependency workspace.' >&2
        exit 2
      fi
      dependency_workspace="$saved_dependency_workspace"
    elif [ -n "$dependency_workspace" ]; then
      echo 'Cannot replace dependencies when resuming an existing build; start a new run.' >&2
      exit 2
    fi
    for required in workspace/.output/nitro.json workspace/.output/server/index.mjs; do
      if [ ! -f "$E2E_NAS_RUN_DIR/$required" ]; then
        printf 'The resume directory is missing: %s\n' "$required" >&2
        exit 2
      fi
    done
    if [ -z "$dependency_workspace" ] && \
      { [ ! -f "$E2E_NAS_RUN_DIR/workspace/node_modules/.modules.yaml" ] || \
        [ ! -d "$E2E_NAS_RUN_DIR/workspace/node_modules/.pnpm" ]; }; then
      echo 'The resume directory is missing its installed pnpm virtual store.' >&2
      exit 2
    fi
    nas_resume=1
  else
    E2E_NAS_RUN_DIR="$(mktemp -d "$E2E_NAS_ROOT/runs/run.XXXXXXXX")"
  fi
  exec {nas_run_lock_fd}>"$E2E_NAS_RUN_DIR/.run.lock"
  if ! flock --nonblock "$nas_run_lock_fd"; then
    echo 'This NAS run is already in use, or its filesystem cannot lock it.' >&2
    exit 2
  fi
  mkdir -p "$E2E_NAS_RUN_DIR"/{workspace,build-output,gateway-tmp}
  # Managed Docker bind proxies require host directories to exist before container creation.
  mkdir -p "$project_dir/test-results"
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
  if [ "$nas_resume" -eq 0 ]; then
    tar -C "$project_dir" \
      --exclude=node_modules --exclude=dist --exclude=.turbo --exclude='*.log' \
      -cf - app i18n packages patches public scripts server shared tests \
      components.json nuxt.config.ts package.json playwright.config.ts pnpm-lock.yaml \
      pnpm-workspace.yaml turbo.json tailwind.config.ts tsconfig.json \
      | tar -C "$E2E_NAS_RUN_DIR/workspace" -xf -
  fi
  compose+=(-f "$script_dir/docker-compose.nas.yml")
  if [ -n "$dependency_workspace" ]; then
    if [[ "$dependency_workspace" != /* ]] || [[ "$dependency_workspace" == *,* ]] || \
      [ ! -d "$dependency_workspace" ]; then
      echo 'E2E_DEPENDENCY_WORKSPACE must be an existing absolute directory without commas.' >&2
      exit 2
    fi
    dependency_workspace="$(cd "$dependency_workspace" && pwd -P)"
    dependency_run="${dependency_workspace%/*}"
    if [ "$dependency_run" = "$E2E_NAS_RUN_DIR" ] || \
      [ ! -f "$dependency_run/.completed-build" ]; then
      echo 'Only a separate, completed and trusted Node24/Bookworm E2E workspace can supply dependencies.' >&2
      exit 2
    fi
    # Serialize against E2E resumption and production dependency reuse. The caller must also
    # ensure no external process is using this trusted, same-host Node24 installation.
    exec {dependency_run_lock_fd}>"$dependency_run/.run.lock"
    exec {dependency_lock_fd}>"$dependency_workspace/.codex-gateway-production-dependencies.lock"
    if ! flock --nonblock "$dependency_run_lock_fd" || ! flock --nonblock "$dependency_lock_fd"; then
      echo 'The dependency workspace is already in use, or its filesystem cannot lock it.' >&2
      exit 2
    fi
    node --experimental-strip-types "$script_dir/dependency-workspace.ts" "$dependency_workspace" \
      "$E2E_NAS_RUN_DIR/workspace" > "$E2E_NAS_RUN_DIR/dependency-compose.json"
    printf '%s\n' "$dependency_workspace" > "$E2E_NAS_RUN_DIR/.dependency-workspace"
    compose+=(-f "$E2E_NAS_RUN_DIR/dependency-compose.json")
    echo "Reusing completed Node24 dependencies: $dependency_workspace"
  fi
  echo "E2E source, dependencies and build artifacts: $E2E_NAS_RUN_DIR"
fi

finish_phase source-preparation

if [ "$nas_resume" -eq 1 ]; then
  nas_source_hash="$(source_fingerprint "$E2E_NAS_RUN_DIR/workspace")"
  if [ "$nas_source_hash" != "$(source_fingerprint "$project_dir")" ]; then
    echo 'Application, Nuxt layer, fixture, or dependency inputs changed; start a new NAS run.' >&2
    exit 2
  fi
  # Gateway mounts this one completed artifact read-only. Validate it against the recorded
  # content hash; older v1 runs recorded the same bytes after copying them to build-output.
  nas_output_hash="$(output_fingerprint "$E2E_NAS_RUN_DIR/workspace/.output")"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (metadata.preset !== "node-server" || metadata.framework?.name !== "nuxt") process.exit(1);
  ' "$E2E_NAS_RUN_DIR/workspace/.output/nitro.json"
  nas_image_hash="$(image_fingerprint)"
  nas_marker="$E2E_NAS_RUN_DIR/.completed-build"
  if [ -f "$nas_marker" ]; then
    mapfile -t nas_record < "$nas_marker"
    if [ "${#nas_record[@]}" -ne 4 ] || [ "${nas_record[0]}" != v1 ] || \
      [ "${nas_record[1]}" != "$nas_source_hash" ] || \
      [ "${nas_record[2]}" != "$nas_output_hash" ] || \
      [ "${nas_record[3]}" != "$nas_image_hash" ]; then
      echo 'The saved build inputs, output, or container images changed; start a new NAS run.' >&2
      exit 2
    fi
  elif [ "${E2E_NAS_ADOPT_COMPLETED_BUILD:-0}" = 1 ]; then
    # One-time adoption of runs created before completion markers existed. The operator must
    # independently confirm a successful original E2E build; full source/output checks still apply.
    printf 'v1\n%s\n%s\n%s\n' "$nas_source_hash" "$nas_output_hash" "$nas_image_hash" \
      > "$nas_marker.tmp"
    mv "$nas_marker.tmp" "$nas_marker"
  else
    echo 'No completed-build marker. Independently verify the original build before explicitly setting E2E_NAS_ADOPT_COMPLETED_BUILD=1.' >&2
    exit 2
  fi
  # Playwright compiles the current test files at runtime. Refresh assertions/helpers while the
  # application output and Docker fixture inputs above remain verified against the original build.
  # Preserve directory inodes: managed Docker proxies can retain mappings of these bind sources.
  # Remove stale files explicitly so deleted tests are not accidentally kept in a resumed suite.
  while IFS= read -r -d '' saved_test; do
    relative_test="${saved_test#"$E2E_NAS_RUN_DIR/workspace/"}"
    if [ ! -f "$project_dir/$relative_test" ] && [ ! -L "$project_dir/$relative_test" ]; then
      rm -f -- "$saved_test"
    fi
  done < <(find "$E2E_NAS_RUN_DIR/workspace/tests" \( -type f -o -type l \) -print0)
  tar -C "$project_dir" -cf - tests | tar -C "$E2E_NAS_RUN_DIR/workspace" -xf -
  echo 'Verified saved NAS build; recreating the local test database.'
  compose_started=1
  "${compose[@]}" run --rm --no-deps build-runner \
    bash -lc 'node scripts/create-user.mjs "$E2E_GATEWAY_USERNAME" "$E2E_GATEWAY_PASSWORD"'
  finish_phase reuse-completed-build
else
  gateway_heavy_job_check_space /
  "${compose[@]}" build build-runner "${ssh_fixtures[@]}"
  finish_phase fixture-images
  compose_started=1
  if [ -n "${E2E_NAS_ROOT:-}" ]; then
    # pnpm can prune expired minimumReleaseAgeExclude entries even with a frozen lockfile.
    # Preserve the original build input after installation so a completed run remains comparable.
    cp -p "$E2E_NAS_RUN_DIR/workspace/pnpm-workspace.yaml" \
      "$E2E_NAS_RUN_DIR/.pnpm-workspace-before-install.yaml"
    "${compose[@]}" run --rm --no-deps build-runner \
      bash -lc 'set -euo pipefail
        pnpm install --frozen-lockfile --prod=false --store-dir /cache/pnpm-store --package-import-method copy
        if [ ! -f .nuxt/nuxt.d.ts ]; then pnpm run postinstall; fi'
    cp -p "$E2E_NAS_RUN_DIR/.pnpm-workspace-before-install.yaml" \
      "$E2E_NAS_RUN_DIR/workspace/pnpm-workspace.yaml"
  fi
  finish_phase dependencies
  gateway_heavy_job_check_space /
  # Build and browser processes have CPU affinity/priority limits even without cgroups.
  # Docker memory limits additionally require working daemon cgroup controllers.
  "${compose[@]}" run --rm build-runner \
    bash -lc 'rm -rf .output .nuxt .data-e2e/* /e2e-output/* && pnpm exec nuxt build --logLevel=silent --extends ./tests/e2e/nuxt-layer && if [ "${E2E_NAS_MODE:-0}" != 1 ]; then cp -a .output/. /e2e-output/; fi && node scripts/create-user.mjs "$E2E_GATEWAY_USERNAME" "$E2E_GATEWAY_PASSWORD"'
  if [ -n "${E2E_NAS_ROOT:-}" ]; then
    nas_source_hash="$(source_fingerprint "$E2E_NAS_RUN_DIR/workspace")"
    nas_output_hash="$(output_fingerprint "$E2E_NAS_RUN_DIR/workspace/.output")"
    nas_image_hash="$(image_fingerprint)"
    printf 'v1\n%s\n%s\n%s\n' "$nas_source_hash" "$nas_output_hash" "$nas_image_hash" \
      > "$E2E_NAS_RUN_DIR/.completed-build.tmp"
    mv "$E2E_NAS_RUN_DIR/.completed-build.tmp" "$E2E_NAS_RUN_DIR/.completed-build"
  fi
  finish_phase application-build
fi
if [ -n "${E2E_NAS_ROOT:-}" ]; then
  gateway_heavy_job_check_space /
  export E2E_BROWSER_RUNTIME_IMAGE
  E2E_BROWSER_RUNTIME_IMAGE="$("$script_dir/prepare-browser-runtime.sh" \
    "${dependency_workspace:-$E2E_NAS_RUN_DIR/workspace}" \
    "$E2E_NAS_ROOT/cache/browser-runtime" codex-gateway-e2e-nas-runner)"
  finish_phase browser-os-image
fi
gateway_heavy_job_check_space /
"${compose[@]}" up -d --wait \
  gateway-under-test browser-preview-ingress
"${compose[@]}" run --rm test-runner \
  bash -lc 'set -euo pipefail
    if [ "${E2E_NAS_MODE:-}" = "1" ]; then
      read -r -a browsers <<< "$E2E_BROWSERS"
      pnpm exec playwright install "${browsers[@]}"
    fi
    exec pnpm exec playwright test --reporter=dot "$@"' \
  e2e "$@"
finish_phase browser-tests
