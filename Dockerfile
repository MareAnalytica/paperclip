# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/paperclip-cost-client/package.json packages/paperclip-cost-client/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/plugins/sandbox-providers/cloudflare/package.json packages/plugins/sandbox-providers/cloudflare/
COPY packages/plugins/sandbox-providers/daytona/package.json packages/plugins/sandbox-providers/daytona/
COPY packages/plugins/sandbox-providers/e2b/package.json packages/plugins/sandbox-providers/e2b/
COPY packages/plugins/sandbox-providers/exe-dev/package.json packages/plugins/sandbox-providers/exe-dev/
COPY packages/plugins/sandbox-providers/modal/package.json packages/plugins/sandbox-providers/modal/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
ARG KUBECTL_VERSION=v1.34.4

# DEE-708: split the former single ~745 MB production layer into smaller per-tool
# layers. A single 745 MB blob PUT crossed the registry ingress' ~60s proxy timeout
# (the registry pod is CPU-limited to 200m and streams the sha256 at ~8 MB/s),
# causing repeated client-disconnect / HTTP 499 push failures that blocked all image
# promotion. Keeping each global npm CLI / kubectl / apt set in its own layer keeps
# every blob comfortably under the timeout — with no shared registry/ingress change.

# Runtime system packages (apt update+install+clean stay in one layer per apt best practice).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# kubectl in its own layer (~50 MB), checksum-verified.
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" -o /tmp/kubectl.sha256 \
  && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl \
  && rm /tmp/kubectl.sha256

# Global CLIs — one package per layer so no single blob approaches the registry timeout.
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest
RUN npm install --global --omit=dev @openai/codex@latest
RUN npm install --global --omit=dev opencode-ai

# grok_local CLI in its own layer (~125 MB), checksum-verified — DEE-745 / DEE-707.
# Bake the pinned build into the image so a fresh HOME PVC or a new tenant can never
# silently (re)install a drifting grok via its internal updater. The runtime adapter
# resolves `grok` from PATH (server/src/adapters/registry.ts: installCommand=null), so a
# baked /usr/local/bin/grok is the only install path and can no longer re-skew the
# --output-format vocabulary (root cause: DEE-707; dev-only PVC pin: DEE-709).
# Pinned to grok 0.2.13 (3509a8da4). Upstream publishes no checksum file, so we pin the
# exact bytes verified against the DEE-709 build. amd64-only, matching the kubectl line.
ARG GROK_VERSION=0.2.13
ARG GROK_SHA256=f82449fabe188d7fe4cd43e35fab3cd464684d8b1a34f6e3fa05fd414c430edc
RUN curl -fsSL "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_VERSION}-linux-x86_64" -o /usr/local/bin/grok \
  && echo "${GROK_SHA256}  /usr/local/bin/grok" | sha256sum -c - \
  && chmod +x /usr/local/bin/grok

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GROK_DISABLE_UPDATE_CHECK=1

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
