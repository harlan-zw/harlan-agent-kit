---
name: ts-design-patterns
description: Harlan's TypeScript design principles (Effect-inspired, no Effect dependency) for modelling state, errors, and dependencies. Use when designing or reviewing non-trivial TypeScript, choosing how to represent state or failures, structuring a module's boundaries, or when a review needs a taste rubric for TS API design.
user_invocable: true
---

<!-- The six principles below are mirrored verbatim in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md. Run scripts/check-agent-context.sh after editing them. -->


# TypeScript Design Patterns

Effect-inspired, without an Effect dependency.

- **Make illegal states unrepresentable.** `_tag` discriminated unions, not optional-field + boolean soup.
- **Errors as values.** Tagged `Ok | Err` for expected domain failures so signatures show them. Unexpected/infra errors propagate; prefer `.catch()` over try/catch when handling is needed.
- **No silent catches.** `.catch(() => null)` hides failures: handle (log, surface, fallback with reason) or propagate. Swallow only genuinely ignorable failures, with a comment saying so.
- **Parse, don't validate.** Validate untrusted input once at the boundary into a precise type; trust it inward.
- **Explicit dependencies.** Pass clients/config/clock as args; no hidden singletons or import-time side effects.
- **Pure core, effectful shell.** Side effects at edges, decision logic pure data-in/data-out.
- **Design out the bug.** After a production error, ask what design makes that kind of bug impossible. Prefer a type or structural change; guard at the failure site only when no design change exists.

## As a review rubric

When reviewing TS, score against each principle and report only violations that change behaviour or block testing. A class that wraps state with no illegal-state risk is a style note, not a finding; a `catch` that swallows a network failure is a finding.
