# Pull request artifacts

An artifact earns its place when it answers a question the reviewer must answer to merge, faster than the diff and the description can.
Most pull requests need none.

## Decide

Before you write the description, ask one question: what must the reviewer see that the diff and the description do not show?
Choose the artifact from that answer. Never choose from file types, file counts, or module counts.

| The reviewer must see | Artifact |
| --- | --- |
| A result a person sees: a page, component, layout, style, on-screen copy, or interaction | Screenshots of the changed surface at the head |
| Motion, or a multi-step interaction that stills cannot show | A short screen recording, under 30 seconds |
| Data or control that crosses modules, services, or stores and has no visible result: a contract, a pipeline, a scheduler, a migration sequence | One PR Lens view. Add a data-flow view only for a sequence |
| A performance change | A before and after table of real measurements |
| Changed CLI or terminal output | The real output in a fenced text block |
| A rendered artifact: an email, an OG image, a PDF | A capture of the rendered output |
| Anything else: tests, a refactor, dependencies, configuration, docs, copy outside the UI | Nothing |

- A visible result gets screenshots, never a PR Lens diagram.
- If the change also adds a hidden path, add a diagram only when that path is the risky part of the change.
- Use at most two kinds of artifact in one pull request.
- If you cannot name the reviewer's question, attach nothing.

Examples:

- A picker moves into the sidebar, and a card and its modal now read the selected value. It touches four components, and the reviewer must see the new screen: screenshots only.
- A worker now recovers snapshots after edge timeouts. Nothing on screen changes, and the retry crosses the queue, the worker, and the store: one PR Lens view, or nothing.

## Screenshots

- Capture the real app at the pull request head. Seed data, fixtures, or a dev mock are fine; say so in the alt text. Never attach a mockup.
- Capture the changed region. Show the whole page only when the layout is the change.
- Capture at 1440 px. Add 390 px when the change affects layout or a phone flow.
- Add a before image only when the change fixes or replaces an existing view. Capture the same region at the same width.
- For a flow, capture each step that changed, in order, up to four images.
- Write alt text that says what the image shows in one sentence.
- Look at every image at full size before you attach it:
  - Check for clipping, overlap, overflow, and wrong states. A visible defect is task scope: fix it, then capture again.
  - Check for private data, such as real email addresses, client names, tokens, or account details. Use seed data, or crop it out.

## When a capture is not possible

If the app cannot run at the head in the state the change needs, for example behind a sign-in or a third-party callback, say so in one line in the description and attach nothing.
Never replace a missing screenshot with a diagram or a mockup.

## Placement

- Artifacts that show the result go in the description, after the why and before the AI disclosure. Never in a trailing comment.
- Evidence that proves a check, such as a fix verified at 320 px, follows the verification comment rule in [media](media.md).
- Attach local files with `--attach PATH` on `gh pr create` or `gh pr edit`. GitHub CLI rewrites a matching Markdown path to the uploaded asset, so match each Markdown path to its `--attach` path exactly.
- After a push that changes the visible result, replace the image. Remove an artifact that no longer matches the head.

## Capture

Start the app with the project's run Skill or dev server from the task worktree. Drive it with a task-named headless browser:

```bash
dev-browser --browser TASK --headless --timeout 120 <<'EOF'
const page = await browser.getPage('capture')
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto('http://127.0.0.1:PORT/ROUTE', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
console.log(await saveScreenshot(await page.screenshot(), 'ROUTE-1440.png'))
await browser.closePage('capture')
EOF
```

`saveScreenshot` writes to `~/.dev-browser/tmp/` and prints the path. Keep images outside the worktree, in that folder or the session scratchpad, and attach them from there. Never commit an image.
