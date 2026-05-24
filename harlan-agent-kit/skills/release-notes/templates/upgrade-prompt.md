# LLM Upgrade Prompt Template

Use this template to generate a self-contained upgrade guide that users can paste into any LLM to get help migrating.

---

## Template

```markdown
# Upgrade Guide: PACKAGE_NAME vPREV to vNEW

You are helping me upgrade PACKAGE_NAME from vPREV to vNEW in my project.

## My Setup

- **Framework:** FRAMEWORK (e.g., Nuxt 3, Vue 3, Node.js)
- **Package manager:** PACKAGE_MANAGER
- **TypeScript:** yes/no

## Breaking Changes

ORDERED_BY_IMPACT_MOST_DISRUPTIVE_FIRST:

### Breaking Change 1: TITLE

**What changed:** Description of the change.

**Why:** Brief motivation for the change.

**Search my codebase for:** `oldFunctionName`, `oldConfigKey`, `import { old } from 'PACKAGE_NAME'`

**Regex pattern:** `oldFunction\s*\(` (for more precise matching)

**Before (vPREV):**
```LANG
// Old usage
oldFunction({ option: true })
```

**After (vNEW):**
```LANG
// New usage
newFunction({ option: true })
```

**Migration steps:**
1. Find all usages of `oldFunction`
2. Replace with `newFunction`
3. Update the import from `old/path` to `new/path`

### Breaking Change 2: TITLE
... repeat pattern ...

## Deprecated APIs

APIs that still work but should be migrated now:

| Deprecated | Replacement | Removal Version |
|-----------|-------------|-----------------|
| `oldApi()` | `newApi()` | vNEXT_MAJOR |

## Configuration Changes

If config files changed format:

**Before (vPREV):**
```LANG
// old config format
```

**After (vNEW):**
```LANG
// new config format
```

## Dependency Changes

These dependencies also changed and may require attention:

| Dependency | Old Version | New Version | Notes |
|-----------|-------------|-------------|-------|
| DEP_NAME | vOLD | vNEW | MIGRATION_NOTE |

## Verification Checklist

After making all changes, verify the upgrade in this order:
1. `pnpm install` (update lockfile)
2. TYPECHECK_COMMAND (catch type errors from API changes)
3. BUILD_COMMAND (catch build-time issues)
4. TEST_COMMAND (catch runtime regressions)
5. MANUAL_CHECK (e.g., "test SSR rendering", "verify auth flow")

---

Please scan my codebase for all affected patterns listed above and generate a complete migration plan. For each file that needs changes, show me the exact diff. Group changes by breaking change so I can review them incrementally.
```

---

## Usage Instructions

When generating an upgrade prompt from the template:

1. **Replace all placeholders** (PACKAGE_NAME, vPREV, vNEW, etc.) with real values
2. **Be specific about search patterns**: give exact function names, import paths, config keys, AND regex patterns for grep
3. **Include real before/after examples** from the actual API changes, not generic placeholders
4. **Add verification steps** specific to the package (e.g., "run `nuxi typecheck`", "check SSR renders correctly")
5. **Order breaking changes by impact**: most common/disruptive first
6. **Fill in the "My Setup" section** with the project's actual framework, package manager, and TS usage
7. **Include dependency changes** if transitive deps also had major bumps
8. **Include the "scan my codebase" instruction** at the end so the LLM knows to proactively search
