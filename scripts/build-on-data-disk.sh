#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 /absolute/data-directory [image-tag]" >&2
  echo 'Builds committed HEAD only; deployment is a separate step.' >&2
  exit 2
fi

build_data_root="$1"
image_tag="${2:-codex-gateway:local}"
build_pnpm_store="${BUILD_PNPM_STORE:-$build_data_root/cache/pnpm-store}"
for directory in "$build_data_root" "$build_pnpm_store"; do
  if [[ "$directory" != /* ]] || [[ "$directory" == *,* ]]; then
    echo 'The data directory and BUILD_PNPM_STORE must be absolute paths without commas.' >&2
    exit 2
  fi
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
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
  --env COREPACK_HOME=/cache/corepack \
  --env XDG_CACHE_HOME=/cache/xdg \
  --env NODE_USE_ENV_PROXY=1 \
  --env NODE_OPTIONS=--max-old-space-size=1536 \
  "${runtime_proxy_args[@]}" \
  node:24-bookworm \
  bash -lc 'set -euo pipefail
    corepack enable
    pnpm install --frozen-lockfile --prod=false --store-dir /cache/pnpm-store --package-import-method copy
    pnpm exec nuxt build --logLevel silent'

test -f "$build_workspace/.output/server/index.mjs"
cp -a "$build_workspace/.output" "$runtime_context/.output"
cp -a "$build_workspace/scripts" "$runtime_context/scripts"
cp "$build_workspace/Dockerfile.runtime" "$runtime_context/Dockerfile.runtime"

# Only the production output and management scripts enter Docker's final image. Retain the
# private source snapshot on the data disk for diagnosis and commit provenance.
DOCKER_BUILDKIT=1 docker build \
  --file "$runtime_context/Dockerfile.runtime" \
  --tag "$image_tag" \
  --label "org.opencontainers.image.revision=$build_commit" \
  --build-arg "BUILD_DEBIAN_MIRROR=${BUILD_DEBIAN_MIRROR:-}" \
  "${build_proxy_args[@]}" \
  "$runtime_context"

printf 'Built image: %s\nSource commit: %s\n' "$image_tag" "$build_commit"
