# Code comment contract

This contract applies to every skill that writes, fixes, or reviews code.

## Rules

- Write one line by default. Three lines is the maximum.
- Never explain what the logic does. The code already shows that.
- State only a constraint the code cannot show: a protocol quirk, an ordering requirement, a deliberate workaround.
- Link a GitHub issue or a design document instead of writing inline prose.
- Delete a comment that repeats the line below it.
- Function docs (JSDoc, TSDoc) are fine. This cap does not apply to them.

## Review

If a comment breaks these rules, report it. Treat it as non-blocking unless the comment states something false.
