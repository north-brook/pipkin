# pipkin

pipkin is a GitHub pull request review bot built on the eve framework. An eve agent is a directory of files under `agent/`; eve compiles and runs it.

## Layout

- `agent/agent.ts`, `agent/instructions.md`: the root agent. It only routes GitHub events to `review_pull_request` or answers follow-up questions.
- `agent/channels/github.ts`: GitHub App webhook channel; decides which pull request events start a turn.
- `agent/tools/review_pull_request.ts`: the review workflow (triage → parallel reviewers → verifier scoring → merge → one GitHub review). Every agent runs on the same model (`agent/lib/models.ts`).
- `agent/subagents/<name>/`: one reviewer per directory, with no tools. Each returns structured findings or a score.
- `agent/lib/`: shared code. `steps.ts` holds every `"use step"` function; `summary.ts`, `prompts.ts` and `schemas.ts` are pure and safe to import from workflow bodies. Anything that touches the network or Node.js APIs (`github.ts`, `context.ts`, `publish.ts`) must only be reached through `steps.ts`.

## eve docs

The eve docs ship in `node_modules/eve/docs/`; start with `README.md` there. Read the relevant page before changing tools, channels, subagents or the sandbox.

## Rules

- Keep reviewer prompts in `agent/lib/prompts.ts` and the subagent `instructions.md` files. Material adapted from upstream projects must stay attributed in `NOTICE`.
- Precision over recall: a change that makes pipkin noisier needs a reason.
- Never commit secrets. Runtime secrets live in `~/.config/pipkin/env`.

## Validate

```sh
npm run typecheck
npx eve build
```

For behaviour changes, dry-run a review locally (see README, "Development").
