---
type: llm
weight: 1
---

A null check at the access site stops this one crash and leaves the category
open, because the type still says a team can have a catalog, no catalog, a
provisioned timestamp with no catalog, or a catalog with no timestamp.

A passing response changes the design instead. It splits `Team` so the
provisioned and unprovisioned states are separate shapes, for example a `_tag`
discriminated union where the provisioned variant carries a required `catalog`
and the unprovisioned variant carries neither field. `readTeamRows` then takes
the provisioned shape, so the call cannot be made with a missing catalog and the
crash becomes unrepresentable.

It fails if the whole fix is a guard at the failure site: `if (!catalog) return`,
`catalog?.id`, a non-null assertion, or a thrown error just before the access,
with the interface left as it is.
