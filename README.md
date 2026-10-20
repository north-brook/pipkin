<p align="center">
  <img src=".github/assets/pipkin.png" alt="pipkin, a small brown mouse" width="160" height="160">
</p>

<h1 align="center">pipkin</h1>

<p align="center">
  A small, sharp-eyed code review bot for GitHub pull requests.<br>
  Self-hosted on <a href="https://eve.dev">eve</a>, powered by a swarm of GPT-6.1 Sol agents on the ChatGPT plan you already pay for.
</p>

<p align="center">
  <a href="https://github.com/north-brook/pipkin/actions/workflows/ci.yml"><img src="https://github.com/north-brook/pipkin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
</p>

pipkin would rather say nothing than post a false alarm. Six narrow reviewers look at every pull request, an independent verifier scores each candidate finding, and only the high-confidence ones reach your pull request.

## What it looks like

- **One review per push.** Each finding is an inline comment on the line it is about, with a one-click suggested change when the fix is small and certain. The summary is a short verdict that links to each comment, grouped into Bugs, Standards and Spec.
- **A `pipkin` check.** It shows progress while the review runs and links to the result. It concludes success when clean and neutral when there are findings or an incomplete review, so pipkin informs without blocking merges. Re-run it from the Checks tab to review again. For fork pull requests, GitHub may omit the check's pull request association, which eve requires for routing; comment `@pipkin-bot review` to re-run those reviews.
- **Quiet follow-ups.** On a new push pipkin looks for new problems only in what changed since its last review, resolves its own threads for findings the push fixed, and collapses its earlier summaries. It does not repeat findings that are still open, and once you reply to a finding, whether to say it is fixed or that it is not a problem, it does not raise that concern again.
- **Short reviews.** Each review posts at most five findings as threads, highest-scored first, and lists any others in the summary. From the third review of a pull request on, a finding needs a score of 90 instead of 80.
- **Conversation.** Reply to a finding with `@pipkin` to ask about it or push back, or comment `@pipkin review` to run the review again.

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
3. **Verification**: a separate verifier scores each candidate 0–100. Anything under 80 is dropped (90 from the third review of a pull request on).
4. **Merge**: findings from different reviewers that describe the same problem are collapsed into one, and so are new findings that repeat one already open or answered.
5. **Follow-up**: on a new push, checks which of pipkin's open findings the push fixed, and resolves those threads.
6. **One review**: a single GitHub review with inline comments and a short summary grouped by axis. Bugs, Standards, and Spec stay separate so one axis can't hide another.

**Large pull requests.** pipkin leaves lock files, build output and generated code out of every review; mark more with `linguist-generated` or `linguist-vendored` in your root `.gitattributes`. A diff too large for one pass is split into parts of about 120,000 characters, and every pass reviews each part. Past `PIPKIN_MAX_PARTS` parts, or for a single change too large for one part, the review lists the files it could not read in full.

Model calls that fail transiently (an overloaded provider, a rate limit) are retried with backoff. If a pass still fails, the review says it is incomplete and pipkin tries again on the next push.

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
   - Permissions: Checks (read and write), Contents (read), Issues (read), Metadata (read), Pull requests (read and write).
   - Events: Check run, Issue comment, Pull request, Pull request review comment.
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

5. **Expose the webhook route.** Only `/eve/v1/github` needs to be public; it verifies GitHub's webhook signature. Everything else (sessions, workflow callbacks) stays on loopback. With Tailscale Funnel, which needs the `funnel` node attribute in your tailnet policy:

   ```bash
   tailscale funnel --bg --yes --https=10000 \
     --set-path=/eve/v1/github http://127.0.0.1:4318/eve/v1/github
   ```

   Your webhook URL is then `https://<machine>.<tailnet>.ts.net:10000/eve/v1/github`. Funnel serves on ports 443, 8443 and 10000; pick one your other services don't use.

## Configuration

| Variable | Default | |
|---|---|---|
| `PIPKIN_MODEL` | `gpt-6.1-sol` | Model for every pass (triage, reviewers, verifier, merge, follow-up) |
| `PIPKIN_BOT_NAME` | `GITHUB_APP_SLUG` | The `@name` pipkin answers to in comments |
| `PIPKIN_MIN_SCORE` | `80` | Verifier score a finding needs to be posted |
| `PIPKIN_LATE_MIN_SCORE` | `90` | Score a finding needs from a pull request's third review on |
| `PIPKIN_MAX_FINDINGS` | `5` | Findings posted as threads per review; the rest are listed in the summary |
| `PIPKIN_MAX_PARTS` | `8` | Parts a large diff is split into for review; each part costs one call per pass |
| `PIPKIN_DRY_RUN` | unset | `1` logs reviews and checks instead of posting them |
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
