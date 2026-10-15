# Security

Report vulnerabilities through [GitHub's private advisory form](https://github.com/north-brook/pipkin/security/advisories/new), not in a public issue.

pipkin holds a GitHub App private key and runs model calls on its host's ChatGPT plan. Things worth reporting include:

- A way to make pipkin act on a repository it was not triggered from, or with another installation's token.
- A webhook route that accepts unsigned or replayed requests.
- Prompt injection from pull request content that makes pipkin post content or take actions beyond its review.
