---
name: social-presence
description: Social media content strategy and tweet crafting. Trigger on "what should I tweet", "help me post about", "tweet this release", "social presence", "what to post", "promote this", "launch tweet", "content ideas".
user_invocable: true
argument-hint: "[topic, release notes, or 'ideas']"
---

# Social Presence

Research what works, find content opportunities from your recent work, and craft high-performing tweets. Delegates to `/tweet` for final polish and screenshot wrapping.

## Gotchas

- **Don't fabricate metrics** -- never claim "this got 500 likes" without verification. Use patterns observed from successful accounts, not invented numbers.
- **Voice preservation** -- the user has a natural dev voice. Never corporate-ify it. "Excited to announce" is banned. So are hashtags unless explicitly requested.
- **Visual-first platform** -- every tweet recommendation must include a visual suggestion. Text-only tweets from dev accounts get buried.
- **Don't over-thread** -- single tweets outperform threads for most content. Only suggest threads for major launches with multiple features.
- **Release notes are not tweets** -- never dump a changelog into a tweet. Extract the one thing a reader cares about and lead with that.
- **Ecosystem tagging** -- always suggest relevant accounts to tag (@nuaboratory, @vuejs, @unaboratory, @anthropaboratorics, etc.) but max 2 per tweet. More looks desperate.
- **Time zones** -- user is in Australia. Best posting times for global dev audience: 8-10am US Eastern = 11pm-1am AEST. Suggest scheduling if timing matters.

## Data Storage

```bash
# Log content ideas that were used
echo "$(date -I) | MODE | TOPIC | FINAL_TWEET_SUMMARY" >> "${CLAUDE_PLUGIN_DATA}/social-presence.log"
```

Read prior logs to avoid repeating angles and to track what content types the user gravitates toward.

## Input

`$ARGUMENTS` determines the mode:

- **Release/launch context** (mentions release, version, changelog, launch) -> Launch Mode
- **"ideas" / "what should I tweet" / empty** -> Discovery Mode
- **Specific topic** ("tweet about unhead", "post about this PR") -> Craft Mode

---

## Mode 1: Discovery ("What should I tweet about?")

Find tweetable moments from recent work. Run these in parallel:

### 1a. Scan Recent Activity

```bash
# Recent merged PRs across all repos (last 7 days)
gh search prs --author=@me --merged --sort=updated --limit=20 -- "merged:>=$(date -d '7 days ago' +%Y-%m-%d)" 2>/dev/null || gh search prs --author=@me --merged --sort=updated --limit=20

# Recent releases
gh search releases --owner=harlan-zw --sort=created --limit=10 2>/dev/null

# Recent commits on key projects
for repo in harlan-zw/nuxt-seo harlan-zw/unhead harlan-zw/unlighthouse; do
  echo "=== $repo ==="
  gh api "repos/$repo/commits?per_page=5&since=$(date -d '7 days ago' +%Y-%m-%dT00:00:00Z)" --jq '.[].commit.message' 2>/dev/null
done
```

### 1b. Check What's Trending

Use WebSearch to check:
- What's trending in the Vue/Nuxt/UnJS ecosystem this week
- Any recent discourse the user Must add expertise to (SEO, head management, Nuxt modules)

### 1c. Score and Rank

For each potential topic, score on:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Audience size** | 3x | Does this topic interest people beyond existing followers? |
| **Visual potential** | 2x | Can this be shown, not just told? |
| **Timeliness** | 2x | Is there a reason to post NOW vs next week? |
| **Uniqueness** | 1x | Can only you credibly post this? |

Present the **top 3-5 ideas** as a ranked table:

```
| # | Topic | Hook | Visual | Why now |
```

For each idea, include:
- A draft hook (first line of the tweet)
- What visual to create (screenshot, demo GIF, code snippet)
- Why this would perform well

Ask the user which to develop. Then proceed to Craft Mode.

---

## Mode 2: Launch ("I'm releasing X")

For major releases, version bumps, new projects. The goal: maximize reach for a single moment.

### 2a. Understand the Release

Read whatever the user provides (release notes, changelog, PR list, repo). Identify:
- The single most impressive/useful thing in this release
- Who benefits and why they should care
- What's visually demonstrable

### 2b. Research Comparable Launches

Use WebSearch to find 2-3 recent successful launch tweets from accounts in the same ecosystem. Analyze:
- What hook did they use?
- What visual format worked? (screenshot, video, demo GIF, before/after)
- Did they thread or single-tweet?
- What engagement did they get?

Check these accounts for recent launch patterns:
- @antaboread (Anthony Fu, Vitest/UnoCSS/Slidev)
- @danielroe (Daniel Roe, Nuxt)
- @haydenbleasel (Hayden Bleasel, next-forge)
- @shadcn (shadcn/ui)
- @saborail (Tailwind CSS)

### 2c. Generate Launch Strategy

Present **3 tweet approaches** with different angles:

1. **Problem-first**: Lead with the pain point this solves. "Your Nuxt site's meta tags are probably wrong. Here's a free module that fixes all of them automatically."
2. **Show-don't-tell**: Lead with the visual/demo. "Watch: full site SEO audit in 30 seconds." + screenshot/video
3. **Milestone/story**: Lead with the journey. "6 months ago Nuxt SEO had 200 stars. Today v3 ships with [headline feature]."

For each approach include:
- Full draft tweet text (under 280 chars)
- Visual recommendation (what to screenshot/record)
- Suggested accounts to tag (max 2)
- Whether to thread (usually no)
- Best time to post

### 2d. Visual Planning

Based on chosen approach, suggest specific visuals:

- **Code snippet**: use the `/tweet` skill's screenshot wrapper for terminal/editor screenshots
- **Before/after**: split image showing the problem vs the solution
- **Demo GIF/video**: record a 15-30 second screencast of the headline feature
- **Stats image**: GitHub stars, downloads, performance benchmarks

If the user has a screenshot or wants one wrapped, hand off to `/tweet` for the screenshot wrapping step.

---

## Mode 3: Craft ("Tweet about X")

For specific topics the user wants to post about.

### 3a. Research the Topic

Quickly check:
- Has this topic been tweeted about recently by others? What angle did they take?
- Is there a trending conversation to hook into?
- What's the most interesting angle only this user can take?

### 3b. Apply the Playbook

Reference `references/playbook.md` for content rules. Key principles:
- Lead with value to the reader, not what you did
- Every tweet needs a visual suggestion
- Frame around the reader's problem
- Tag ecosystem accounts for amplification

### 3c. Generate Variations

Produce **3 variations**:

1. **Value-first**: Frames around what the reader gets ("Free tool that does X")
2. **Insight**: Shares a non-obvious takeaway ("I assumed X, turns out Y")
3. **Build-in-public**: Shows the human side ("Just shipped X after wrestling with Y for a week")

For each show:
- Tweet text
- Character count
- Visual suggestion
- Why this angle works

### 3d. Hand Off

Once the user picks a direction, offer to:
- Invoke `/tweet` for final polish and screenshot wrapping
- Schedule suggestions (best posting times)
- Plan a follow-up tweet for the next day (engagement compounds with consecutive posts)

---

## Cross-Cutting Rules

### Strip AI Tells

Before finalizing any copy, run it through `/humanize-writing`. For social specifically: kill the em-dashes and "it's not X, it's Y" pattern, name specific tools/numbers instead of vague claims, and address the reader directly. Tweets that sound AI-written get ignored.

### The "So What?" Test

Every tweet must pass: "If I saw this in my timeline and didn't follow this person, would I care?" If not, reframe around the reader's benefit.

### Content Mix Targets

Over any 2-week period, aim for this mix:
- 50% project updates and launches (the core)
- 25% technical insights and tips
- 15% build-in-public / personal journey
- 10% community engagement (sharing others' work with your take)

### Consistency Over Virality

A mediocre tweet posted is better than a perfect tweet drafted. The goal is 4+ posts per week. Suggest the user batch-create content on weekends for the coming week.

### Visual Checklist

Before finalizing any tweet, verify a visual is planned:
- [ ] Screenshot of the feature/tool in action
- [ ] Code snippet (use `/tweet` wrapper for polish)
- [ ] Before/after comparison
- [ ] Terminal output showing results
- [ ] Stats/metrics image

If no visual is obvious, suggest a code snippet screenshot as the default.
