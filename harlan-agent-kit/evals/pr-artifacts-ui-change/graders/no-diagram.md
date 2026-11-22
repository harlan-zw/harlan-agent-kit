---
type: regex
target: last_message
pattern: "(```mermaid|\\.pr-lens/|pr-lens-renderer)"
flags: i
match: not_contains
weight: 1
---
