# Pull request media

A visible change earns media in the same comment. GitHub CLI 2.99.0 or later uploads it to the pull request:

```bash
HARLAN_AGENT_PR_SKILL=1 gh pr comment NUMBER \
  --body "Checked the visible change in the running app." \
  --attach './.playwright/after.png#The updated page'
```

Use `--attach` for images and videos. Repeat the flag for up to 50 files. GitHub hosts the files with the pull request. Never upload pull request media to another service.

Match each Markdown image path exactly to its attachment path, including relative versus absolute spelling.
After posting, read the published body and check that every image uses its uploaded GitHub URL.
If uploads succeeded but local links remain, repair the same body using those returned URLs. Do not upload duplicates.

Visually inspect every screenshot before attaching it. Check the full-resolution image and the intended display size.

Look for clipping, overlap, overflow, alignment, contrast, missing content, and broken responsive layouts. Treat every visible defect as task scope.

If inspection finds a defect, do not upload that screenshot. Repair the UI in the task worktree. Run Step 4 and a focused browser check.

Commit and push the repair without amending. Recapture the same view and inspect it again. Repeat until the attached result is clean.

Keep a labelled `Before` image only when it explains the repaired defect. Its matching `After` image must show the same area.

Take the picture before you need it. [nuxt-frontend-review](../../nuxt-frontend-review/SKILL.md) already captures the running page. Two images beat one, labelled `Before` and `After`:

```bash
HARLAN_AGENT_PR_SKILL=1 gh pr comment NUMBER \
  --body "$(cat <<'EOF'
| Before | After |
| --- | --- |
| ![Before](./.playwright/before.png) | ![After](./.playwright/after.png) |
EOF
)" \
  --attach ./.playwright/before.png \
  --attach ./.playwright/after.png
```

GitHub CLI replaces each local Markdown path with its uploaded URL. If every upload fails, it posts no comment. If a later upload fails, it posts the successful files and exits with an error. Check the printed comment URL before retrying.

Only attach media for a visible change: a page, a component, a CLI frame, or a rendered email. Never attach a screenshot of passing tests or a green terminal.

