# pipkin

A small, sharp-eyed code review bot for GitHub pull requests. Self-hosted, built on [eve](https://eve.dev), and powered by the ChatGPT subscription you already pay for through Codex.

pipkin would rather say nothing than post a false alarm. Every candidate finding is scored by an independent verifier, and only high-confidence issues reach your pull request.

## How it reviews

On every opened, reopened, ready-for-review, or pushed pull request:

1. **Triage**: skips drafts, closed PRs, bot release bumps, trivial changes, and commits it already reviewed.
2. **Six reviewers in parallel**, each with a narrow job:
   | Reviewer | Looks for | Axis |
   |---|---|---|
   | `bugs` | Significant bugs in the changed lines | Bugs |
   | `history` | Regressions visible in git blame and file history | Bugs |
   | `comments` | Changes that violate guidance in nearby code comments | Bugs |
   | `rules` | Violations of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, plus a Fowler smell baseline | Standards |
   | `precedent` | Feedback from earlier PRs on the same files that applies again | Standards |
   | `spec` | Gaps against the PR description and linked issues (runs only when a spec exists) | Spec |
3. **Verification**: a separate verifier scores each candidate 0–100. Anything under 80 is dropped.
4. **One review**: a single GitHub review with inline comments and a short summary grouped by axis. Bugs, Standards, and Spec stay separate so one axis can't hide another.

Mention `@pipkin` in a PR comment to ask a question about a finding, or ask it to `review again`.

## Requirements

- macOS or Linux host that stays on (pipkin runs as a long-lived Node service).
- Node.js 24+.
- The [Codex CLI](https://developers.openai.com/codex) signed in with a ChatGPT plan that includes the models you choose (`codex login`). pipkin calls models through `codex app-server`, so reviews draw on that subscription's usage limits.
- A public HTTPS URL for GitHub webhooks (for example Tailscale Funnel, Cloudflare Tunnel, or a reverse proxy).

## Setup

1. **Clone and install**

   ```bash
   git clone https://github.com/north-brook/pipkin && cd pipkin
   npm ci
   ```

2. **Create the GitHub App.** Use `deploy/github-app-manifest.json` with your webhook URL (`https://<your-host>/eve/v1/github`), or create one by hand with:
   - Permissions: Contents (read), Issues (read), Metadata (read), Pull requests (read and write).
   - Events: Pull request, Issue comment, Pull request review comment.
   - A webhook secret.

   Install the app on the repositories pipkin should review.

3. **Configure secrets**

   ```bash
   mkdir -p ~/.config/pipkin
   cp deploy/env.example ~/.config/pipkin/env
   chmod 600 ~/.config/pipkin/env
   # fill in GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY
   ```

4. **Run it**

   ```bash
   ./deploy/install-macos.sh   # builds and installs a launchd agent on 127.0.0.1:4318
   ```

   On Linux, run `npx eve build && npx eve start --port 4318` under your process manager with the same environment.

5. **Expose the webhook route.** Forward both `/eve/` and `/.well-known/workflow/` to the service. With Tailscale Funnel:

   ```bash
   tailscale funnel --bg --set-path /eve http://127.0.0.1:4318/eve
   ```

   Only `/eve/v1/github` needs to be public; it verifies GitHub's webhook signature.

## Configuration

| Variable | Default | |
|---|---|---|
| `PIPKIN_REVIEW_MODEL` | `gpt-6.1-sol` | Model for the six reviewers |
| `PIPKIN_TRIAGE_MODEL` | `gpt-6-luna` | Model for triage and verification |
| `PIPKIN_MIN_SCORE` | `80` | Verifier score a finding needs to be posted |
| `PIPKIN_DRY_RUN` | unset | `1` logs reviews instead of posting them |
| `PIPKIN_ADMIN_PASSWORD` | unset | Enables `eve remote connect` with user `pipkin` |

Teach pipkin your conventions by writing them down: it reads `AGENTS.md` and `CLAUDE.md` at the root and in every directory a PR touches, plus `CONTRIBUTING.md` and `CODING_STANDARDS.md`.

## Development

```bash
npm run typecheck
PIPKIN_GITHUB_TOKEN=$(gh auth token) PIPKIN_DRY_RUN=1 npx eve dev
```

`PIPKIN_GITHUB_TOKEN` lets you run reviews locally against any repository your token can read, without a GitHub App. In the dev TUI, ask: `review <owner>/<repo> pull request <n> with force true`.

## Credits

The review passes, false-positive list, and confidence rubric are adapted from Anthropic's [`code-review` plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review) (Apache-2.0). The Spec axis and smell baseline are adapted from Matt Pocock's [`code-review` skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review) (MIT). See [NOTICE](./NOTICE).

## License

Apache-2.0
