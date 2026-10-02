#!/usr/bin/env bash
# Public GitHub reads use the machine account. Controller writes use ordinary gh.
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }

if [ "${1:-}" = --help ]; then
  printf '%s\n' 'Usage: agent-gh <GitHub CLI read command>' 'Public reads use harlan-agent-beep. The controller owns writes.'
  exit 0
fi
case "${1:-} ${2:-}" in
  'api '*)
    endpoint="${2:-}"
    [ -n "$endpoint" ] && [[ "$endpoint" != -* ]] || fail 'Provide the API endpoint before its options.'
    [[ "$endpoint" != *:* && "$endpoint" != *//* && "$endpoint" != *\\* ]] || fail 'Use a GitHub API path.'
    [ "${endpoint#/}" != graphql ] || fail 'Use GitHub CLI read commands instead of raw GraphQL.'
    previous=''
    for arg in "${@:3}"; do
      if [ "$previous" = method ]; then
        [ "$arg" = GET ] || fail 'Agents may only read GitHub.'
        previous=''
        continue
      fi
      case "$arg" in
        -X|--method) previous=method ;;
        -XGET|--method=GET) ;;
        -X*|--method*) fail 'Agents may only read GitHub.' ;;
        -H*|--header*|--hostname*|--input*) fail 'This API option is not allowed for public reads.' ;;
      esac
    done
    [ -z "$previous" ] || fail 'The API method needs a value.'
    set -- "$@" --method GET
    ;;
  'pr view'|'pr list'|'pr checks'|'pr diff'|\
  'issue view'|'issue list'|'repo view'|'repo list'|\
  'search code'|'search commits'|'search issues'|'search prs'|'search repos'|\
  'run view'|'run list'|'run download'|'release view'|'release list'|'release download') ;;
  *) fail 'Agents may only read public GitHub data. The controller owns GitHub writes.' ;;
esac
for arg in "$@"; do
  case "$arg" in
    --web|-w|--hostname*|--host*) fail 'Use the GitHub API without opening a browser or changing hosts.' ;;
  esac
done

token_file="$HOME/.config/harlan-agent-kit/github-public-token"
[ -f "$token_file" ] && [ ! -L "$token_file" ] || fail "The public GitHub token is missing: $token_file"
[ "$(stat -c '%a:%u' "$token_file")" = "600:$(id -u)" ] || fail 'The public GitHub token needs owner-only access. Run chmod 600 on its file.'
GH_TOKEN=$(< "$token_file")
[[ "$GH_TOKEN" = github_pat_* ]] || fail 'Use a fine-grained token with Public repositories access and no account permissions.'
export GH_TOKEN GH_HOST=github.com GH_PROMPT_DISABLED=1
export GH_CONFIG_DIR="$HOME/.config/harlan-agent-kit/gh-public"
unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG

# Use trusted host binaries, never a repository binary that can capture the token.
self=$(readlink -f "${BASH_SOURCE[0]}")
for binary in "$HOME/.local/bin/gh" /usr/local/bin/gh /usr/bin/gh /bin/gh; do
  [ -x "$binary" ] || continue
  candidate=$(readlink -f "$binary")
  [ "$candidate" != "$self" ] || continue
  # Both installation names carry the same wrapper. Skip its worker directory.
  case "$candidate" in
    "$HOME/.local/share/harlan-agent-kit/github-bin/gh"|"$HOME/.local/bin/agent-gh") continue ;;
  esac
  exec "$candidate" "$@"
done
fail 'The GitHub CLI is missing.'
