# Setting up PR Lens on a repository

Three ways to get a diagram into a pull request. Pick one per repository.

| | Who draws | Key | Interactive comment |
| --- | --- | --- | --- |
| This skill | the coding agent, from the diff it wrote | none | no, the diagram sits in the PR body |
| [GitHub App](https://github.com/apps/coldtea-pr-lens) | Coldtea's hosted service, Gemini today | none of yours | yes, one sticky comment, redrawn on every push |
| [Action](../templates/pr-lens.yml) | your CI, on your key | `GEMINI_API_KEY` or OpenAI-compatible | no, one static comment |

## GitHub App

1. Open https://github.com/apps/coldtea-pr-lens and press Install.
2. Choose the account. Pick **Only select repositories** and tick each repository where you review pull requests. Add more later from https://github.com/settings/installations.
3. Approve the permissions: read contents and metadata, read and write pull requests.
4. Open or push to a pull request. The comment appears within a minute and updates in place on every push.

Free for open source. The diff goes to Coldtea's service and to Gemini. Do not install it on a repository whose source may not leave the organisation.

## Action

1. Copy [`templates/pr-lens.yml`](../templates/pr-lens.yml) to `.github/workflows/pr-lens.yml`.
2. Add a `GEMINI_API_KEY` repository secret. For OpenAI or a compatible endpoint, set `provider`, `model`, and `base-url` in the workflow and name the secret to match.
3. The Action publishes SVGs to an orphan `pr-lens` branch and posts one comment per pull request. Pull requests from forks get no secret, so they get no diagram.

## Corrections

When a diagram names a file badly or puts a node in the wrong lane, commit `.github/pr-lens.yml`. Every mode reads it. The format is in [config.md](./config.md).
