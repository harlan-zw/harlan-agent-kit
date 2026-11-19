# Pull request media

Apply the [verification comment rule](../SKILL.md#verification-comments) before sharing media.
Capture the actual changed surface at the pull request head. Keep mockups and captures of routine checks in the session.
Attach a real capture only when it gives a reviewer a concrete reason to change the merge decision.
Use the self-identified Agent comment.

GitHub CLI 2.99.0 or later uploads it to the pull request:

```bash
HARLAN_AGENT_PR_SKILL=1 gh pr comment NUMBER \
  --body "🤖 Harlan Agent Kit captured the running app. The account selector stays visible at 320px." \
  --attach './.playwright/after.png#The account selector at 320px'
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

[nuxt-frontend-review](../../nuxt-frontend-review/SKILL.md) already captures the running page.
If reviewers need both views to make the merge decision, label them `Before` and `After`:

```bash
HARLAN_AGENT_PR_SKILL=1 gh pr comment NUMBER \
  --body "$(cat <<'EOF'
🤖 Harlan Agent Kit captured the running app at 320px to verify the account selector stays visible.

| Before | After |
| --- | --- |
| ![Before](./.playwright/before.png) | ![After](./.playwright/after.png) |
EOF
)" \
  --attach ./.playwright/before.png \
  --attach ./.playwright/after.png
```

GitHub CLI replaces each local Markdown path with its uploaded URL. If every upload fails, it posts no comment. If a later upload fails, it posts the successful files and exits with an error. Check the printed comment URL before retrying.

Attach media that shows a changed surface, such as a page, component, CLI frame, or rendered email.

