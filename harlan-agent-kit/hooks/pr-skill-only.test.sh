#!/usr/bin/env bash
# Verifies pull request descriptions can change only through the PR skill.
set -uo pipefail

# Hook decisions append to the hit log. Keep test runs out of the real one.
export XDG_STATE_HOME="$(mktemp -d)"
trap 'rm -rf "$XDG_STATE_HOME"' EXIT

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-skill-only.sh"
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$XDG_STATE_HOME" "$work"' EXIT

DISCLOSURE='> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'

valid_body() {
  printf '### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nFixes the issue.\n\n%s\n' "$DISCLOSURE"
}

decision() {
  local cmd="$1" cwd="${2:-$work}" out
  out="$(jq -nc --arg command "$cmd" --arg cwd "$cwd" '{cwd:$cwd,tool_input:{command:$command}}' | bash "$hook")"
  [ -n "$out" ] || { echo allow; return; }
  printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision'
}

block_reason() {
  local cmd="$1" cwd="${2:-$work}"
  jq -nc --arg command "$cmd" --arg cwd "$cwd" '{cwd:$cwd,tool_input:{command:$command}}' \
    | bash "$hook" \
    | jq -r '.hookSpecificOutput.permissionDecisionReason // empty'
}

expect() {
  local want="$1" command="$2" cwd="${3:-$work}" got
  got="$(decision "$command" "$cwd")"
  if [ "$got" != "$want" ]; then
    printf 'FAIL  expected %s, got %s for: %s\n' "$want" "$got" "$command"
    fail=1
  fi
}

valid_file="$work/valid-named-pr.md"
valid_body > "$valid_file"

quoted_dir="$work/nested dir name"
mkdir -p "$quoted_dir"
valid_body > "$quoted_dir/named-body.md"

bad_no_disclosure="$work/no-disclosure.md"
printf '### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nFixes the issue.\n\n*Drafted with Antigravity AI assistance.*\n' > "$bad_no_disclosure"

bad_verification="$work/with-verification.md"
printf '### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nFixes the issue.\n\n## Verification\n\n- tests passed\n\n%s\n' "$DISCLOSURE" > "$bad_verification"

expect deny 'gh pr create --title "fix: example" --body "wrong"'
expect deny 'cd /repo && gh pr create --fill'
expect deny 'gh pr edit 42 --body "wrong"'
expect deny 'gh pr edit 42 --body-file /tmp/pr.md'
expect deny 'gh pr edit 42 -F /tmp/pr.md'
expect deny "$(printf 'gh pr edit 42 \\\n--body-file /tmp/pr.md')"
expect deny "$(printf 'cd /repo \\\n&& gh pr edit 42 --body-file /tmp/pr.md')"
expect allow "$(printf 'HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 \\\n--body-file %s' "$valid_file")"
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 -F $valid_file"

expect deny "$(printf 'cat > /tmp/pr.md <<EOF \\\nignored\nEOF\ngh pr create --title t --body-file /tmp/pr.md')"
expect deny "$(printf 'echo "see cat <<EOF notes"\ngh pr create --fill')"
expect allow 'echo "see cat <<EOF notes"'
expect deny 'FOO=1 gh pr create --fill'
expect deny '`gh pr create --fill`'

expected_reason='Use the Harlan Agent Kit PR skill: `harlan-agent-kit:pr`. Claude Code invokes it as `/harlan-agent-kit:pr`. Codex invokes it as `$harlan-agent-kit:pr`. Antigravity loads the `pr` skill. It loads the repository template and required disclosure.'
actual_reason="$(block_reason 'gh pr create --fill')"
if [ "$actual_reason" != "$expected_reason" ]; then
  printf 'FAIL  unexpected block reason: %s\n' "$actual_reason"
  fail=1
fi

expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: example\" --body \"$(valid_body)\""
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 --body \"$(valid_body)\""
# Inline env assignments (such as HARLAN_AGENT_GITHUB_PRIVATE on private repos) may appear beside HARLAN_AGENT_PR_SKILL=1.
expect allow "HARLAN_AGENT_GITHUB_PRIVATE=owner/repo HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: example\" --body \"$(valid_body)\""
expect allow "HARLAN_AGENT_PR_SKILL=1 HARLAN_AGENT_GITHUB_PRIVATE=owner/repo gh pr create --title \"fix: example\" --body \"$(valid_body)\""
expect allow "HARLAN_AGENT_GITHUB_PRIVATE=owner/repo HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 --body \"$(valid_body)\""
expect allow "HARLAN_AGENT_PR_SKILL=1 HARLAN_AGENT_GITHUB_PRIVATE=owner/repo gh pr edit 42 --body \"$(valid_body)\""
expect deny "HARLAN_AGENT_PR_SKILL=1 HARLAN_AGENT_GITHUB_PRIVATE=owner/repo gh pr create --fill"
expect deny "HARLAN_AGENT_PR_SKILL=0 HARLAN_AGENT_GITHUB_PRIVATE=owner/repo gh pr create --title \"fix: example\" --body \"$(valid_body)\""
expect deny "HARLAN_AGENT_PR_SKILL=1 HARLAN_AGENT_PR_SKILL=0 gh pr create --title \"fix: example\" --body \"$(valid_body)\""
expect deny "$(printf 'cd /repo\ngh pr create --fill')"
expect deny "$(printf 'cat > /tmp/pr.md <<EOF\nbody\nEOF\ngh pr create --body-file /tmp/pr.md')"
expect deny "$(printf 'cd /repo\ngh pr edit 42 --body-file /tmp/pr.md')"
expect allow "$(printf 'cd %s\nHARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: example" --body-file valid-named-pr.md' "$work")"
expect allow "$(printf 'cd "%s" && HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: example" --body-file named-body.md' "$quoted_dir")"
expect allow "$(printf 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: example" --body "$(cat %s)"' "$valid_file")"
expect allow 'gh pr edit 42 --add-label ready'
expect allow 'HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 --add-label harlan-agent-review'
expect allow 'gh pr view 42 --json body'
expect allow 'echo gh pr create'

# A quoted heredoc marker opens no body, so the next line is still a call.
expect deny "$(printf 'echo \"<<EOF\"\ngh pr create --fill')"
# An escaped quote is a literal, so it must not open a quoted span.
expect deny "$(printf 'echo hi\\\"\ngh pr create --fill')"
# A continuation line after a heredoc opener is command text, not body.
expect deny "$(printf 'cat <<EOF \\\n&& gh pr create --fill\nbody\nEOF')"
# A call split across a continuation is still one call.
expect deny "$(printf 'gh \\\npr create --fill')"
# A heredoc body that names the call is still prose.
expect allow "$(printf 'cat > /tmp/pr.md <<EOF\ngh pr create --fill\nEOF')"

# Body validation even when HARLAN_AGENT_PR_SKILL=1 is set.
expect deny 'HARLAN_AGENT_PR_SKILL=1 gh pr create --fill'
expect deny 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "feat: missing body"'
expect deny 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: example" --body "right"'
expect deny 'HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 --body "right"'
expect deny "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: example\" --body-file $bad_no_disclosure"
expect deny "HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 -F $bad_no_disclosure"
expect deny "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: example\" --body-file $bad_verification"

# Exact replay of a drifted PR body (PR #323 shape).
expect deny "$(cat <<'CMD'
cd /tmp && PR_URL=$(HARLAN_AGENT_PR_SKILL=1 gh pr create --title "feat(analysis): add fuzzy folding" --body "$(cat <<'EOF'
## Why

Reason here.

## Summary

- Change here.

## Verification

- `pnpm test`: passed

---
*Drafted with Antigravity AI assistance.*
EOF
)")
CMD
)"

# Forbidden verification/testing/QA headings even with exact disclosure.
for heading in '## Verification' '### Verification' '## Test Plan' '### test plan' '## Testing' '## QA'; do
  expect deny "$(printf 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body "$(cat <<'\''EOF'\''\n### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nFixes x.\n\n%s\n\n- ran tests\n\n%s\nEOF\n)"' "$heading" "$DISCLOSURE")"
done

# A fenced code block quoting a forbidden heading is an example, not a section.
expect allow "$(printf 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body "$(cat <<'\''EOF'\''\n### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nBlocks headings like:\n\n```markdown\n## Verification\n```\n\n%s\nEOF\n)"' "$DISCLOSURE")"

# File created via heredoc in the same command, and stdin via --body-file -.
expect allow "$(printf 'cat > %s/new-pr.md <<'\''EOF'\''\n%s\nEOF\nHARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body-file %s/new-pr.md' "$work" "$(valid_body)" "$work")"
expect deny "$(printf 'cat > %s/bad-new.md <<'\''EOF'\''\n## Why\n\nNo disclosure.\nEOF\nHARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body-file %s/bad-new.md' "$work" "$work")"
expect allow "$(printf 'cat <<'\''EOF'\'' | HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body-file -\n%s\nEOF' "$(valid_body)")"

# Template enforcement in harlan-zw repositories (inherited org template).
harlan_repo="$work/harlan-repo"
git init -q "$harlan_repo"
git -C "$harlan_repo" remote add origin https://github.com/harlan-zw/gscdump.git
summary_with_disclosure="$(printf '## Summary\n\nSomething.\n\n%s\n' "$DISCLOSURE")"
expect deny "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$summary_with_disclosure\"" "$harlan_repo"
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$(valid_body)\"" "$harlan_repo"
expect deny "cd $harlan_repo && HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$summary_with_disclosure\"" "$work"

# Custom local template overrides the org template headings.
custom_repo="$work/custom-repo"
git init -q "$custom_repo"
git -C "$custom_repo" remote add origin https://github.com/harlan-zw/custom.git
mkdir -p "$custom_repo/.github"
printf '## Summary\n\nDescribe the change.\n' > "$custom_repo/.github/PULL_REQUEST_TEMPLATE.md"
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$summary_with_disclosure\"" "$custom_repo"

# External repo without harlan-zw template allows custom headings when disclosure is present.
ext_repo="$work/ext-repo"
git init -q "$ext_repo"
git -C "$ext_repo" remote add origin https://github.com/other/repo.git
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$summary_with_disclosure\"" "$ext_repo"

# External repo with a local template matching harlan-zw headings enforces them.
ext_templated="$work/ext-templated"
git init -q "$ext_templated"
git -C "$ext_templated" remote add origin https://github.com/nuxt/example.git
mkdir -p "$ext_templated/.github"
printf '### ❓ Type of change\n\n### 📚 Description\n' > "$ext_templated/.github/pull_request_template.md"
expect deny "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$summary_with_disclosure\"" "$ext_templated"
expect allow "HARLAN_AGENT_PR_SKILL=1 gh pr create --title \"fix: x\" --body \"$(valid_body)\"" "$ext_templated"

[ "$fail" -eq 0 ] && echo 'pr-skill-only hook tests passed'
exit "$fail"
