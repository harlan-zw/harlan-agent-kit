---
name: tweet
description: 'Find tweet ideas, plan launch posts, and draft or polish tweets with code cards, stat cards, or screenshot wraps. Use for content strategy, what to post, when to post, or an X post.'
argument-hint: '[draft, topic, release notes, screenshot, or ideas]'
license: MIT
---

# Tweet Skill

Find content opportunities, plan launch posts, and draft tweets. Add a visual when it helps the reader.
Keep planning and polishing in this Skill.

## Authority

Drafting does not authorize posting, replying, scheduling, or tagging accounts in a published post.
Show the exact text and wait for publication approval.
Never invent metrics, engagement, personal experience, or product claims.

## Gotchas

- **Character count is tricky** -- URLs always count as 23 chars (t.co wrapping). Emojis count as 2. Newlines count as 1. Don't trust naive `length` checks.
- **Twitter crops images at 16:9 in timeline** -- all templates output 1600x900 for this reason. Non-16:9 images get cropped unpredictably.
- **Don't over-polish** -- tweets that sound too perfect feel like marketing. Preserve the user's natural voice, just fix obvious issues.
- **Thread vs single tweet** -- default to one post. Use a thread when the user requests it or the meaning needs it.
- **Screenshot dependencies** -- `sharp` and `@resvg/resvg-js` need to be installed. If they're not global, install to a temp dir, don't pollute the project.
- **Hot takes can backfire** -- always flag the hot take variation as risky. The user should consciously opt in, not accidentally post something inflammatory.
- **Use a visual when it earns attention** -- suggest one when it helps the reader understand or assess the point.
- Before finalizing, load the installed Brundlefly `im-part-human` Skill. Preserve supplied facts and voice.

## Data Storage

Track tweet history for voice consistency:

```bash
# After finalizing a tweet, log it
echo "$(date -I) | VISUAL_TYPE | FINAL_TWEET_TEXT" >> "${CLAUDE_PLUGIN_DATA}/tweet-history.log"
```

On subsequent runs, read recent history to maintain consistent voice and avoid repeating hooks/angles.

## Input and mode

Predict the reader's attention in the feed before choosing scope and depth.
Lead with the most useful point. Keep secondary changes brief or link to them.
Do not turn every release feature into another post or visual by default.

Select the mode from the user's request:

| Request                                              | Mode      | Next step                                                                                           |
| ---------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| Ideas, content strategy, what to post, or no input   | Discovery | Read [planning](references/planning.md), then offer ranked ideas.                                   |
| A launch, release notes, changelog, or a new project | Launch    | Read [planning](references/planning.md), then offer launch approaches.                              |
| A draft, topic, screenshot, or code snippet          | Draft     | Start Step 1.                                                                                       |
| Posting time or cadence only                         | Planning  | Read [planning](references/planning.md) and [playbook](references/playbook.md). Answer the request. |

An explicit request wins over inferred input type.
If the user asks to polish a release tweet, use Draft mode.
If the user supplies an image without planning context, use Draft mode.

Read both References when the user asks for a content plan.
After a Discovery or Launch choice, continue at Step 1 with the chosen angle.
Keep that angle. Do not repeat research or produce another set of initial approaches.
If the user already selected exact copy, skip Step 2. Generate a visual only when requested or useful.

## Step 1: Analyze Input & Select Visual Strategy

Choose a visual only when requested or when it helps the reader understand or assess the point.
Otherwise select **No visual**. Do not ask for an image merely because the input is text.

| Input type                     | Visual template       | When to use                                             |
| ------------------------------ | --------------------- | ------------------------------------------------------- |
| Screenshot/image path          | `wrap-screenshot.mjs` | User has an existing screenshot to polish               |
| Code snippet or mentions code  | `code-card.mjs`       | Showing a specific API, config, or code example         |
| Release/launch with metrics    | `stat-card.mjs`       | GitHub stars, downloads, benchmarks, version milestones |
| General text, no useful visual | No visual             | The text conveys the point without an image             |

An explicit request for a visual wins. For a useful visual, choose the best fit from the table.
If more than one fits, briefly suggest the best fit and why.

### Theme Selection

If a visual is selected, pick its theme. All templates share 6 color themes:

| Theme      | Vibe                        | Best for                                    |
| ---------- | --------------------------- | ------------------------------------------- |
| `midnight` | Deep blue, electric accents | General dev content, default choice         |
| `ocean`    | Teal/cyan, calm             | Nuxt/Vue ecosystem (matches brand colors)   |
| `sunset`   | Warm orange/purple          | Creative tools, design content              |
| `forest`   | Green, natural              | Performance, sustainability, growth metrics |
| `lavender` | Purple, elegant             | TypeScript, DX tooling                      |
| `ember`    | Red, intense                | Breaking changes, critical fixes, hot takes |

Default to `ocean` for Nuxt ecosystem content, `midnight` for everything else.

### Chrome Selection (wrap-screenshot only)

| Chrome     | Look                                                 | Best for                           |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| `terminal` | macOS terminal with traffic lights + monospace title | CLI tools, terminal output         |
| `browser`  | Browser-style with URL bar                           | Web apps, UI screenshots           |
| `minimal`  | Thin top bar, no buttons                             | Clean look, design screenshots     |
| `none`     | Just the image on background                         | When the content speaks for itself |

## Step 2: Tweet Text Iteration

### Initial Review

Read the draft and identify:

- Character count (280 limit, flag if over)
- Weak opening (first 5 words matter most in timeline)
- Missing context that makes the tweet confusing to outsiders
- Corporate speak ("excited to announce", "thrilled to share")
- Starting with "I" (reframe to lead with value)

### Generate Variations

Default to one polished draft. Offer alternatives when requested or when the user needs to choose an angle.
Keep the set small. These are available approaches, not a required checklist:

1. **Fixed original** -- same voice/intent, fix obvious issues
2. **Value-first** -- reframe around what the reader gets. "Free tool that does X" over "I built X"
3. **Show-don't-tell** -- lead with the visual/demo. "Watch:" or "Before/after:" framing
4. **Provocative** -- stronger opinion or contrarian angle (flag as higher risk)

For each variation show:

- The tweet text
- Character count
- What changed and why
- A visual template and theme only when they help explain this angle; otherwise **No visual**

### Rules for Good Tweets

- No hashtags unless the user explicitly includes them
- No emojis unless the user's draft already uses them
- Match the user's voice
- If referencing code/tech, be specific not vague
- Front-load the hook in the first line

### Iterate

If alternatives are needed, ask which direction they prefer. Keep iterating until they're happy.

## Step 3: Generate Visual

If **No visual** is selected, skip this step and continue to Step 4.
Based on the selected template, create a temporary script in scratchpad.

### 3a. Screenshot Wrapping (`wrap-screenshot.mjs`)

Use the Read tool to view the screenshot first. Then customize:

- `INPUT_PATH` -- the screenshot file path
- `OUTPUT_PATH` -- same directory, append `-twitter` before extension
- `TITLE` -- contextual title based on content:
  - Terminal: `claude — ~/project` or the command shown
  - Browser: URL or page title
  - Generic: filename or brief description
- `THEME` -- selected theme
- `CHROME` -- selected chrome style

### 3b. Code Card (`code-card.mjs`)

Extract the most interesting code snippet (max ~20 lines, the card clips overflow). Customize:

- `CODE` -- the code to display (clean it up: remove irrelevant imports, focus on the "aha" moment)
- `LANGUAGE` -- for the title bar label
- `TITLE` -- optional override (e.g., "nuxt.config.ts" or "Usage")
- `THEME` -- selected theme
- `OUTPUT_PATH` -- descriptive name

Tips for good code cards:

- Show the simplest usage, not the full API
- 5-15 lines is ideal; under 5 feels empty, over 20 gets cramped
- Include a comment that explains what's happening if the code isn't self-evident
- Remove type annotations if they add noise without clarity

### 3c. Stat Card (`stat-card.mjs`)

For milestones, releases with impressive numbers, benchmarks. Customize:

- `HEADLINE` -- project name + version or milestone label
- `SUBHEADLINE` -- one-line description
- `STATS` -- array of `{ label, value }` objects (2-4 stats, 3 is ideal)
- `THEME` -- selected theme
- `OUTPUT_PATH` -- descriptive name

Tips for good stat cards:

- Use verified numbers. Never round up metrics to make them look better.
- Use human-readable units ("45k" not "44,892")
- Lead with the most impressive stat
- Pair with a tweet that gives context the card doesn't

### 3d. Run the Script

```bash
node /path/to/scratchpad/template.mjs
```

Dependencies (`sharp`, `@resvg/resvg-js`) should be available globally or in the project. If not, install to scratchpad:

```bash
cd /path/to/scratchpad && pnpm init && pnpm add sharp @resvg/resvg-js
```

### 3e. Verify Output

Read the output image to verify it looks correct. Show the user the result. If something looks off (text overflow, bad contrast, wrong theme), fix and re-run.

## Step 4: Final Output

Present:

- The final tweet text with character count
- The generated visual, when requested or useful
- Suggested accounts to tag only when they serve the requested post (max 2)
- Suggested posting time (if relevant), using the user's audience and timezone

Log to `${CLAUDE_PLUGIN_DATA}/tweet-history.log`.
Use `none` as `VISUAL_TYPE` when no visual was generated.

Keep the handoff brief. Do not append a routine menu of more variants, themes, or follow-up posts.
