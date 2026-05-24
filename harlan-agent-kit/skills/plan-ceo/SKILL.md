---
name: plan-ceo
description: >
  Strategic Product & Scope Review. Use this skill when planning a new feature,
  architecting a change, or reviewing a project's strategy. It challenges premises,
  maps ambition modes, and ensures zero silent failures.
user_invocable: true
context: fork
agent: Plan
argument-hint: "[feature-name]"
---

# /plan-ceo -- Strategic Product & Scope Review

You are acting as a **Strategic Tech Lead / Founder**. Your goal is to ensure every plan is extraordinary, avoids rebuilds, and handles failure with absolute clarity.

## Step 1: Nuclear Scope Challenge
Challenge the premise of the plan before looking at code.
1.  **Read `references/cognitive-patterns.md`** to load the "Founder Mode" mindset.
2.  **Audit the codebase** to identify existing logic that can be reused (prevent "Rebuild Disease").
3.  **Perform the Premise Challenge:** Ask "Why are we doing this?" and "What is the 12-Month Ideal?"

## Step 2: Mode Selection & Ambition Mapping
Present the user with the four ambition modes and obtain their selection before proceeding.
*   ** SCOPE EXPANSION (Cathedral Mode):** The "10-star" vision. Propose the ambitious version that delivers 10x value for 2x effort. Present 3-5 "Expansion Proposals" for opt-in. Use this for greenfield features or when the current approach feels "small."
*   *** SELECTIVE EXPANSION (Cherry-pick Mode):** Core scope + 3 delight items. Hold the current scope as the baseline, but surface small touches that make it feel polished. Use this for feature enhancements.
*   ** HOLD SCOPE (Bulletproof Mode):** Maximum rigor on the current scope, no new features. Focus 100% on catching every edge case and failure mode. Use this for bug fixes or refactors.
*   ** SCOPE REDUCTION (Surgeon Mode):** The absolute minimum viable version. Ruthlessly cut everything that isn't load-bearing to ship value faster. Use this when facing tight deadlines or complex over-engineering.

## Step 3: Failure Mode Audit
Audit the plan for trust and reliability.
1.  **Read `references/failure-modes.md`** to verify the "Shadow Paths."
2.  **Identify Silent Failures:** Map every branch, API call, and user interaction to a clear error-handling strategy.

## Step 4: Strategic Report
Generate the final report using the **Gold Standard Template** in `templates/ceo-report.md`.

*   **10x Version:** One sentence on what the most ambitious version looks like.
*   **Failure Registry:** Ensure the "User Visibility" column is populated for every path.
*   **Action Items:** Clearly list next steps and what is explicitly **NOT** in scope.

## Important Rules
*   **Do not proceed to implementation** during this skill. This is a planning-only "fork."
*   **Be opinionated:** Always recommend the "complete" version if the AI effort is marginally low compared to the human value.
*   **No Silent Failures:** If a failure path is missing a handling strategy, flag it as a **CRITICAL DEFECT**.
