#!/usr/bin/env bash
set -euo pipefail

include_bots=false

case "${1:-}" in
  "")
    ;;
  --include-bots)
    include_bots=true
    ;;
  *)
    echo "Usage: $0 [--include-bots]" >&2
    exit 64
    ;;
esac

for command_name in gh jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

gh auth status >/dev/null

viewer="$(gh api user --jq '.login')"
work_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

gh search prs \
  --owner "$viewer" \
  --state open \
  --archived=false \
  --limit 1000 \
  --json number,title,url,isDraft,author,repository,updatedAt \
  >"$work_dir/personal.json" &
personal_pid=$!

gh search prs \
  --repo unjs/unhead \
  --state open \
  --limit 1000 \
  --json number,title,url,isDraft,author,repository,updatedAt \
  >"$work_dir/unhead.json" &
unhead_pid=$!

wait "$personal_pid"
wait "$unhead_pid"

if jq -e 'length == 1000' "$work_dir/personal.json" >/dev/null \
  || jq -e 'length == 1000' "$work_dir/unhead.json" >/dev/null; then
  echo "Discovery reached GitHub's 1,000 result cap; refusing incomplete triage." >&2
  exit 2
fi

jq -s --arg viewer "$viewer" --argjson include_bots "$include_bots" '
  add
  | unique_by(.url)
  | map(
      .isBot = (
        (.author.is_bot // false)
        or ((.author.login // "") | test("\\[bot\\]$"; "i"))
        or ((.author.type // "") == "Bot")
      )
      |
      .repository = .repository.nameWithOwner
      | .author = .author.login
    )
  | map(select(
      (.repository | ascii_downcase) != "nuxt/nuxt"
      and (
        ((.repository | split("/")[0] | ascii_downcase) == ($viewer | ascii_downcase))
        or ((.repository | ascii_downcase) == "unjs/unhead")
      )
      and (
        ((.repository | split("/")[0] | ascii_downcase) != "unjs")
        or ((.repository | ascii_downcase) == "unjs/unhead")
      )
      and ($include_bots or (.isBot | not))
    ))
  | sort_by(.updatedAt)
  | reverse
' "$work_dir/personal.json" "$work_dir/unhead.json"
