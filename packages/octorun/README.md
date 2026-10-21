# Octorun

Run reactive GitHub workflows with your own agent provider.
Choose a task chain for each repository's pull requests.
Use GitHub comments, grouped findings, and check runs to follow the result.

## Why Octorun

A pull request can need a review, a change summary, or another task chain.
Octorun gives those tasks one durable runtime and one GitHub interface.
The first preset runs an adversarial review.
A second preset classifies changes, writes a summary, and updates a comment.
Both use the same scheduler and task contract.

## Features

- 🔄 **Reactive workflows:** GitHub webhooks and polling feed the same runtime.
- 💬 **GitHub interactions:** Explicit commands control reviews and keep their result on the pull request.
- 🧩 **Task chains:** Ordered tasks share typed outputs, conditions, retry limits, and usage budgets.
- 🔐 **Repository policy:** Explicit App mappings limit which repositories and capabilities each workflow can use.
- 💾 **Recovery:** SQLite records events, runs, outputs, and GitHub publication identities across restarts.

## Setup

Use Linux with Node.js 24 or newer and pnpm.
Provide a GitHub App installation and an OpenAI-compatible chat completion endpoint.
The review preset sends pull request text and diffs to the configured agent provider.
It runs no repository code or shell commands.

From the repository root, build a tarball:

```bash
pnpm install --frozen-lockfile
pnpm --filter octorun build
pnpm --filter octorun pack --out /tmp/octorun.tgz
```

From an unrelated directory, install that tarball:

```bash
pnpm add --global /tmp/octorun.tgz
octorun help
```

If pnpm reports a missing global binary directory, run `pnpm setup` and open a new shell before repeating installation.

The tarball contains the CLI, library declarations, preset implementation, examples, and license.
Use a release tarball from your chosen source when installing outside this checkout.

Create configuration with your App and repository IDs:

```bash
octorun init --repository your-org/your-repository \
  --repository-id 456 --installation-id 789 --app-id 123 \
  --model your-provider-model
```

The file names environment variables for credentials.
Set those variables through your service manager or secret manager.
`OCTORUN_GITHUB_PRIVATE_KEY` holds the complete App PEM private key.
`OCTORUN_API_KEY` holds the agent provider key.
`OCTORUN_WEBHOOK_SECRET` is optional for polling and required for webhook delivery.
Use at least 16 characters for that secret.

```bash
octorun validate
octorun doctor
octorun doctor --online
octorun plan --repository your-org/your-repository --pr 7
octorun run --repository your-org/your-repository --pr 7
```

`plan` shows the selected workflow without starting its tasks.
`run` processes the requested pull request through the selected workflow.
To process future events continuously, run `octorun serve`.

Read [first review](docs/guides/first-review.md) for App permissions, credentials, webhooks, and initial polling.

## Guides

| Guide | Task |
| --- | --- |
| [First review](docs/guides/first-review.md) | Configure an App and run a review |
| [Workflows](docs/guides/workflows.md) | Select presets, chain tasks, and load trusted definitions |
| [Operations](docs/guides/operations.md) | Inspect runs, pause admission, back up, restore, and recover |
| [Configuration example](examples/config.yaml) | Copy a complete operator configuration |
| [Extraction design](docs/ideas/architecture.md) | Understand the design and original acceptance criteria |
| [Vocabulary](GLOSSARY.md) | Look up workflow, task, event, and repository policy |

## API

The package exports the runtime, store, workflow parser, task contracts, and service factory.
Task implementations register with `createRunner`.
Their capabilities must fit the repository policy.
Repository configuration cannot register executable JavaScript.

Focused entry points include `octorun/config`, `octorun/server`, `octorun/github`, `octorun/review`, and `octorun/providers`.
See [workflows](docs/guides/workflows.md) for a custom task example.

## License

[MIT](LICENSE.md).
