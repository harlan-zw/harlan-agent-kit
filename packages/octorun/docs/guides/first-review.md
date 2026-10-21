# Run your first review

Use a Linux host with Node.js 24 or newer.
Install the Octorun tarball using the [README instructions](../../README.md#setup).
You need a GitHub App, one installed repository, and an agent provider key.

## Configure the App

[Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
Install it only on the repositories you want Octorun to process.
Record its App ID, installation ID, and each repository ID.
Generate an App private key and store it outside the checkout.

For the review preset, configure these repository permissions:

| Permission | Access | Used for |
| --- | --- | --- |
| Metadata | Read | Repository identity and installation access |
| Contents | Read | Trusted workflow definitions and pinned review snapshots |
| Pull requests | Read and write | Pull request data, grouped reviews, and finding replies |
| Issues | Read and write | Pull request comment commands and the overview comment |
| Checks | Read and write | Workflow progress and native re-run actions |

The App does not need Contents write or Administration access for this preset.
GitHub permissions determine available API calls and webhook subscriptions.
[GitHub permission reference](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

If you use webhooks, subscribe to Pull request, Issue comment, Pull request review comment, and Check run events.
Set the webhook URL to your HTTPS proxy followed by `/webhooks/github`.
Configure the same webhook secret on GitHub and the Octorun host.
GitHub also supports App installations with webhooks disabled for polling.
[GitHub webhook setup](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

## Create the configuration

Run this from any directory.
Replace the example IDs and model with your own values.

```bash
octorun init --repository your-org/your-repository \
  --repository-id 456 --installation-id 789 --app-id 123 \
  --model your-provider-model
```

`init` creates a private configuration file and refuses to overwrite an existing file.
The default path is `$XDG_CONFIG_HOME/octorun/config.yaml`.
If `XDG_CONFIG_HOME` is unset, it uses `~/.config`.
Pass `--config FILE` on later commands to use another location.

Set the environment variables named in the configuration:

| Variable | Value |
| --- | --- |
| `OCTORUN_GITHUB_PRIVATE_KEY` | The complete PEM private key, including its line breaks |
| `OCTORUN_API_KEY` | The configured agent provider's API key |
| `OCTORUN_WEBHOOK_SECRET` | A shared webhook secret with at least 16 characters |

Use your service manager or secret manager to provide these values.
Configuration files contain references to secrets.
Do not place the secret values in YAML.
For polling alone, leave `OCTORUN_WEBHOOK_SECRET` unset.

If your provider uses another OpenAI-compatible endpoint, set `provider.baseUrl` and `provider.model` in the configuration.
HTTPS is required except for a local HTTP endpoint on localhost.
The provider receives the pull request text and diff.
Select an endpoint that matches your repository's data policy.

```bash
octorun validate
octorun doctor
octorun doctor --online
```

`validate` parses the configuration without requiring credentials.
`doctor` checks credential references without printing their values.
`doctor --online` checks access to the configured GitHub repositories.
It exits with code 1 if an access check fails.
If a check fails, apply the error's remedy before running a review.

## Run one pull request

Preview the pinned target, task capabilities, and limits, then run the selected workflow:

```bash
octorun plan --repository your-org/your-repository --pr 7
octorun run --repository your-org/your-repository --pr 7
```

The review preset captures the pull request's head and base revisions.
It asks the agent provider for findings and verifies their evidence before publishing.
This verification inspects supplied code and diff evidence.
It does not execute repository tests.
Check the pull request overview and its Octorun check run for the result.
Use `octorun inspect` and `octorun logs` to inspect local state.
`run` exits with code 1 for a failed, cancelled, or superseded run.
It preserves the run result in its output.
A waiting run remains accepted and exits with code 0.
Inspect its hold reason before retrying.

## Keep processing events

```bash
octorun serve
```

The controller processes accepted tasks and polls at `pollIntervalMs`.
It also accepts signed webhooks if you configured a webhook secret.
The default HTTP address is `127.0.0.1:3333`.
Your HTTPS proxy must preserve the request body and GitHub signature headers.
`GET /healthz` checks process liveness.
`GET /readyz` checks controller readiness.

The first poll establishes an observation boundary.
To include existing pull requests explicitly, run:

```bash
octorun poll --backfill existing
```

Without backfill, polling processes later observed changes.
Polling observes current state and cannot reconstruct every missed historical event.
For an immediate review of one existing pull request, use `octorun run`.

On a pull request, start with `@octorun help`.
If you changed `handle`, use that configured name.
Commands include review, full review, run, status, configuration, pause, resume, and cancel.
Repository permissions determine who can start model work or change run state.
