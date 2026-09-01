#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
asset_script="$script_dir/pr-asset.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

# A stub curl records its arguments instead of reaching Cloudflare.
mkdir -p "$test_root/bin"
cat > "$test_root/bin/curl" << 'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CURL_ARGS_FILE"
printf '%s' "${CURL_STATUS:-200}"
STUB
chmod +x "$test_root/bin/curl"
export PATH="$test_root/bin:$PATH"
export CURL_ARGS_FILE="$test_root/curl-args"

cat > "$test_root/pr-assets.env" << 'ENV'
CLOUDFLARE_ACCOUNT_ID=account-under-test
CLOUDFLARE_API_TOKEN=token-under-test
PR_ASSETS_BUCKET=bucket-under-test
PR_ASSETS_BASE_URL=https://assets.example.com
PR_ASSETS_API_URL=https://api.example.com/client/v4
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

if PR_ASSETS_CONFIG="$test_root/absent.env" CLOUDFLARE_ACCOUNT_ID= CLOUDFLARE_API_TOKEN= \
  bash "$asset_script" "$repo/after.png" > /dev/null 2>&1; then
  echo 'a missing account id was accepted' >&2
  exit 1
fi

if PR_ASSETS_CONFIG="$test_root/absent.env" CLOUDFLARE_ACCOUNT_ID=account-under-test CLOUDFLARE_API_TOKEN= \
  bash "$asset_script" "$repo/after.png" > /dev/null 2>&1; then
  echo 'a missing api token was accepted' >&2
  exit 1
fi

digest=$(sha256sum "$repo/after.png" | cut -c1-8)
if [[ "$digest" != 'd75bbc90' ]]; then
  echo "the fixture content changed, update the expected digest: $digest" >&2
  exit 1
fi

url=$(cd "$repo" && bash "$asset_script" after.png)
if [[ "$url" != "https://assets.example.com/nuxt-seo/fix/og-image/after-$digest.png" ]]; then
  echo "default key came back wrong: $url" >&2
  exit 1
fi

# Same bytes, same URL, so an unchanged screenshot does not churn the comment.
again=$(cd "$repo" && bash "$asset_script" after.png)
if [[ "$again" != "$url" ]]; then
  echo "identical content produced two URLs: $url then $again" >&2
  exit 1
fi

# Changed bytes must never reuse a URL the edge already cached.
echo changed > "$repo/after.png"
changed=$(cd "$repo" && bash "$asset_script" after.png)
if [[ "$changed" == "$url" ]]; then
  echo "changed content reused the cached URL: $changed" >&2
  exit 1
fi
echo shot > "$repo/after.png"
# Restore the canonical upload, so the recorded request is the one asserted below.
url=$(cd "$repo" && bash "$asset_script" after.png)

args=$(tr '\n' ' ' < "$CURL_ARGS_FILE")
if [[ "$args" != *"https://api.example.com/client/v4/accounts/account-under-test/r2/buckets/bucket-under-test/objects/nuxt-seo/fix/og-image/after-$digest.png"* ]]; then
  echo "curl received the wrong object URL: $args" >&2
  exit 1
fi
if [[ "$args" != *'Authorization: Bearer token-under-test'* ]]; then
  echo 'the upload was not authenticated' >&2
  exit 1
fi
if [[ "$args" != *'Content-Type: image/png'* ]]; then
  echo "curl received the wrong content type: $args" >&2
  exit 1
fi
if [[ "$args" != *'Cache-Control: public, max-age=300'* ]]; then
  echo "a replaced image could stay cached at the edge: $args" >&2
  exit 1
fi

url=$(cd "$repo" && bash "$asset_script" after.png 'my repo/a branch?/shot one.png')
if [[ "$url" != "https://assets.example.com/my-repo/a-branch-/shot-one-$digest.png" ]]; then
  echo "an explicit key was not made URL safe: $url" >&2
  exit 1
fi

sha=$(git -C "$repo" rev-parse --short HEAD)
url=$(cd "$repo" && git checkout -q --detach && bash "$asset_script" after.png)
if [[ "$url" != "https://assets.example.com/nuxt-seo/$sha/after-$digest.png" ]]; then
  echo "a detached HEAD did not fall back to the commit: $url" >&2
  exit 1
fi

if CURL_STATUS=403 bash -c "cd '$repo' && bash '$asset_script' after.png" > /dev/null 2>&1; then
  echo 'a rejected upload still printed a URL' >&2
  exit 1
fi

echo 'pr-asset.sh ok'
