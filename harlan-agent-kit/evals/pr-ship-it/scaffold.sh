#!/usr/bin/env bash
set -e
mkdir -p hooks
printf '#!/usr/bin/env bash\necho "Nuxt App: $(basename "$PWD")"\n' > hooks/session-start.sh
chmod +x hooks/session-start.sh
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
git add -A
git commit -qm "chore: add the session start hook"
printf '#!/usr/bin/env bash\necho "Nuxt App: $(basename "$PWD")"\necho "Branch: $(git branch --show-current)"\n' > hooks/session-start.sh
