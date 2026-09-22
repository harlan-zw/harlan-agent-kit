#!/usr/bin/env bash
# Reports the project state the skill branches on.
# Probe order matters: a non-Nuxt project stops the skill, so nothing else is read.

if [ ! -f nuxt.config.ts ]; then
  echo "IS_NUXT=false"
  exit 0
fi
echo "IS_NUXT=true"

CONFIG=""
[ -f app.config.ts ] && CONFIG="app.config.ts"
[ -f app/app.config.ts ] && CONFIG="app/app.config.ts"

NEUTRAL="NO_NEUTRAL"
if [ -n "$CONFIG" ] && grep -q "colors:" "$CONFIG" 2>/dev/null; then
  echo "HAS_COLORS=true"
  FOUND=$(grep -E "neutral:" "$CONFIG" 2>/dev/null | head -1 | sed "s/.*neutral:[[:space:]]*['\"]//" | sed "s/['\"].*//")
  [ -n "$FOUND" ] && NEUTRAL="$FOUND"
else
  echo "HAS_COLORS=false"
fi

HAS_THEME=false
for f in app/assets/css/main.css app/css/main.css app/css/global.css app/assets/css/global.css; do
  if [ -f "$f" ] && grep -q "@theme" "$f" 2>/dev/null; then HAS_THEME=true; break; fi
done
echo "HAS_THEME=$HAS_THEME"

[ -f DESIGN.md ] && echo "HAS_GUIDELINES=true" || echo "HAS_GUIDELINES=false"

JOBS=$(ls -t .claude/context/jobs/ 2>/dev/null | head -10)
[ -n "$JOBS" ] && echo "$JOBS" || echo "NO_JOBS"

JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1)
if [ -n "$JOB" ]; then
  DIR=".claude/context/jobs/$JOB"
  echo "LATEST_JOB=$JOB"

  if [ -f "$DIR/build-handoff.json" ]; then
    echo "PRIOR_BUILD=true"
    jq -r '"PRIOR_BUILD_DATE=" + (.created // "unknown")' "$DIR/build-handoff.json" 2>/dev/null
  else
    echo "PRIOR_BUILD=false"
  fi

  if [ -f "$DIR/review-report.md" ]; then
    echo "PRIOR_REVIEW=true"
    grep -m1 "^verdict:" "$DIR/review-report.md" 2>/dev/null
  else
    echo "PRIOR_REVIEW=false"
  fi

  if [ -f "$DIR/build-progress.md" ]; then
    printf "PAGES_BUILT="
    grep -c "^## " "$DIR/build-progress.md" 2>/dev/null
  else
    echo "PAGES_BUILT=0"
  fi
else
  echo "PRIOR_BUILD=false"
  echo "PRIOR_REVIEW=false"
  echo "PAGES_BUILT=0"
fi

command -v dev-browser >/dev/null 2>&1 && echo "DEV_BROWSER=true" || echo "DEV_BROWSER=false"

PAGES=$(find app/pages -name "*.vue" 2>/dev/null | head -10)
[ -n "$PAGES" ] && echo "$PAGES" || echo "NO_PAGES"

THEMES=$(ls "${CLAUDE_SKILL_DIR}/references/themes/" 2>/dev/null | sed "s/.md$//")
[ -n "$THEMES" ] && echo "$THEMES" || echo "NO_THEMES"

echo "$NEUTRAL"
