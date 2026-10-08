FROM node:22-bookworm AS preview-dependencies

RUN mkdir -p /opt/codex-preview-runtime \
  && npm install --prefix /opt/codex-preview-runtime ws@8.21.0
COPY preview-server.mjs /opt/codex-preview-runtime/preview-server.mjs

FROM node:14.21.3-bullseye-slim AS legacy-node-runtime

FROM node:22.23.1-bookworm-slim AS npm-codex-runtime

ARG CODEX_CLI_VERSION=0.140.0
RUN mkdir -p /tmp/codex-node \
  && cp -a /usr/local/. /tmp/codex-node/ \
  && npm install -g --prefix /tmp/codex-node @openai/codex@${CODEX_CLI_VERSION}

FROM node:22-bookworm AS current-codex-runtime

ARG CURRENT_CODEX_CLI_VERSION
ARG CODEX_RELEASE_TARGET=x86_64-unknown-linux-musl
COPY download-codex.sh /tmp/download-codex.sh
RUN --mount=type=bind,from=codex-release-cache,target=/codex-cache \
  bash /tmp/download-codex.sh "${CURRENT_CODEX_CLI_VERSION}" "${CODEX_RELEASE_TARGET}" /opt/codex-standalone /codex-cache \
  && rm /tmp/download-codex.sh

FROM debian:bookworm-slim AS ssh-base
COPY --from=preview-dependencies /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ARG E2E_UID=1000
ARG E2E_GID=1000
ARG E2E_DEBIAN_MIRROR

RUN if [ -n "$E2E_DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${E2E_DEBIAN_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-server git ca-certificates sudo tmux procps \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid ${E2E_GID} codex \
  && useradd --uid ${E2E_UID} --gid ${E2E_GID} --create-home --shell /bin/bash codex \
  && useradd --create-home --shell /bin/sh trainer \
  && echo 'codex:codex' | chpasswd \
  && usermod -aG sudo codex \
  && mkdir -p /run/sshd

COPY entrypoint.sh /usr/local/bin/codex-e2e-entrypoint
COPY --from=preview-dependencies /usr/local/bin/node /opt/codex-preview-runtime/bin/node
COPY --from=preview-dependencies /opt/codex-preview-runtime/node_modules /opt/codex-preview-runtime/node_modules
COPY --from=preview-dependencies /opt/codex-preview-runtime/preview-server.mjs /opt/codex-preview-runtime/preview-server.mjs
RUN chmod +x /usr/local/bin/codex-e2e-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/codex-e2e-entrypoint"]

FROM ssh-base AS empty-runtime
COPY nvidia-smi /usr/local/bin/nvidia-smi
COPY e2e-gpu-training /usr/local/bin/e2e-gpu-training
RUN chmod +x /usr/local/bin/nvidia-smi /usr/local/bin/e2e-gpu-training

FROM ssh-base AS legacy-node
COPY --from=legacy-node-runtime /usr/local/ /usr/local/

FROM ssh-base AS npm-codex
ARG E2E_UID=1000
ARG E2E_GID=1000
ENV E2E_NODE_DIR=/home/codex/.nvm/versions/node/v22.23.1
COPY --from=npm-codex-runtime /tmp/codex-node/ ${E2E_NODE_DIR}/
RUN chown -R ${E2E_UID}:${E2E_GID} /home/codex/.nvm \
  && printf '%s\n' 'export PATH="/home/codex/.nvm/versions/node/v22.23.1/bin:$PATH"' \
    >> /home/codex/.bashrc

FROM ssh-base AS mfa-runtime
ARG E2E_UID=1000
ARG E2E_GID=1000
ARG CURRENT_CODEX_CLI_VERSION
ARG CODEX_RELEASE_TARGET=x86_64-unknown-linux-musl
ENV CODEX_STANDALONE_RELEASE=${CURRENT_CODEX_CLI_VERSION}-${CODEX_RELEASE_TARGET}
COPY --from=current-codex-runtime /opt/codex-standalone /opt/codex-standalone
RUN apt-get update \
  && apt-get install -y --no-install-recommends libpam-modules \
  && rm -rf /var/lib/apt/lists/* \
  && echo 'codex:123456' | chpasswd \
  && mkdir -p \
    /home/codex/.codex/packages/standalone/releases/${CODEX_STANDALONE_RELEASE} \
    /home/codex/.local/bin \
  && cp -a /opt/codex-standalone/. \
    /home/codex/.codex/packages/standalone/releases/${CODEX_STANDALONE_RELEASE}/ \
  && ln -sfn \
    /home/codex/.codex/packages/standalone/releases/${CODEX_STANDALONE_RELEASE} \
    /home/codex/.codex/packages/standalone/current \
  && ln -sfn \
    /home/codex/.codex/packages/standalone/current/bin/codex \
    /home/codex/.local/bin/codex \
  && chown -R ${E2E_UID}:${E2E_GID} /home/codex/.codex /home/codex/.local
COPY mfa-sshd_config /etc/ssh/sshd_config
RUN printf '%s\n' \
    'auth required pam_unix.so' \
    'account required pam_permit.so' \
    'session required pam_permit.so' > /etc/pam.d/sshd
