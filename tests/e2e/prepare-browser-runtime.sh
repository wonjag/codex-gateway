#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 /installed/workspace /browser-image-cache [nas-runner-image]" >&2
  echo 'Prints the reusable browser image tag to stdout; diagnostics go to stderr.' >&2
  exit 2
fi

workspace="$1"
cache_dir="$2"
base_image="${3:-codex-gateway-e2e-nas-runner}"
if [[ "$workspace" != /* ]] || [[ "$cache_dir" != /* ]] || [ ! -d "$workspace" ]; then
  echo 'Workspace and browser-image cache must be absolute paths; workspace must exist.' >&2
  exit 2
fi
case "${E2E_APT_DIRECT:-0}" in
  0|1) ;;
  *) echo 'E2E_APT_DIRECT must be 0 or 1.' >&2; exit 2 ;;
esac

requested_browsers="${E2E_BROWSERS:-chromium webkit}"
read -r -a browser_arguments <<< "$requested_browsers"
chromium=0
webkit=0
for browser in "${browser_arguments[@]}"; do
  case "$browser" in
    chromium) chromium=1 ;;
    webkit) webkit=1 ;;
    *) echo 'E2E_BROWSERS accepts chromium and/or webkit only.' >&2; exit 2 ;;
  esac
done
browsers=()
[ "$chromium" -eq 0 ] || browsers+=(chromium)
[ "$webkit" -eq 0 ] || browsers+=(webkit)
if [ "${#browsers[@]}" -eq 0 ] || [[ "$requested_browsers" == *$'\n'* ]]; then
  echo 'E2E_BROWSERS must contain at least one browser on a single line.' >&2
  exit 2
fi
browser_names="${browsers[*]}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dockerfile="$script_dir/browser-runtime.Dockerfile"
# pnpm does not expose transitive playwright-core at the workspace root. Resolve each declared
# dependency from its owning package so the CLI always matches this installed test runner.
package_record="$(node --input-type=module - "$workspace" <<'NODE'
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const workspace = process.argv[2];
const rootRequire = createRequire(join(workspace, 'package.json'));
const testManifest = rootRequire.resolve('@playwright/test/package.json');
const playwrightManifest = createRequire(testManifest).resolve('playwright/package.json');
const coreManifest = createRequire(playwrightManifest).resolve('playwright-core/package.json');
const manifests = [testManifest, playwrightManifest, coreManifest].map(path =>
  JSON.parse(readFileSync(path, 'utf8')),
);
const version = manifests[0].version;
if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
    manifests.some(manifest => manifest.version !== version)) {
  throw new Error('Installed Playwright test, browser, and core versions must match');
}
if (Object.keys(manifests[2].dependencies ?? {}).length !== 0) {
  throw new Error('This Playwright core package requires dependencies; update browser image preparation');
}
const coreDirectory = realpathSync(dirname(coreManifest));
if (coreDirectory.includes('\n') || !statSync(join(coreDirectory, 'cli.js')).isFile()) {
  throw new Error('Installed Playwright core does not provide a regular CLI');
}
process.stdout.write(`${version}\n${coreDirectory}`);
NODE
)"
mapfile -t package_fields <<< "$package_record"
playwright_version="${package_fields[0]}"
core_directory="${package_fields[1]}"

fingerprint_tree() {
  tar -C "$1" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . \
    | sha256sum | cut -d ' ' -f 1
}

base_id="$(docker image inspect --format '{{.Id}}' "$base_image")"
if [[ ! "$base_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'Could not identify the existing NAS runner image.' >&2
  exit 2
fi
core_hash="$(fingerprint_tree "$core_directory")"
dockerfile_hash="$(sha256sum "$dockerfile" | cut -d ' ' -f 1)"
cache_key="$(printf '%s\n' v1 "$base_id" "$playwright_version" "$core_hash" \
  "$dockerfile_hash" "$browser_names" "${E2E_DEBIAN_MIRROR:-}" "${E2E_APT_DIRECT:-0}" \
  | sha256sum | cut -d ' ' -f 1)"
image="codex-gateway-e2e-browser:$cache_key"
cache_label='com.codex-gateway.e2e.browser-cache-key'

umask 077
mkdir -p "$cache_dir"
exec {cache_lock_fd}>"$cache_dir/.prepare.lock"
if ! flock --nonblock "$cache_lock_fd"; then
  echo 'Another browser image preparation is using this cache.' >&2
  exit 2
fi
if existing_key="$(docker image inspect --format "{{index .Config.Labels \"$cache_label\"}}" "$image" 2>/dev/null)"; then
  if [ "$existing_key" != "$cache_key" ]; then
    echo 'The cached browser image has unexpected provenance; remove that tag and retry.' >&2
    exit 2
  fi
  printf 'Reusing browser OS dependencies: Playwright %s (%s)\n' "$playwright_version" "$browser_names" >&2
  printf '%s\n' "$image"
  exit 0
fi

context_dir="$(mktemp -d "$cache_dir/context.XXXXXXXX")"
trap 'rm -rf -- "$context_dir"' EXIT
mkdir -p "$context_dir/playwright-core"
tar -C "$core_directory" -cf - . | tar -C "$context_dir/playwright-core" -xf -
cp "$dockerfile" "$context_dir/Dockerfile"
if [ "$(fingerprint_tree "$context_dir/playwright-core")" != "$core_hash" ]; then
  echo 'Playwright changed while preparing the image; stop its installer and retry.' >&2
  exit 2
fi

# Dockerfile FROM needs a named local image. Pin a content-derived tag before building instead
# of relying on the mutable NAS runner tag; no registry access is needed for this existing base.
pinned_base="codex-gateway-e2e-browser-base:${base_id#sha256:}"
docker image tag "$base_id" "$pinned_base"
proxy_args=()
for proxy_name in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy; do
  # Docker reads each value from the environment; credentials never become shell arguments.
  proxy_args+=(--build-arg "$proxy_name")
done
printf 'Preparing browser OS dependencies once: Playwright %s (%s)\n' "$playwright_version" "$browser_names" >&2
DOCKER_BUILDKIT=1 docker build \
  --progress "${E2E_BUILD_PROGRESS:-quiet}" \
  --tag "$image" \
  --build-arg "E2E_BASE_IMAGE=$pinned_base" \
  --build-arg "E2E_BROWSERS=$browser_names" \
  --build-arg "E2E_APT_DIRECT=${E2E_APT_DIRECT:-0}" \
  --build-arg "E2E_DEBIAN_MIRROR=${E2E_DEBIAN_MIRROR:-}" \
  --build-arg "CODEX_GATEWAY_TASK_CPUS=${CODEX_GATEWAY_TASK_CPUS:-2}" \
  --label "$cache_label=$cache_key" \
  --label "com.codex-gateway.e2e.playwright-version=$playwright_version" \
  --label "com.codex-gateway.e2e.browsers=$browser_names" \
  "${proxy_args[@]}" \
  "$context_dir" >&2
if [ "$(docker image inspect --format "{{index .Config.Labels \"$cache_label\"}}" "$image")" != "$cache_key" ]; then
  echo 'The prepared browser image is missing its provenance label.' >&2
  exit 2
fi
printf '%s\n' "$image"
