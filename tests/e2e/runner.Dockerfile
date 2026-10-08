# The full Node image already includes Python, compiler tools, Git, SSH and CA roots.
FROM node:24-bookworm AS runner-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_USE_ENV_PROXY=1

ARG E2E_DEBIAN_MIRROR
ARG CODEX_GATEWAY_TASK_CPUS=2
RUN if [ -n "$E2E_DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${E2E_DEBIAN_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

RUN corepack enable

WORKDIR /workspace/codex-gateway

COPY tests/e2e/runner-entrypoint.sh /usr/local/bin/codex-gateway-e2e-runner
COPY scripts/limited-task.sh /usr/local/bin/codex-gateway-limited-task
RUN chmod +x /usr/local/bin/codex-gateway-e2e-runner /usr/local/bin/codex-gateway-limited-task

ENTRYPOINT ["codex-gateway-e2e-runner"]

# The optional NAS topology installs project dependencies and browsers into bind mounts at
# runtime, keeping those large, replaceable files out of Docker's image and build-cache layers.
FROM runner-base AS nas-runtime
ENV E2E_NAS_MODE=1

FROM runner-base AS baked-runtime

# Turbo's task graph and workspace package sources are dependency inputs, not application inputs.
# Copy them before the mutable app tree so ordinary UI edits reuse pnpm and prebuilt vendor layers.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches ./patches
COPY packages ./packages
RUN --mount=type=cache,id=codex-gateway-e2e-pnpm-store,target=/pnpm/store \
  CODEX_GATEWAY_TASK_CPUS="$CODEX_GATEWAY_TASK_CPUS" \
    /usr/local/bin/codex-gateway-limited-task pnpm install --frozen-lockfile

# Install the browser revision required by the lockfile without depending on a
# separately published Playwright image tag.
RUN CODEX_GATEWAY_TASK_CPUS="$CODEX_GATEWAY_TASK_CPUS" \
  /usr/local/bin/codex-gateway-limited-task pnpm exec playwright install --with-deps chromium webkit

COPY . /workspace/source
