# The caller pins this local tag to the inspected NAS runner image ID. Only the browser's
# operating-system libraries enter this image; browser binaries remain in the NAS bind mount.
ARG E2E_BASE_IMAGE
FROM ${E2E_BASE_IMAGE}

ARG E2E_BROWSERS
ARG E2E_APT_DIRECT=0
ARG E2E_DEBIAN_MIRROR
ARG CODEX_GATEWAY_TASK_CPUS=2

# Use the exact installed Playwright CLI instead of downloading a second version. Its package
# is a build-only bind mount, so neither a duplicate Node dependency tree nor browser downloads
# become image layers. Changing the package contents invalidates Docker's layer cache.
RUN --mount=type=bind,source=playwright-core,target=/opt/playwright-core,ro \
    if [ -n "$E2E_DEBIAN_MIRROR" ]; then \
      case "$E2E_DEBIAN_MIRROR" in \
        *[!a-zA-Z0-9._:/-]*|http://|https://) echo 'Invalid E2E_DEBIAN_MIRROR.' >&2; exit 2 ;; \
        http://*|https://*) ;; \
        *) echo 'E2E_DEBIAN_MIRROR must be an HTTP(S) mirror URL.' >&2; exit 2 ;; \
      esac; \
      sed -i -E "s|^(URIs:[[:space:]]+)https?://[^[:space:]]+(/debian(-security)?)[[:space:]]*$|\1${E2E_DEBIAN_MIRROR%/}\2|" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
    && if [ "$E2E_APT_DIRECT" = 1 ]; then \
      env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
        CODEX_GATEWAY_TASK_CPUS="$CODEX_GATEWAY_TASK_CPUS" \
        /usr/local/bin/codex-gateway-limited-task node /opt/playwright-core/cli.js install-deps $E2E_BROWSERS; \
    else \
      CODEX_GATEWAY_TASK_CPUS="$CODEX_GATEWAY_TASK_CPUS" \
        /usr/local/bin/codex-gateway-limited-task node /opt/playwright-core/cli.js install-deps $E2E_BROWSERS; \
    fi \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
