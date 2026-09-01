#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
asset_script="$script_dir/pr-asset.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

# A stub wrangler records its arguments instead of reaching Cloudflare.
mkdir -p "$test_root/bin"
cat > "$test_root/bin/wrangler" << 'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$WRANGLER_ARGS_FILE"
STUB
chmod +x "$test_root/bin/wrangler"
export PATH="$test_root/bin:$PATH"
export WRANGLER_ARGS_FILE="$test_root/wrangler-args"

cat > "$test_root/pr-assets.env" << 'ENV'
CLOUDFLARE_ACCOUNT_ID=account-under-test
PR_ASSETS_BUCKET=bucket-under-test
PR_ASSETS_BASE_URL=https://assets.example.com
ENV
export PR_ASSETS_CONFIG="$test_root/pr-assets.env"

repo="$test_root/repo"
git init -q "$repo"
git -C "$repo" remote add origin https://github.com/harlan-zw/nuxt-seo.git
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
git -C "$repo" commit -q --allow-empty -m seed
git -C "$repo" checkout -qb fix/og-image
echo shot > "$repo/after.png"

if bash "$asset_script" > /dev/null 2>&1; then
  echo 'a missing file argument was accepted' >&2
  exit 1
fi

if bash "$asset_script" "$test_root/absent.png" > /dev/null 2>&1; then
  echo 'a file that does not exist was accepted' >&2
  exit 1
fi

if PR_ASSETS_CONFIG="$test_root/absent.env" CLOUDFLARE_ACCOUNT_ID= \
  bash "$asset_script" "$repo/after.png" > /dev/null 2>&1; then
  echo 'a missing account id was accepted' >&2
  exit 1
fi

url=$(cd "$repo" && bash "$asset_script" after.png)
if [[ "$url" != 'https://assets.example.com/nuxt-seo/fix/og-image/after.png' ]]; then
  echo "default key came back wrong: $url" >&2
  exit 1
fi

args=$(tr '\n' ' ' < "$WRANGLER_ARGS_FILE")
if [[ "$args" != *'bucket-under-test/nuxt-seo/fix/og-image/after.png'* ]]; then
  echo "wrangler received the wrong object path: $args" >&2
  exit 1
fi
if [[ "$args" != *'--content-type image/png'* ]]; then
  echo "wrangler received the wrong content type: $args" >&2
  exit 1
fi
if [[ "$args" != *'--remote'* ]]; then
  echo 'the upload did not target the remote bucket' >&2
  exit 1
fi
if [[ "$args" != *'--cache-control public, max-age=300'* ]]; then
  echo "a replaced image could stay cached at the edge: $args" >&2
  exit 1
fi

url=$(cd "$repo" && bash "$asset_script" after.png 'my repo/a branch?/shot one.png')
if [[ "$url" != 'https://assets.example.com/my-repo/a-branch-/shot-one.png' ]]; then
  echo "an explicit key was not made URL safe: $url" >&2
  exit 1
fi

sha=$(git -C "$repo" rev-parse --short HEAD)
url=$(cd "$repo" && git checkout -q --detach && bash "$asset_script" after.png)
if [[ "$url" != "https://assets.example.com/nuxt-seo/$sha/after.png" ]]; then
  echo "a detached HEAD did not fall back to the commit: $url" >&2
  exit 1
fi

echo 'pr-asset.sh ok'
