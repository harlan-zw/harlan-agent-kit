# Octorun

Extraction design for a self-hosted [GitHub](https://github.com) workflow agent.

Choose what happens on each repository's pull requests.
GitHub webhooks and manual polling feed the same workflow runtime.
Adversarial review supplies the first preset.

This directory records the extraction design and its implementation requirements.
The [source audit](docs/ideas/source-audit.md) ties recommendations to inspected code and GitHub work.

## Recommended direction

Build one headless package with clear internal boundaries.
Keep GitHub interactions central: one summary comment, review threads, explicit commands, and check runs.
Use ordered task chains first. Require a second, custom chain before calling the runtime general.

Preserve the existing lease fencing, isolated execution, and publication reconciliation.
Move personal host operations into Harlan Agent Kit adapters.

## Read the design

| Read | Purpose |
| --- | --- |
| [Architecture](docs/ideas/architecture.md) | Runtime boundaries, workflow contracts, and review preset |
| [Events and recovery](docs/ideas/events-and-recovery.md) | Delivery, polling, concurrency, retries, and restart behavior |
| [GitHub interactions](docs/ideas/github-interactions.md) | CodeRabbit reference, commands, reviews, threads, and permissions |
| [Extraction](docs/ideas/extraction.md) | Reuse map, portable package, installation, and cutover |
| [Core work](docs/ideas/core-work.md) | Ranked architecture work and acceptance criteria |
| [Public release work](docs/ideas/public-release-work.md) | Ranked UX, packaging, and release work |
| [Vocabulary](GLOSSARY.md) | Octorun concepts and their relationships |

## First implementation

Start with **C01**, the workflow and task contracts.
Then build **C02** and **C03**, durable events and trusted configuration.
These enable the first complete workflow without copying the entire service.

Use C01 through C12 and U01 through U12 as the proposed first-release requirements.
Each list separates later capabilities from those requirements.
Keep issue links as context. Query GitHub for their current state before acting.
