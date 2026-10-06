FROM node:24-bookworm-slim

# Slim images omit CA roots; bootstrap them so optional HTTPS apt mirrors work.
COPY --from=node:22-bookworm /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ARG E2E_DEBIAN_MIRROR
RUN if [ -n "$E2E_DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${E2E_DEBIAN_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace/codex-gateway

# Turbo's task graph and workspace package sources are dependency inputs, not application inputs.
# Copy them before the mutable app tree so ordinary UI edits reuse pnpm and prebuilt vendor layers.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches
COPY packages ./packages
RUN --mount=type=cache,id=codex-gateway-e2e-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

# Install the browser revision required by the lockfile without depending on a
# separately published Playwright image tag.
RUN pnpm exec playwright install --with-deps chromium webkit

COPY . /workspace/source

COPY tests/e2e/runner-entrypoint.sh /usr/local/bin/codex-gateway-e2e-runner
RUN chmod +x /usr/local/bin/codex-gateway-e2e-runner

ENTRYPOINT ["codex-gateway-e2e-runner"]
