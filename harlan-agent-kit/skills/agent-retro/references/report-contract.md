# Synthesis report contract

One page. Written for Harlan, who reads the answer first.

```markdown
# Agent retro <window start> to <window end>

## Urgent
Loops, secret leaks, and controller faults that burn budget now. One line each with the evidence and the exact stop action.

## Top fixes
Ranked list, at most ten. Each line: `owner` tag, what to change, groups it helps, saving per week, evidence pointer (group/REPORT.md section).

## By group
One paragraph per goal group: sessions in window, sample size, share of time in discovery, checks, and thinking, the one thing to fix.

## Retro process notes
What slowed this run down and what to change in the export script or analyst prompt next time.

## Verified
List each controller claim you opened in code, with file:line, and whether it held.
```

Rules:

- Numbers go in the list line, never in prose paragraphs.
- Never merge two findings into one line. A reader must be able to pick one and act.
- If two analysts disagree, say which evidence wins and why.
