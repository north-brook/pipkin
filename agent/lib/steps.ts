import {
  loadChangedFileContents,
  loadHistory,
  loadPrecedent,
  loadPullRequest,
  type PullRequestContext,
} from "./context";
import { resolveInstallation, type Repo } from "./github";
import { alreadyReviewed, publishReview, type ScoredFinding } from "./publish";

// Durable steps for the review workflow. Everything that touches the network,
// the clock or Node.js APIs lives behind these, so the workflow body stays
// deterministic and replayable.

export async function loadPullRequestStep(repo: Repo, number: number) {
  "use step";
  return loadPullRequest(repo, number);
}

export async function resolveInstallationStep(owner: string, repo: string, fromWebhook: string | readonly string[] | undefined) {
  "use step";
  const id = Number(Array.isArray(fromWebhook) ? fromWebhook[0] : fromWebhook);
  return Number.isInteger(id) && id > 0 ? id : resolveInstallation(owner, repo);
}

export async function alreadyReviewedStep(repo: Repo, number: number, headSha: string) {
  "use step";
  return alreadyReviewed(repo, number, headSha);
}

export async function loadExtrasStep(context: PullRequestContext) {
  "use step";
  const [history, precedent, files] = await Promise.all([
    loadHistory(context),
    loadPrecedent(context),
    loadChangedFileContents(context),
  ]);
  return {
    history,
    precedent,
    files: files.map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n"),
  };
}

export async function publishReviewStep(
  context: PullRequestContext,
  body: string,
  findings: ScoredFinding[],
  complete: boolean,
) {
  "use step";
  if (process.env.PIPKIN_DRY_RUN === "1") {
    console.log(`[pipkin] dry run: review for ${context.repo.owner}/${context.repo.repo}#${context.number}\n${body}`);
    for (const finding of findings) console.log(`[pipkin] ${finding.path}:${finding.line} (${finding.reviewer}, ${finding.score}) ${finding.title}`);
    return { url: "dry-run", inlineComments: 0 };
  }
  return publishReview(context, body, findings, complete);
}
