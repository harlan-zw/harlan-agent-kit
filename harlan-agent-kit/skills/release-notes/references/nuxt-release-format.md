# Nuxt Release Note Format Reference

This is the exact structure Nuxt uses for minor/major releases (e.g., v3.16.0, v3.15.0).

## Structure

```markdown
# vX.Y.Z

## 👀 Highlights

Brief 1-2 sentence intro setting the tone for the release.

### ⚡️ Feature Name
Narrative explanation of the feature: what problem it solves, how it works, what it enables for users. Keep it 2-4 sentences.

```ts
// Minimal code example showing the new API
const example = useNewFeature()
```

### 🚀 Another Feature
Same narrative pattern. Each highlight gets its own H3 with a relevant emoji.

> [!TIP]
> Optional callout boxes for important notes, tips, or warnings.

## ⚠️ Breaking Changes

Only present if there are breaking changes. Each breaking change gets:

### Changed: `oldApi` → `newApi`
Explanation of what changed and why. Include before/after:

**Before:**
```ts
oldWay()
```

**After:**
```ts
newWay()
```

## ✅ Upgrading

Run the following command to upgrade:

```bash
npx nuxi upgrade
```

Or update manually:
```bash
pnpm add -D nuxt@latest
```

## 👉 Changelog

> [Compare changes](https://github.com/OWNER/REPO/compare/vPREV...vCURR)

### 🚀 Enhancements
- Description of enhancement ([#123](https://github.com/OWNER/REPO/pull/123))
- Another enhancement ([#124](https://github.com/OWNER/REPO/pull/124))

### 🔥 Performance
- Performance improvement ([#125](https://github.com/OWNER/REPO/pull/125))

### 🩹 Fixes
- Bug fix description ([#126](https://github.com/OWNER/REPO/pull/126))

### 💅 Refactors
- Refactor description ([#127](https://github.com/OWNER/REPO/pull/127))

### 📖 Documentation
- Docs update ([#128](https://github.com/OWNER/REPO/pull/128))

### 📦 Build
- Build change (COMMIT_HASH)

### 🏡 Chore
- Chore description ([#129](https://github.com/OWNER/REPO/pull/129))

### ✅ Tests
- Test addition ([#130](https://github.com/OWNER/REPO/pull/130))

### ❤️ Contributors
- @username1
- @username2
```

## Category Emoji Reference

| Emoji | Category | Conventional Commit |
|-------|----------|-------------------|
| 🚀 | Enhancements | `feat:` |
| 🔥 | Performance | `perf:` |
| 🩹 | Fixes | `fix:` |
| 💅 | Refactors | `refactor:` |
| 📖 | Documentation | `docs:` |
| 📦 | Build | `build:` |
| 🏡 | Chore | `chore:` |
| ✅ | Tests | `test:` |
| 🤖 | CI | `ci:` |

## Tone & Style

- Enthusiastic but professional; never breathless or salesy
- Highlights explain "why it matters" not just "what changed"
- Code examples are minimal, just enough to show the new pattern
- No em dashes; use commas, semicolons, or separate sentences
- Bold for emphasis sparingly
- Links to PRs use shorthand: `([#123](url))`
- Skip empty changelog categories entirely
