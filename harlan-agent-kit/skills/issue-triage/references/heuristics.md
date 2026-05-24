# Triage Heuristics

## Difficulty Scale (1-5)

| Score | Meaning | Signals |
|-------|---------|---------|
| 1 | Typo, config, or docs change | Single line, obvious fix |
| 2 | Single-file logic change | Clear reproduction, isolated scope |
| 3 | Multi-file change, needs testing | Touches multiple modules, needs new tests |
| 4 | Architectural or cross-cutting | Design decisions required, multiple subsystems |
| 5 | Unknown scope, research needed | No repro, vague description, set `needsCodebaseReview: true` |

## Impact Scale (1-5)

| Score | Meaning | Signals |
|-------|---------|---------|
| 1 | Cosmetic, niche use case | Low comment count, edge-case scenario |
| 2 | Minor improvement, few users | Nice-to-have enhancement |
| 3 | Moderate user-facing value | Several users affected, reasonable workaround exists |
| 4 | Significant pain point | High comment count, common request, poor workaround |
| 5 | Critical bug, data loss, security | Production breakage, no workaround |

## Signal Weighting

- **Comment count** — high count → community interest/severity
- **Assignees** — someone may already be working on it
- **Labels** — "good first issue" suggests low difficulty, "bug" usually higher impact than "enhancement"
- **Age** — old + no assignee → possibly stale or deprioritized
- **Reproduction** — stackblitz/codesandbox links, minimal repos, clear steps → `hasRepro: true`
- **Cross-references** — multiple issues mentioning the same root cause → higher effective impact
