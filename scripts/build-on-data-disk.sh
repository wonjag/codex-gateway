#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 /absolute/data-directory [image-tag]" >&2
  echo 'Builds committed HEAD only; deployment is a separate step.' >&2
  echo 'Optional BUILD_DEPENDENCY_WORKSPACE reuses a finished, trusted Node24 container workspace.' >&2
  echo 'Set BUILD_PNPM_STORE to the existing store used by that workspace.' >&2
  exit 2
fi

build_data_root="$1"
image_tag="${2:-codex-gateway:local}"
build_pnpm_store="${BUILD_PNPM_STORE:-$build_data_root/cache/pnpm-store}"
dependency_workspace="${BUILD_DEPENDENCY_WORKSPACE:-}"
for directory in "$build_data_root" "$build_pnpm_store"; do
  if [[ "$directory" != /* ]] || [[ "$directory" == *,* ]]; then
    echo 'The data directory and BUILD_PNPM_STORE must be absolute paths without commas.' >&2
    exit 2
  fi
done
if [ -n "$dependency_workspace" ]; then
  if [[ "$dependency_workspace" != /* ]] || [[ "$dependency_workspace" == *,* ]] || \
    [ ! -d "$dependency_workspace" ]; then
    echo 'BUILD_DEPENDENCY_WORKSPACE must be an existing absolute directory without commas.' >&2
    exit 2
  fi
  if [ ! -d "$build_pnpm_store" ]; then
    echo 'BUILD_PNPM_STORE must refer to the existing store used by the dependency workspace.' >&2
    exit 2
  fi
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
# Serialize production builds with E2E and reject a run before it consumes local database space.
source "$script_dir/heavy-job-guard.sh"
gateway_heavy_job_begin production-build
trap 'gateway_heavy_job_end "$?"' EXIT
build_commit="$(git -C "$project_dir" rev-parse HEAD)"
if ! git -C "$project_dir" cat-file -e "$build_commit:Dockerfile.runtime"; then
  echo 'Dockerfile.runtime must be committed before building committed HEAD.' >&2
  exit 2
fi

umask 077
mkdir -p "$build_data_root"/{runs,cache} "$build_pnpm_store"
build_run_dir="$(mktemp -d "$build_data_root/runs/production.XXXXXXXX")"
build_workspace="$build_run_dir/workspace"
runtime_context="$build_run_dir/runtime-context"
mkdir -p "$build_workspace" "$runtime_context"
printf '%s\n' "$build_commit" > "$build_run_dir/commit.txt"
printf 'Building committed HEAD: %s\nBuild directory: %s\n' "$build_commit" "$build_run_dir"

# Export only production build inputs from this commit. Local changes, dotenv files, credentials,
# test fixtures, and existing dependency/build directories never enter the source snapshot.
git -C "$project_dir" archive "$build_commit" -- \
  app i18n packages patches public scripts server shared components.json nuxt.config.ts \
  package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tailwind.config.ts \
  tsconfig.json Dockerfile.runtime | tar -C "$build_workspace" -xf -

dependency_mount_args=()
if [ -n "$dependency_workspace" ]; then
  # Only reuse a trusted, finished Node24/bookworm container's dependencies on this Docker host.
  # These mounts are writable: pnpm still validates the lockfile and rebuilds workspace packages.
  # The shared host guard serializes supported build/test entrypoints; this additional lock also
  # protects this particular dependency workspace. Stop any external users of the workspace.
  exec {dependency_lock_fd}>"$dependency_workspace/.codex-gateway-production-dependencies.lock"
  if ! flock --nonblock "$dependency_lock_fd"; then
    echo 'The dependency workspace is already in use, or its filesystem cannot lock it.' >&2
    exit 2
  fi

  for manifest in package.json pnpm-lock.yaml pnpm-workspace.yaml; do
    if ! cmp -s -- "$dependency_workspace/$manifest" "$build_workspace/$manifest"; then
      printf 'Dependency workspace differs from committed HEAD: %s\n' "$manifest" >&2
      exit 2
    fi
  done

  snapshot_packages=()
  dependency_packages=()
  for manifest in "$build_workspace"/packages/*/package.json; do
    [ -f "$manifest" ] || continue
    package_path="${manifest#"$build_workspace/"}"
    snapshot_packages+=("${package_path%/package.json}")
  done
  for manifest in "$dependency_workspace"/packages/*/package.json; do
    [ -f "$manifest" ] || continue
    package_path="${manifest#"$dependency_workspace/"}"
    dependency_packages+=("${package_path%/package.json}")
  done
  if [ "${#snapshot_packages[@]}" -ne "${#dependency_packages[@]}" ]; then
    echo 'Dependency workspace package set differs from committed HEAD.' >&2
    exit 2
  fi
  for package_index in "${!snapshot_packages[@]}"; do
    package_path="${snapshot_packages[$package_index]}"
    if [ "$package_path" != "${dependency_packages[$package_index]}" ] || \
      ! cmp -s -- "$dependency_workspace/$package_path/package.json" "$build_workspace/$package_path/package.json"; then
      printf 'Dependency workspace package differs from committed HEAD: %s\n' "$package_path" >&2
      exit 2
    fi
  done

  if [ ! -f "$dependency_workspace/node_modules/.modules.yaml" ] || \
    [ ! -d "$dependency_workspace/node_modules/.pnpm" ]; then
    echo 'Dependency workspace is missing its installed pnpm metadata or virtual store.' >&2
    exit 2
  fi
  for package_path in . "${snapshot_packages[@]}"; do
    if [ ! -d "$dependency_workspace/$package_path/node_modules" ]; then
      printf 'Dependency workspace is missing: %s/node_modules\n' "$package_path" >&2
      exit 2
    fi
    module_target="/app/${package_path#./}/node_modules"
    module_source="$dependency_workspace/$package_path/node_modules"
    if [ "$package_path" = . ]; then
      module_target=/app/node_modules
      module_source="$dependency_workspace/node_modules"
    fi
    dependency_mount_args+=(--mount "type=bind,source=$module_source,target=$module_target")
  done
  printf 'Reusing finished Node24 dependency workspace: %s\n' "$dependency_workspace"
fi

runtime_proxy_args=()
build_proxy_args=()
for proxy_name in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy; do
  # Pass variable names so authenticated proxy URLs do not appear in command arguments.
  runtime_proxy_args+=(--env "$proxy_name")
  build_proxy_args+=(--build-arg "$proxy_name")
done

# The full Node image supplies Python, compiler tools, Git, SSH, and CA roots. Project dependency
# installation and native builds happen on the data disk, outside Docker's image/cache layers.
docker run --rm --memory 2g --memory-swap 2g \
  --workdir /app \
  --mount "type=bind,source=$build_workspace,target=/app" \
  --mount "type=bind,source=$build_data_root/cache,target=/cache" \
  --mount "type=bind,source=$build_pnpm_store,target=/cache/pnpm-store" \
  "${dependency_mount_args[@]}" \
  --env COREPACK_HOME=/cache/corepack \
  --env XDG_CACHE_HOME=/cache/xdg \
  --env TURBO_CACHE_DIR=/cache/turbo \
  --env TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-1}" \
  --env CODEX_GATEWAY_TASK_CPUS="${CODEX_GATEWAY_TASK_CPUS:-2}" \
  --env RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}" \
  --env UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-2}" \
  --env NODE_USE_ENV_PROXY=1 \
  --env NODE_OPTIONS=--max-old-space-size=1536 \
  "${runtime_proxy_args[@]}" \
  node:24-bookworm \
  bash scripts/limited-task.sh bash -lc 'set -euo pipefail
    corepack enable
    pnpm install --frozen-lockfile --prod=false --store-dir /cache/pnpm-store --package-import-method copy
    # A fresh git archive contains no .nuxt directory. Its final postinstall step generates this
    # file; if install already ran that lifecycle, do not rebuild/typecheck all packages twice.
    # Keep normal install hooks enabled so native dependency builds still run when needed.
    if [ ! -f .nuxt/nuxt.d.ts ]; then
      pnpm run postinstall
    else
      echo "[build-cache] postinstall completed during dependency installation"
    fi
    pnpm exec nuxt build --logLevel silent'

test -f "$build_workspace/.output/server/index.mjs"
cp -a "$build_workspace/.output" "$runtime_context/.output"
cp -a "$build_workspace/scripts" "$runtime_context/scripts"
cp "$build_workspace/Dockerfile.runtime" "$runtime_context/Dockerfile.runtime"

# Only the production output and management scripts enter Docker's final image. Retain the
# private source snapshot on the data disk for diagnosis and commit provenance.
gateway_heavy_job_check_space
DOCKER_BUILDKIT=1 docker build \
  --file "$runtime_context/Dockerfile.runtime" \
  --tag "$image_tag" \
  --label "org.opencontainers.image.revision=$build_commit" \
  --build-arg "BUILD_DEBIAN_MIRROR=${BUILD_DEBIAN_MIRROR:-}" \
  "${build_proxy_args[@]}" \
  "$runtime_context"

printf 'Built image: %s\nSource commit: %s\n' "$image_tag" "$build_commit"
