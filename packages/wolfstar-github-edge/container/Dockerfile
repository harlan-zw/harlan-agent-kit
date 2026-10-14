# The Wolfstar GitHub Agent controller, as one Cloudflare Container.
# Build context: the repository root. See packages/wolfstar-github-edge/wrangler.jsonc.
FROM node:24-bookworm

ARG WORKTRUNK_VERSION=v0.74.0
ARG WORKTRUNK_SHA256=28392033912ab0a9027192d9975284787b29f080b4f2fd6298c89fffecf34c1f

# git for the controller, bubblewrap for the Agent sandbox, ripgrep and jq for the Agents.
RUN set -eux; \
  mkdir -p -m 755 /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends bubblewrap gh git jq ripgrep rsync util-linux xz-utils; \
  rm -rf /var/lib/apt/lists/*

# Worktrunk owns every worktree. Same pin and checksum as CI.
RUN set -eux; \
  archive=worktrunk-x86_64-unknown-linux-musl.tar.xz; \
  curl -fsSL -o "/tmp/$archive" "https://github.com/max-sixty/worktrunk/releases/download/$WORKTRUNK_VERSION/$archive"; \
  echo "$WORKTRUNK_SHA256  /tmp/$archive" | sha256sum --check; \
  tar -xJf "/tmp/$archive" -C /tmp --strip-components=1 "worktrunk-x86_64-unknown-linux-musl/wt"; \
  install /tmp/wt /usr/local/bin/wt; \
  rm "/tmp/$archive" /tmp/wt; \
  wt --version

RUN corepack enable

USER node
ENV HOME=/home/node
# pnpm's global directory, for skilld. The Agent sandbox already trusts it for host tools.
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=/home/node/.local/share/pnpm/bin:$PATH
WORKDIR /home/node/wolfstar-agent-kit

COPY --chown=node:node . .

# pnpm comes from `packageManager`. The Claude and Codex CLIs come with their SDKs.
# node-gyp builds node-pty against the headers this image already ships, instead of downloading them.
ENV npm_config_nodedir=/usr/local
RUN corepack install \
  && pnpm install --frozen-lockfile \
  && pnpm --filter wolfstar-github-agent dashboard:build

# The Agent tools the sandbox mounts: codex, opencode v2, gh, wt, rg, fd. Each download is checksum checked.
# The installer reads release metadata through agent-gh, which needs a public GitHub token the build lacks.
# A build-only stand-in makes the same unauthenticated read, and is removed before the real wrapper lands.
RUN set -eu; \
  mkdir -p "$HOME/.local/bin"; \
  printf '%s\n' '#!/bin/sh' 'case "$1" in api) exec curl -fsSL "https://api.github.com/$2" ;; esac' 'exit 1' > "$HOME/.local/bin/agent-gh"; \
  chmod 755 "$HOME/.local/bin/agent-gh"; \
  node --experimental-strip-types scripts/agent-tools.ts; \
  rm "$HOME/.local/bin/agent-gh"

# The global Agent instructions, hooks, and the skilld Skills the controller requires at start.
ARG SKILLD_VERSION=3.6.8
RUN pnpm add --global "skilld@$SKILLD_VERSION" \
  && bash scripts/sync-agent-context.sh local \
  && pnpm sync:skills

ENTRYPOINT ["node", "--experimental-strip-types", "packages/wolfstar-github-agent/src/cloudflare-container.ts"]
