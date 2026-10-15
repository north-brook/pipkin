import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { CHECK_EXTERNAL_ID, CHECK_NAME } from "../lib/checks";
import { botName, botSlug } from "../lib/identity";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

export default githubChannel({
  // GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET come from the environment.
  botName: botName(),
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
  // "Re-run" on pipkin's check in the Checks tab forces a fresh review.
  onCheckRun: (ctx, checkRun) => {
    const raw = checkRun.raw as { check_run?: { name?: string; external_id?: string } };
    if (checkRun.action !== "rerequested" || checkRun.app.slug !== botSlug()) return null;
    if (raw.check_run?.external_id !== CHECK_EXTERNAL_ID && raw.check_run?.name !== CHECK_NAME) return null;
    const number = checkRun.pullRequests[0];
    if (number === undefined) return null;
    return {
      auth: defaultGitHubAuth(ctx),
      context: [`${ctx.sender.login} re-ran the pipkin check on pull request #${number}. Review it again with force: true.`],
      title: `Re-review ${ctx.repository.fullName}#${number}`,
    };
  },
  events: {
    // pipkin reviews through the GitHub API with no sandbox, so skip eve's
    // default repository checkout. Acknowledge mentions with an eyes reaction.
    "turn.started": async (_data, channel) => {
      await channel.thread.react("eyes").catch(() => undefined);
    },
    // A failed review already reports on the pipkin check. Only answer in the
    // thread when a person asked something, so pushes never leave error comments.
    "turn.failed": async (data, channel) => {
      if (data.terminal || channel.state.triggeringCommentId === null) return;
      await channel.thread.post("Sorry, I ran into an error answering that. Mention me again to retry.");
    },
    "session.failed": async (_data, channel) => {
      if (channel.state.triggeringCommentId === null) return;
      await channel.thread.post("Sorry, I ran into an error and could not finish. Mention me again to retry.");
    },
  },
});
