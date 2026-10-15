import { type CheckConclusion, type CheckOutput, finishCheck, startCheck, updateCheck } from "./checks";
import {
  loadChangedFileContents,
  loadHistory,
  loadPrecedent,
  loadPullRequest,
  type PullRequestContext,
} from "./context";
import { resolveInstallation, type Repo } from "./github";
import {
  compareCommits,
  lastReviewedHead,
  loadEarlierFindings,
  minimizeEarlierReviews,
  publishReview,
  resolveThreads,
} from "./publish";
import { botName } from "./identity";
import { inlineBody, renderReview, type ReviewReport } from "./summary";

// Durable steps for the review workflow. Everything that touches the network,
// the clock or Node.js APIs lives behind these, so the workflow body stays
// deterministic and replayable.

const dryRun = () => process.env.PIPKIN_DRY_RUN === "1";

export async function loadPullRequestStep(repo: Repo, number: number) {
  "use step";
  return loadPullRequest(repo, number);
}

export async function resolveInstallationStep(owner: string, repo: string, fromWebhook: string | readonly string[] | undefined) {
  "use step";
  const id = Number(Array.isArray(fromWebhook) ? fromWebhook[0] : fromWebhook);
  return Number.isInteger(id) && id > 0 ? id : resolveInstallation(owner, repo);
}

export async function lastReviewedHeadStep(repo: Repo, number: number) {
  "use step";
  return lastReviewedHead(repo, number);
}

export async function loadEarlierFindingsStep(repo: Repo, number: number) {
  "use step";
  return loadEarlierFindings(repo, number);
}

export async function compareCommitsStep(repo: Repo, base: string, head: string) {
  "use step";
  return compareCommits(repo, base, head, 60_000);
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

/** Opens the in-progress check. Returns null when the app lacks the Checks permission, so reviews still post. */
export async function startCheckStep(repo: Repo, headSha: string, detailsUrl: string, title: string, summary: string) {
  "use step";
  if (dryRun()) return null;
  try {
    return await startCheck(repo, headSha, detailsUrl, title, summary);
  } catch (error) {
    console.warn("[pipkin] could not create the check run:", error);
    return null;
  }
}

export async function updateCheckStep(repo: Repo, checkId: number | null, title: string, summary: string) {
  "use step";
  if (checkId === null) return;
  await updateCheck(repo, checkId, title, summary).catch((error) => console.warn("[pipkin] could not update the check run:", error));
}

export async function finishCheckStep(repo: Repo, checkId: number | null, conclusion: CheckConclusion, output: CheckOutput) {
  "use step";
  if (dryRun()) {
    console.log(`[pipkin] dry run: check ${conclusion}: ${output.title}\n${output.summary}`);
    return;
  }
  if (checkId === null) return;
  await finishCheck(repo, checkId, conclusion, output).catch((error) => console.warn("[pipkin] could not finish the check run:", error));
}

/** Resolves fixed findings' threads and collapses earlier summaries before the new review posts. */
export async function tidyEarlierReviewsStep(repo: Repo, number: number, fixedThreadIds: string[]) {
  "use step";
  if (dryRun()) {
    console.log(`[pipkin] dry run: would resolve ${fixedThreadIds.length} fixed thread(s) and minimize earlier summaries`);
    return fixedThreadIds;
  }
  const resolved = await resolveThreads(repo, fixedThreadIds);
  await minimizeEarlierReviews(repo, number).catch((error) => console.warn("[pipkin] could not minimize earlier reviews:", error));
  return resolved;
}

export async function publishReviewStep(context: PullRequestContext, report: ReviewReport, suggestionOk: boolean[]) {
  "use step";
  if (dryRun()) {
    console.log(`[pipkin] dry run: review for ${context.repo.owner}/${context.repo.repo}#${context.number}\n${renderReview(context, report, [], botName())}`);
    report.findings.forEach((finding, index) => {
      console.log(`[pipkin] ${finding.path}:${finding.line} (${finding.reviewer}, ${finding.score}${suggestionOk[index] ? ", suggestion" : ""}) ${finding.title}`);
      if (suggestionOk[index]) console.log(inlineBody(finding, true));
    });
    return { url: context.url, inlineComments: 0 };
  }
  return publishReview(context, report, suggestionOk);
}
