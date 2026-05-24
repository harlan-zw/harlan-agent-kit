#!/bin/bash
source "$(dirname "$0")/check-config.sh" 2>/dev/null
is_hook_disabled "eslint" && exit 0

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# skip non-lintable files
[[ ! "$file_path" =~ \.(js|jsx|ts|tsx|vue|mjs|cjs|md|json|yaml|yml|md)$ ]] && exit 0

# skip node_modules and dist
[[ "$file_path" =~ node_modules|/dist/|\.nuxt ]] && exit 0

# find eslint binary
ESLINT=""
if [ -f "node_modules/.bin/eslint" ]; then
  ESLINT="./node_modules/.bin/eslint"
elif command -v eslint &>/dev/null; then
  ESLINT="eslint"
fi
[ -z "$ESLINT" ] && exit 0

# rules to soften during editing (code may be partial/incomplete)
# unused-imports: don't auto-remove, code may reference them later
# prefer-const: let vars may be reassigned in code not yet written
# vue template rules: template may be structurally incomplete mid-edit
# import/first: misfires on Vue SFCs with two <script> blocks (one for
#   exported types, one for setup) — autofix concatenates them and moves
#   the setup imports above the exports, corrupting the file.
PARTIAL_RULES=(
  'unused-imports/no-unused-imports'
  'unused-imports/no-unused-vars'
  'prefer-const'
  'vue/no-parsing-error'
  'vue/valid-template-root'
  'vue/no-multiple-template-root'
  'vue/comment-directive'
  'import/first'
)

# build --rule flags: off for fix pass, warn for report pass
FIX_FLAGS=()
WARN_FLAGS=()
for rule in "${PARTIAL_RULES[@]}"; do
  FIX_FLAGS+=(--rule "$rule: off")
  WARN_FLAGS+=(--rule "$rule: warn")
done

# run --fix with partial rules disabled
"$ESLINT" "$file_path" --fix "${FIX_FLAGS[@]}" 2>&1 | grep -v "could not find plugin" || true

# then report partial rules as warnings only (no fix)
"$ESLINT" "$file_path" "${WARN_FLAGS[@]}" 2>&1 | grep -v "could not find plugin" || true
