#!/usr/bin/env bash
# PreToolUse (Bash): require the PR skill and valid PR body for creation and description changes.

source "$(dirname "$0")/check-config.sh"
source "$(dirname "$0")/command-text.sh"
source "$(dirname "$0")/hit-log.sh"
is_hook_disabled "pr-skill-only" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // .tool_input.cmd // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

[ -n "$command" ] || exit 0

deny() {
  local reason="$1"
  jq -nc --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  log_hook_hit deny "$reason" "$input"
  exit 0
}

# A multi-line call puts gh on its own line, so the text is normalized first.
# Without this, a heredoc followed by gh pr create passes the hook unseen.
code=$(command_code "$command")

command_start='(^[[:space:]]*|[|&;\(`][[:space:]]*)'
# An inline assignment or an env or timeout wrapper keeps gh at the command
# position, so the patterns must see through a leading prefix of them.
lead_item='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|timeout([[:space:]]+[^[:space:]]+)?'
lead="((${lead_item})[[:space:]]+)*"
# The allow patterns accept other inline assignments (such as
# HARLAN_AGENT_GITHUB_PRIVATE=owner/repo) and wrappers around
# HARLAN_AGENT_PR_SKILL=1, while rejecting a later override to another value.
skill_lead="${lead}HARLAN_AGENT_PR_SKILL=1[[:space:]]+${lead}"
skill_override='HARLAN_AGENT_PR_SKILL=1[[:space:]].*HARLAN_AGENT_PR_SKILL=([^1[:space:]]|1[^[:space:]]|$|[[:space:]])'
body_flag='(--body-file|--body|-b|-F)(=|[[:space:]]|$)'
pr_create="${command_start}${lead}gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
pr_body_edit="${command_start}${lead}gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*${body_flag}"
skill_create="${command_start}${skill_lead}gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
skill_body_edit="${command_start}${skill_lead}gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*${body_flag}"

is_skill_call=false
is_create=false
if [[ "$code" =~ $skill_create ]]; then
  if [[ ! "${BASH_REMATCH[0]}" =~ $skill_override ]]; then
    is_skill_call=true
    is_create=true
  fi
elif [[ "$code" =~ $skill_body_edit ]]; then
  if [[ ! "${BASH_REMATCH[0]}" =~ $skill_override ]]; then
    is_skill_call=true
  fi
fi

if [ "$is_skill_call" = false ]; then
  if [[ "$code" =~ $pr_create ]] || [[ "$code" =~ $pr_body_edit ]]; then
    deny 'Use the Harlan Agent Kit PR skill: `harlan-agent-kit:pr`. Claude Code invokes it as `/harlan-agent-kit:pr`. Codex invokes it as `$harlan-agent-kit:pr`. Antigravity loads the `pr` skill. It loads the repository template and required disclosure.'
  fi
  exit 0
fi

# Resolve the target directory from an explicit `cd` in the command or hook cwd.
base_dir="${cwd:-$PWD}"
target_dir="$base_dir"
cd_re='(^|[|&;\(])[[:space:]]*cd[[:space:]]+([^[:space:]|&;\)]+)'
IFS=';|&' read -r -a segments <<< "$code"
gh_segment=""
for segment in "${segments[@]}"; do
  if [[ "$segment" =~ $skill_create ]] || [[ "$segment" =~ $skill_body_edit ]]; then
    gh_segment="$segment"
    break
  fi
  if [[ "$segment" =~ $cd_re ]]; then
    candidate="${BASH_REMATCH[2]}"
    if [ "$candidate" != "-" ]; then
      candidate="${candidate/#\~/$HOME}"
      if [[ "$candidate" = /* ]]; then
        target_dir="$candidate"
      else
        target_dir="$target_dir/$candidate"
      fi
    fi
  fi
done

# Also inspect quoted `cd "..."` if the unquoted scan left target_dir unchanged.
nl=$'\n'
quoted_cd_re="(^|[|&;\(${nl}])[[:space:]]*cd[[:space:]]+['\"]([^'\"${nl}]+)['\"]"
if [ "$target_dir" = "$base_dir" ] && [[ "$command" =~ $quoted_cd_re ]]; then
  candidate="${BASH_REMATCH[2]/#\~/$HOME}"
  if [[ "$candidate" = /* ]]; then
    target_dir="$candidate"
  else
    target_dir="$base_dir/$candidate"
  fi
fi

# Require an explicit body on creation; --fill and empty bodies skip the template.
if [ "$is_create" = true ] && [[ ! "$gh_segment" =~ [[:space:]]${body_flag} ]]; then
  deny 'Pass --body or --body-file formatted with the Harlan Agent Kit PR skill instead of --fill or an empty body.'
fi

# Extract body text from --body-file / -F when it points to an existing file not written in this command.
body_text="$command"
body_file_re="(--body-file|-F)(=|[[:space:]]+)['\"]?([^'\"[:space:]|&;\)]+)['\"]?"
cat_file_re="\\\$\\(cat[[:space:]]+['\"]?([^'\"[:space:]|&;\)]+)['\"]?[[:space:]]*\\)"
if [[ "$gh_segment" =~ [[:space:]](--body-file|-F)(=|[[:space:]]|$) ]]; then
  body_file=""
  if [[ "$command" =~ $body_file_re ]]; then
    body_file="${BASH_REMATCH[3]}"
  fi
  if [ -n "$body_file" ] && [ "$body_file" != "-" ] && [[ "$command" != *'<<'* ]]; then
    body_file="${body_file/#\~/$HOME}"
    resolved_file="$body_file"
    if [[ "$body_file" != /* ]]; then
      if [ -f "$target_dir/$body_file" ]; then
        resolved_file="$target_dir/$body_file"
      elif [ -f "$base_dir/$body_file" ]; then
        resolved_file="$base_dir/$body_file"
      fi
    fi
    if [ -f "$resolved_file" ]; then
      body_text=$(cat "$resolved_file")
    fi
  fi
elif [[ "$command" != *'<<'* ]] && [[ "$command" =~ $cat_file_re ]]; then
  cat_file="${BASH_REMATCH[1]/#\~/$HOME}"
  if [[ "$cat_file" != /* ]] && [ -f "$target_dir/$cat_file" ]; then
    cat_file="$target_dir/$cat_file"
  fi
  if [ -f "$cat_file" ]; then
    body_text=$(cat "$cat_file")
  fi
fi

disclosure='> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'
if ! printf '%s\n' "$body_text" | grep -Fq -- "$disclosure"; then
  deny 'PR body is missing the required AI disclosure. Re-read the Harlan Agent Kit PR skill (`pr`) and use the repository PR template with the exact disclosure line.'
fi

# Strip fenced code blocks before checking headings so markdown examples do not false-positive.
body_no_fences=$(printf '%s\n' "$body_text" | awk '
  /^[[:space:]]*(```|~~~)/ { in_fence = !in_fence; next }
  !in_fence { print }
')

if printf '%s\n' "$body_no_fences" | grep -Eiq '^[[:space:]]*#{1,6}[[:space:]]+(verification|test[[:space:]]+plan|testing|qa)[[:space:]]*:?[[:space:]]*$'; then
  deny 'Omit verification, testing, and QA sections from the PR description. Follow the Harlan Agent Kit PR skill verification comment rule instead.'
fi

# Enforce the harlan-zw PR template headings when the repository uses that template.
require_harlan_template=false
explicit_repo=""
if [[ "$gh_segment" =~ [[:space:]](--repo|-R)(=|[[:space:]]+)([^[:space:]|&;\)]+) ]]; then
  explicit_repo="${BASH_REMATCH[3]}"
elif [[ "$command" =~ [[:space:]](--repo|-R)(=|[[:space:]]+)[\'\"]?([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)[\'\"]? ]]; then
  explicit_repo="${BASH_REMATCH[3]}"
fi

repo_root=""
if [ -d "$target_dir" ]; then
  repo_root=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
fi

local_template=""
if [ -n "$repo_root" ]; then
  for candidate in \
    "$repo_root/.github/PULL_REQUEST_TEMPLATE.md" \
    "$repo_root/.github/pull_request_template.md" \
    "$repo_root/docs/PULL_REQUEST_TEMPLATE.md" \
    "$repo_root/docs/pull_request_template.md"; do
    if [ -f "$candidate" ]; then
      local_template="$candidate"
      break
    fi
  done
fi

if [ -n "$local_template" ]; then
  if grep -Fq '### ❓ Type of change' "$local_template" && grep -Fq '### 📚 Description' "$local_template"; then
    require_harlan_template=true
  fi
else
  remote_slug="$explicit_repo"
  if [ -z "$remote_slug" ] && [ -n "$repo_root" ]; then
    remote_slug=$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)
  fi
  if printf '%s' "$remote_slug" | grep -Eiq '(github\.com[:/]|^)harlan-zw/'; then
    require_harlan_template=true
  fi
fi

if [ "$require_harlan_template" = true ]; then
  if ! printf '%s\n' "$body_no_fences" | grep -Fq '### ❓ Type of change' \
    || ! printf '%s\n' "$body_no_fences" | grep -Fq '### 📚 Description'; then
    deny 'PR body does not match the repository template (`### ❓ Type of change` and `### 📚 Description`). Re-read the Harlan Agent Kit PR skill (`pr`) and fill the template.'
  fi
fi

exit 0
