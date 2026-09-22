---
type: regex
target: last_message
pattern: "(?:^|\\n)#+ *[^\\n]*(test|verification|qa)"
flags: i
match: not_contains
weight: 1
---
