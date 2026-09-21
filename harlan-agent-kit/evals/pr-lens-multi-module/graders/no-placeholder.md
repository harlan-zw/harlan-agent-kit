---
type: regex
target: last_message
pattern: "\\[[^\\]]*(diagram|figure|chart)[^\\]]*goes here[^\\]]*\\]"
flags: i
match: not_contains
weight: 1
---
