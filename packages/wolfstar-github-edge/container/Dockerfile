# The Wolfstar GitHub Agent controller, as one Cloudflare Container.
# Build context: the repository root. See packages/wolfstar-github-edge/wrangler.jsonc.
FROM node:24-bookworm

ARG WORKTRUNK_VERSION=v0.74.0
ARG WORKTRUNK_SHA256=28392033912ab0a9027192d9975284787b29f080b4f2fd6298c89fffecf34c1f
# A pinned version skips the installer's GitHub API lookup, which a shared build host can exhaust.
ARG OPENCODE_VERSION=1.19.0

# git and gh for the controller and its Agents, ripgrep and jq for the Agents.
RUN set -eux; \
  mkdir -p -m 755 /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends gh git jq ripgrep rsync xz-utils; \
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
WORKDIR /home/node/wolfstar-agent-kit

# opencode installs into ~/.opencode/bin, which the controller adds to each Agent's PATH.
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "$OPENCODE_VERSION" --no-modify-path

COPY --chown=node:node . .

# pnpm comes from `packageManager`. The Claude and Codex CLIs come with their SDKs.
RUN corepack install \
  && pnpm install --frozen-lockfile \
  && pnpm --filter wolfstar-github-agent dashboard:build

# The global Agent instructions, hooks, and skills every Worker inherits on Hogwild.
RUN bash scripts/sync-agent-context.sh local

ENTRYPOINT ["node", "--experimental-strip-types", "packages/wolfstar-github-agent/src/cloudflare-container.ts"]
