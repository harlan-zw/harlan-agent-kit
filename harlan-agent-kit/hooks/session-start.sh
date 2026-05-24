#!/bin/bash

# Context-aware session start
# Detects project type, shows relevant info

source "$(dirname "$0")/check-config.sh"

# Read input from stdin
input=$(cat)
agent_type=$(echo "$input" | jq -r '.agent_type // empty')

# Quiet mode for sub-agents - only show warnings
quiet=""
[ "$agent_type" = "task" ] && quiet=1

branch=$(git branch --show-current 2>/dev/null || echo "")

show() { [ -z "$quiet" ] && echo -e "\033[36m$1\033[0m"; }
dim() { [ -z "$quiet" ] && echo -e "\033[90m$1\033[0m"; }
warn() { echo -e "\033[33m$1\033[0m"; }

# Check for package.json
if [ -f "package.json" ]; then
  name=$(jq -r '.name // "unnamed"' package.json 2>/dev/null)

  # Detect project type
  if [ -f "src/module.ts" ] || grep -q "nuxt-module-build" package.json 2>/dev/null; then
    show "Nuxt Module: $name"
  elif [ -f "nuxt.config.ts" ]; then
    show "Nuxt App: $name"
  elif [ -f "build.config.ts" ]; then
    show "UnJS Package: $name"
  elif grep -q '"vue"' package.json 2>/dev/null; then
    show "Vue Project: $name"
  else
    show "Node Project: $name"
  fi

  # Git info (branch already cached above)
  if [ -n "$branch" ]; then
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
      dim "Branch: $branch (dirty)"
    else
      dim "Branch: $branch"
    fi

    # Last commit
    last=$(git log -1 --format="%s" 2>/dev/null | head -c 50)
    [ -n "$last" ] && dim "Last: $last"
  fi

  # Package manager check
  if [ -f "pnpm-lock.yaml" ]; then
    :
  elif [ -f "package-lock.json" ]; then
    warn "npm detected - use pnpm"
  elif [ -f "yarn.lock" ]; then
    warn "yarn detected - use pnpm"
  fi
fi

# CLAUDE.md hint
if [ ! -f ".claude/CLAUDE.md" ] && [ ! -f "CLAUDE.md" ]; then
  dim "Tip: /init-module to add CLAUDE.md"
fi

