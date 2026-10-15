import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

export default githubChannel({
  // GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET come from the
  // environment. botName falls back to GITHUB_APP_SLUG.
  botName: process.env.PIPKIN_BOT_NAME ?? process.env.GITHUB_APP_SLUG ?? "pipkin",
  // A new push while a review runs queues behind it instead of interrupting.
  turnPolicy: "queue",
  onPullRequest: (ctx, pullRequest) => {
    if (!REVIEW_ACTIONS.has(pullRequest.action)) return null;
    const raw = pullRequest.raw as { pull_request?: { draft?: boolean } };
    if (raw.pull_request?.draft) return null;
    return {
      auth: defaultGitHubAuth(ctx),
      title: `Review ${ctx.repository.fullName}#${pullRequest.pullRequestNumber}`,
    };
  },
});
