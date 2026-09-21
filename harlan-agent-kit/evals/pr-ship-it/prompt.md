---
max_turns: 25
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
---

Set up a scratch repo first, exactly this, then stop and read the rest:

```bash
mkdir -p ~/work/hooks && cd ~/work
printf '#!/usr/bin/env bash\necho "Nuxt App: $(basename "$PWD")"\n' > hooks/session-start.sh
git init -q -b main && git add -A && git commit -qm "chore: add the session start hook"
printf '#!/usr/bin/env bash\necho "Nuxt App: $(basename "$PWD")"\necho "Branch: $(git branch --show-current)"\n' > hooks/session-start.sh
```

That repo now has one uncommitted change: `hooks/session-start.sh` prints the
branch name under the repo name. It has no `origin` remote.

Ship that change. When you reach the push, stop and tell me the exact command
and the pull request title you would use.
