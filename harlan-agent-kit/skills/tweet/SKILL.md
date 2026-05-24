---
name: tweet
description: Draft, iterate, and polish tweets with visuals. Use when user says "tweet this", "draft a tweet", "post about this", "share on twitter", "write a tweet", or provides text to tweet. Generates code cards, stat cards, and screenshot wraps.
user_invocable: true
---

# Tweet Skill

Help the user draft, refine, and finalize tweets with compelling visuals. Automatically selects the right visual format based on content.

## Gotchas

- **Character count is tricky** -- URLs always count as 23 chars (t.co wrapping). Emojis count as 2. Newlines count as 1. Don't trust naive `length` checks.
- **Twitter crops images at 16:9 in timeline** -- all templates output 1600x900 for this reason. Non-16:9 images get cropped unpredictably.
- **Don't over-polish** -- tweets that sound too perfect feel like marketing. Preserve the user's natural voice, just fix obvious issues.
- **Thread vs single tweet** -- if the user hasn't asked for a thread, don't suggest one. Single tweets perform better unless there's genuinely too much for 280 chars.
- **Screenshot dependencies** -- `sharp` and `@resvg/resvg-js` need to be installed. If they're not global, install to a temp dir, don't pollute the project.
- **Hot takes can backfire** -- always flag the hot take variation as risky. The user should consciously opt in, not accidentally post something inflammatory.
- **Always suggest a visual** -- text-only dev tweets get buried by the algorithm. Every finalized tweet should have a visual recommendation, even if the user didn't ask for one.

## Data Storage

Track tweet history for voice consistency:

```bash
# After finalizing a tweet, log it
echo "$(date -I) | VISUAL_TYPE | FINAL_TWEET_TEXT" >> "${CLAUDE_PLUGIN_DATA}/tweet-history.log"
```

On subsequent runs, read recent history to maintain consistent voice and avoid repeating hooks/angles.

## Input

`$ARGUMENTS` may contain:
- Raw tweet text to refine
- A file path to a screenshot to wrap
- A code snippet to visualize
- Release notes or changelog to turn into a launch tweet
- Nothing (interactive mode)

## Step 1: Analyze Input & Select Visual Strategy

Determine what the user provided and select the appropriate visual:

| Input type | Visual template | When to use |
|-----------|----------------|-------------|
| Screenshot/image path | `wrap-screenshot.mjs` | User has an existing screenshot to polish |
| Code snippet or mentions code | `code-card.mjs` | Showing a specific API, config, or code example |
| Release/launch with metrics | `stat-card.mjs` | GitHub stars, downloads, benchmarks, version milestones |
| General text, no obvious visual | Suggest one | Ask: "What's the most visual part of this?" |

If the input clearly maps to one visual, proceed directly. If multiple Must work, briefly suggest the best fit and why.

### Theme Selection

All templates share 6 color themes. Pick based on context:

| Theme | Vibe | Best for |
|-------|------|----------|
| `midnight` | Deep blue, electric accents | General dev content, default choice |
| `ocean` | Teal/cyan, calm | Nuxt/Vue ecosystem (matches brand colors) |
| `sunset` | Warm orange/purple | Creative tools, design content |
| `forest` | Green, natural | Performance, sustainability, growth metrics |
| `lavender` | Purple, elegant | TypeScript, DX tooling |
| `ember` | Red, intense | Breaking changes, critical fixes, hot takes |

Default to `ocean` for Nuxt ecosystem content, `midnight` for everything else.

### Chrome Selection (wrap-screenshot only)

| Chrome | Look | Best for |
|--------|------|----------|
| `terminal` | macOS terminal with traffic lights + monospace title | CLI tools, terminal output |
| `browser` | Browser-style with URL bar | Web apps, UI screenshots |
| `minimal` | Thin top bar, no buttons | Clean look, design screenshots |
| `none` | Just the image on background | When the content speaks for itself |

## Step 2: Tweet Text Iteration

### Initial Review

Read the draft and identify:
- Character count (280 limit, flag if over)
- Weak opening (first 5 words matter most in timeline)
- Missing context that makes the tweet confusing to outsiders
- Corporate speak ("excited to announce", "thrilled to share")
- Starting with "I" (reframe to lead with value)

### Generate Variations

Produce **3 variations** plus the fixed original:

1. **Fixed original** -- same voice/intent, fix obvious issues
2. **Value-first** -- reframe around what the reader gets. "Free tool that does X" over "I built X"
3. **Show-don't-tell** -- lead with the visual/demo. "Watch:" or "Before/after:" framing
4. **Provocative** -- stronger opinion or contrarian angle (flag as higher risk)

For each variation show:
- The tweet text
- Character count
- What changed and why
- Which visual template + theme pairs best with this angle

### Rules for Good Tweets

- No hashtags unless the user explicitly includes them
- No emojis unless the user's draft already uses them
- Don't start with "I"
- Avoid corporate/marketing speak
- Match the user's voice
- If referencing code/tech, be specific not vague
- Thread-style (1/n) only if user asks for it
- Front-load the hook in the first line

### Iterate

After showing variations, ask which direction they prefer or if they want to mix elements. Keep iterating until they're happy.

## Step 3: Generate Visual

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
- Round numbers up ("1,200+" not "1,187")
- Use human-readable units ("45k" not "44,892")
- Lead with the most impressive stat
- Pair with a tweet that gives context the card doesn't

### 3d. Run the Script

```bash
node /path/to/scratchpad/template.mjs
```

Dependencies (`sharp`, `@resvg/resvg-js`) should be available globally or in the project. If not, install to scratchpad:

```bash
cd /path/to/scratchpad && npm init -y && npm install sharp @resvg/resvg-js
```

### 3e. Verify Output

Read the output image to verify it looks correct. Show the user the result. If something looks off (text overflow, bad contrast, wrong theme), fix and re-run.

## Step 4: Final Output

Present:
- The final tweet text with character count
- The generated visual (show the image)
- Suggested accounts to tag (max 2, relevant to content)
- Suggested posting time (if relevant)

Log to `${CLAUDE_PLUGIN_DATA}/tweet-history.log`.

Offer to:
- Make further adjustments to text or visual
- Generate an alternative visual style
- Try a different theme
- Create a follow-up tweet for the next day
