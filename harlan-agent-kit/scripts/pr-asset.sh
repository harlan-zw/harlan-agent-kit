#!/usr/bin/env bash
# Upload one file to the PR asset bucket and print its public URL.
#
# Usage: pr-asset.sh <file> [key]
#
# The key defaults to <repo>/<branch>/<basename>, with a content hash before the
# extension. Different bytes mean a different URL, so a replaced image is never
# served stale from the edge. Identical bytes reuse the same object.
#
# Only curl is required. The service host runs this with no package manager and
# no wrangler, so the R2 REST API does the upload directly.
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

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "pr-asset.sh: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or write them to $CONFIG." >&2
  exit 2
fi

BUCKET="${PR_ASSETS_BUCKET:-harlan-pr-assets}"
BASE_URL="${PR_ASSETS_BASE_URL:-https://pr.harlanzw.com}"
API_URL="${PR_ASSETS_API_URL:-https://api.cloudflare.com/client/v4}"

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

# The zone rewrites Cache-Control on this domain, so a stable key would serve
# the old image for hours. Address the object by its content instead.
DIGEST="$(sha256sum "$FILE" | cut -c1-8)"
KEY_BASE="${KEY%.*}"
KEY_EXT="${KEY##*.}"
if [ "$KEY_BASE" = "$KEY" ]; then
  KEY="${KEY}-${DIGEST}"
else
  KEY="${KEY_BASE}-${DIGEST}.${KEY_EXT}"
fi

case "${FILE##*.}" in
  png) CONTENT_TYPE="image/png" ;;
  jpg | jpeg) CONTENT_TYPE="image/jpeg" ;;
  gif) CONTENT_TYPE="image/gif" ;;
  webp) CONTENT_TYPE="image/webp" ;;
  svg) CONTENT_TYPE="image/svg+xml" ;;
  mp4) CONTENT_TYPE="video/mp4" ;;
  *) CONTENT_TYPE="application/octet-stream" ;;
esac

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

STATUS="$(curl -sS -X PUT \
  "${API_URL}/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${KEY}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: ${CONTENT_TYPE}" \
  -H "Cache-Control: public, max-age=300" \
  --data-binary "@${FILE}" \
  -o "$BODY_FILE" \
  -w '%{http_code}')"

if [ "$STATUS" != "200" ]; then
  echo "pr-asset.sh: upload failed with HTTP ${STATUS}." >&2
  head -c 500 "$BODY_FILE" >&2
  echo >&2
  exit 1
fi

echo "${BASE_URL}/${KEY}"
