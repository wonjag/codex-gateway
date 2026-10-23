#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/codex/.ssh /home/codex/.codex /workspace
mkdir -p /home/codex/.local
chmod 700 /home/codex/.ssh
chown -R codex:"$(id -gn codex)" /home/codex/.ssh /home/codex/.local /home/codex/.codex

# SSH does not inherit Docker's environment. Keep an optional test-only proxy in
# a private file and load it for the login shell that launches app-server.
if [ -n "${E2E_CODEX_PROXY_URL:-}" ]; then
  (
    umask 077
    for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
      printf 'export %s=%q\n' "$key" "$E2E_CODEX_PROXY_URL"
    done
    for key in NO_PROXY no_proxy; do
      printf 'export %s=%q\n' "$key" "${E2E_CODEX_NO_PROXY:-localhost,127.0.0.1,::1}"
    done
  ) > /home/codex/.codex-e2e-proxy-env
  chmod 600 /home/codex/.codex-e2e-proxy-env
  chown codex:"$(id -gn codex)" /home/codex/.codex-e2e-proxy-env
  cat > /etc/profile.d/codex-e2e-proxy.sh <<'EOF'
if [ "$(id -un)" = codex ] && [ -r /home/codex/.codex-e2e-proxy-env ]; then
  . /home/codex/.codex-e2e-proxy-env
fi
EOF
else
  rm -f /home/codex/.codex-e2e-proxy-env /etc/profile.d/codex-e2e-proxy.sh
fi

if [ -x /usr/local/bin/e2e-gpu-training ]; then
  runuser -u trainer -- /usr/local/bin/e2e-gpu-training >/dev/null 2>&1 &
fi

exec /usr/sbin/sshd -D -e
