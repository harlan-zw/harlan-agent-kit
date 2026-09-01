#!/usr/bin/env bash
# Upload one file to the PR asset bucket and print its public URL.
#
# Usage: pr-asset.sh <file> [key]
#
# The key defaults to <repo>/<branch>/<basename>. Every upload overwrites the
# same key, so a rerun on the same branch replaces the image in place.
set -euo pipefail

CONFIG="${PR_ASSETS_CONFIG:-$HOME/.config/harlan-agent-kit/pr-assets.env}"
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "pr-asset.sh: pass the file to upload." >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "pr-asset.sh: no file at $FILE." >&2
  exit 2
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "pr-asset.sh: set CLOUDFLARE_ACCOUNT_ID, or write it to $CONFIG." >&2
  exit 2
fi

BUCKET="${PR_ASSETS_BUCKET:-harlan-pr-assets}"
BASE_URL="${PR_ASSETS_BASE_URL:-https://pr.harlanzw.com}"

KEY="${2:-}"
if [ -z "$KEY" ]; then
  # The remote name, so every worktree of one repository shares a prefix.
  REPO="$(basename -s .git "$(git remote get-url origin 2>/dev/null)" 2>/dev/null || true)"
  if [ -z "$REPO" ]; then
    REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  fi
  # Empty on a detached HEAD, where the commit identifies the upload instead.
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  if [ -z "$BRANCH" ]; then
    BRANCH="$(git rev-parse --short HEAD 2>/dev/null || echo detached)"
  fi
  KEY="${REPO}/${BRANCH}/$(basename "$FILE")"
fi
# Slashes separate the key. Everything else stays URL safe.
KEY="$(printf '%s' "$KEY" | tr -c 'A-Za-z0-9._/-' '-')"

case "${FILE##*.}" in
  png) CONTENT_TYPE="image/png" ;;
  jpg | jpeg) CONTENT_TYPE="image/jpeg" ;;
  gif) CONTENT_TYPE="image/gif" ;;
  webp) CONTENT_TYPE="image/webp" ;;
  svg) CONTENT_TYPE="image/svg+xml" ;;
  mp4) CONTENT_TYPE="video/mp4" ;;
  *) CONTENT_TYPE="application/octet-stream" ;;
esac

if command -v wrangler > /dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  WRANGLER=(pnpm dlx wrangler@4)
fi

# A rerun reuses the key, so the edge must not hold the old image for long.
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" "${WRANGLER[@]}" r2 object put \
  "${BUCKET}/${KEY}" \
  --file "$FILE" \
  --content-type "$CONTENT_TYPE" \
  --cache-control "public, max-age=300" \
  --remote > /dev/null

echo "${BASE_URL}/${KEY}"
