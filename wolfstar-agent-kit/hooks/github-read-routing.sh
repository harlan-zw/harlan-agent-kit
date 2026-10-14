#!/usr/bin/env bash
# PreToolUse (Bash): keep public reads on the separate GitHub account.
source "$(dirname "$0")/check-config.sh"
source "$(dirname "$0")/command-text.sh"
is_hook_disabled "github-read-routing" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // .tool_input.cmd // empty')
[ -n "$command" ] || exit 0
code=$(command_code "$command" true)

# The private exception belongs to one invocation and one explicit repository.
# It cannot grant the following command access to the ordinary account.
lead_item='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env([[:space:]]+(-u[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|--unset=[^[:space:]]+|-i|--ignore-environment))*|timeout([[:space:]]+[^[:space:]]+)?|bash[[:space:]]+-c|sh[[:space:]]+-c|command|exec|do|then|else|!'
lead="((${lead_item})[[:space:]]+)*"
global_repo='((--repo|-R)[[:space:]]+[^[:space:]]+[[:space:]]+|--repo=[^[:space:]]+[[:space:]]+)*'
read_call="^[[:space:]\(\`]*${lead}([^[:space:]]*/)?gh[[:space:]]+${global_repo}(api|pr|issue|run|repo|search|release)[[:space:]]+([^[:space:]]+)"
IFS=';|&' read -r -a calls <<< "$code"
for call in "${calls[@]}"; do
  [[ "$call" =~ $read_call ]] || continue
  invocation=${BASH_REMATCH[0]}
  family=${BASH_REMATCH[9]}
  action=${BASH_REMATCH[10]}
  # GitHub writes retain the existing approval and PR-skill rules.
  if [ "$family" = api ]; then
    [[ "$call" =~ [[:space:]](-X[[:space:]]*|--method[=[:space:]]+)(POST|PATCH|PUT|DELETE)([[:space:]]|$) ]] && continue
    [[ "$action" = user && "$call" != *'graphql'* ]] && continue
  else
    case "$family $action" in
      'pr view'|'pr list'|'pr checks'|'pr diff'|'issue view'|'issue list'|\
      'repo view'|'repo list'|'run view'|'run list'|'run watch'|'run download'|\
      'search '*|'release view'|'release list'|'release download') ;;
      *) continue ;;
    esac
  fi

  # A private credential exception must not permit three-second CI polling.
  if [[ "$family $action" = 'run watch' ]] || \
    { [[ "$family $action" = 'pr checks' ]] && [[ "$call" =~ [[:space:]]--watch(=true)?([[:space:]]|$) ]]; }; then
    interval=''
    pending=false
    read -r -a watch_words <<< "$call"
    for word in "${watch_words[@]}"; do
      if [ "$pending" = true ]; then interval=$word; pending=false; continue; fi
      case "$word" in
        --interval|-i) pending=true ;;
        --interval=*) interval=${word#--interval=} ;;
        -i[0-9]*) interval=${word#-i} ;;
      esac
    done
    if [ "$pending" = true ] || [[ ! "$interval" =~ ^[0-9]{1,9}$ ]] || ((10#$interval < 60)); then
      reason='If you must watch private CI, set --interval 60 or higher. Use the Service Control API for tracked pull requests.'
      jq -nc --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
      exit 0
    fi
  fi

  private='WOLFSTAR_AGENT_GITHUB_PRIVATE=([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)([[:space:]]|$)'
  if [[ "$invocation" =~ $private ]]; then
    repository=${BASH_REMATCH[1]}
    # API paths and explicit CLI repository arguments must match the exception.
    if [ "$family" = api ]; then
      [[ "$action" == "repos/$repository" || "$action" == "repos/$repository/"* \
        || "$action" == "/repos/$repository" || "$action" == "/repos/$repository/"* ]] && continue
    else
      matched=false
      mismatch=false
      read -r -a words <<< "$call"
      for ((index=0; index<${#words[@]}; index++)); do
        case "${words[$index]}" in
          --repo|-R)
            value=${words[$((index+1))]:-}
            if [ "$value" = "$repository" ]; then matched=true; else mismatch=true; fi ;;
          --repo=*)
            value=${words[$index]#--repo=}
            if [ "$value" = "$repository" ]; then matched=true; else mismatch=true; fi ;;
        esac
      done
      view='[[:space:]]repo[[:space:]]+view[[:space:]]+([^[:space:]]+)'
      if [[ "$call" =~ $view && "${BASH_REMATCH[1]}" = "$repository" ]]; then matched=true; fi
      [ "$matched" = true ] && [ "$mismatch" = false ] && continue
    fi
  fi
  reason='Use agent-gh for public GitHub reads. For verified private repositories, set WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/repo on that command. Specify the same repository. Never switch credentials after agent-gh fails. Use the Service Control API to watch a tracked pull request.'
  jq -nc --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
done
