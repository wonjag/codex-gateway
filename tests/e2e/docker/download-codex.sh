#!/usr/bin/env bash
set -euo pipefail

version="${1:?Codex version is required}"
target="${2:?Codex release target is required}"
destination="${3:?Destination directory is required}"
cache_directory="${4:-}"
asset="codex-package-$target.tar.gz"
checksums=codex-package_SHA256SUMS
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT

download() {
  curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
}

load_github_metadata() {
  if [[ ! -s "$download_dir/release.json" ]] && \
    ! download "https://api.github.com/repos/openai/codex/releases/tags/rust-v$version" \
      "$download_dir/release.json" 60; then
    rm -f "$download_dir/release.json"
  fi
}

download_github_asset() {
  local name="$1" output="$2" timeout="$3" api_url=""
  if [[ -s "$download_dir/release.json" ]]; then
    api_url="$(node - "$download_dir/release.json" "$name" <<'NODE'
const fs = require('node:fs');
const [metadataPath, name] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const asset = metadata.assets?.find((candidate) => candidate.name === name);
if (/^https:\/\/api\.github\.com\/repos\/openai\/codex\/releases\/assets\/\d+$/.test(asset?.url ?? '')) {
  process.stdout.write(asset.url);
}
NODE
    )" || api_url=""
  fi
  if [[ -n "$api_url" ]] && curl -fsSL --connect-timeout 30 --max-time "$timeout" \
    -H 'Accept: application/octet-stream' \
    "$api_url?download=1&nonce=$(date +%s%N)" -o "$output"; then
    return
  fi
  download "https://github.com/openai/codex/releases/download/rust-v$version/$name" "$output" "$timeout"
}

release_base="https://releases.openai.com/codex/releases/$version"
if ! download "$release_base/$checksums" "$download_dir/$checksums" 60; then
  load_github_metadata
  download_github_asset "$checksums" "$download_dir/$checksums" 60
fi

cached_archive="$cache_directory/$version/$asset"
if [[ -n "$cache_directory" && ( -e "$cached_archive" || -L "$cached_archive" ) ]]; then
  test -f "$cached_archive"
  # Copy first and verify that snapshot; a present corrupt cache must fail, not bypass checks.
  cp "$cached_archive" "$download_dir/$asset"
elif ! download "$release_base/$asset" "$download_dir/$asset" 600; then
  load_github_metadata
  download_github_asset "$asset" "$download_dir/$asset" 600
fi

expected="$(awk -v asset="$asset" \
  '$2 == asset && length($1) == 64 && $1 ~ /^[[:xdigit:]]+$/ { print tolower($1); found++ } END { exit found == 1 ? 0 : 1 }' \
  "$download_dir/$checksums")"
printf '%s  %s\n' "$expected" "$download_dir/$asset" | sha256sum -c -
mkdir -p "$destination"
tar -xzf "$download_dir/$asset" -C "$destination"
