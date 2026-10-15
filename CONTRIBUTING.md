# Contributing

Thanks for helping. pipkin is small on purpose; read [AGENTS.md](./AGENTS.md) for the layout and the rules the code follows.

- Precision over recall. A change that makes pipkin noisier needs a reason, ideally a before/after dry run on a real pull request.
- Run `npm run typecheck` and `npx eve build` before opening a pull request. CI runs both.
- For behaviour changes, dry-run a review locally (README, "Development") and describe what changed in the output.
- Prompts adapted from other projects stay attributed in [NOTICE](./NOTICE).
