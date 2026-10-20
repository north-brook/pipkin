import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import type { CheckConclusion } from "../lib/checks";
import type { PullRequestContext } from "../lib/context";
import { type DiffPart, newSideText, renderPatches, splitDiff, touchedSince } from "../lib/diff";
import type { Repo } from "../lib/github";
import {
  CONFIDENCE_RUBRIC,
  FALSE_POSITIVES,
  FINDING_INSTRUCTIONS,
  SMELL_BASELINE,
  renderDiscussedForVerifier,
  renderEarlierFinding,
  renderFollowUp,
  renderFollowUpScope,
  renderPullRequest,
  renderRulesFiles,
  renderSpec,
} from "../lib/prompts";
import { type Finding, Findings, FollowUp, Groups, type Reviewer, Score, Triage } from "../lib/schemas";
import {
  compareCommitsStep,
  finishCheckStep,
  lastReviewedHeadStep,
  loadEarlierFindingsStep,
  loadExtrasStep,
  loadPullRequestStep,
  publishReviewStep,
  resolveInstallationStep,
  startCheckStep,
  tidyEarlierReviewsStep,
  updateCheckStep,
} from "../lib/steps";
import { checkTitle, type EarlierFinding, headline, isIncomplete, type ReviewReport, type ScoredFinding } from "../lib/summary";

const MIN_SCORE = Number(process.env.PIPKIN_MIN_SCORE ?? 80);
/** From this many complete reviews of a pull request on, a finding needs a higher score. */
const LATE_ROUND = 2;
const LATE_MIN_SCORE = Number(process.env.PIPKIN_LATE_MIN_SCORE ?? 90);
const MAX_POSTED_FINDINGS = Number(process.env.PIPKIN_MAX_FINDINGS ?? 5);
const MAX_SCORED_FINDINGS = 40;
const MAX_SUGGESTION_LINES = 8;
/** The most diff one review pass reads. A larger diff is split into parts, each reviewed by every pass. */
const MAX_PART_CHARS = 120_000;
/** Bounds the model calls one review makes; past this many parts, the rest of the diff is left out. */
const MAX_PARTS = Number(process.env.PIPKIN_MAX_PARTS ?? 8);

export default defineWorkflowTool({
  description:
    "Run pipkin's full multi-pass review on a pull request and post the result as one GitHub review with a pipkin check run. Use it once for each new head commit that needs a review.",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    pullRequestNumber: z.number().int(),
    force: z.boolean().default(false).describe("Review even if this head commit was already reviewed, triage would skip it, or it is not open."),
  }),
  async execute(input, ctx) {
    "use workflow";
    // The installation comes from the verified webhook, never from the model.
    const installationId = await resolveInstallationStep(
      input.owner,
      input.repo,
      ctx.session.auth.current?.attributes.installation_id,
    );
    const repo: Repo = { owner: input.owner, repo: input.repo, installationId };

    // 1. Eligibility.
    const context = await loadPullRequestStep(repo, input.pullRequestNumber);
    if (!input.force && (context.state !== "open" || context.draft)) return { posted: false, reason: `pull request is ${context.draft ? "a draft" : context.state}` };
    let checkId: number | null = null;
    try {
      const previous = await lastReviewedHeadStep(repo, context.number);
      if (!input.force && previous.head === context.headSha) return { posted: false, reason: "this head commit was already reviewed" };
      checkId = await startCheckStep(repo, context.headSha, context.url, "Reviewing…", "Reading the pull request.");
      return await review(ctx, repo, context, previous, checkId, input.force);
    } catch (error) {
      // Leave the head unmarked so the next push or mention retries it.
      if (checkId === null) checkId = await startCheckStep(repo, context.headSha, context.url, "Review failed", "The review could not finish.");
      await finishCheckStep(repo, checkId, "neutral", {
        title: "Review failed",
        summary: `pipkin could not finish this review: ${error instanceof Error ? error.message : String(error)}\n\nIt will try again on the next push. Re-run this check or comment to retry sooner.`,
      });
      throw error;
    }
  },
});

async function review(
  ctx: WorkflowToolContext,
  repo: Repo,
  context: PullRequestContext,
  previous: { head: string | null; count: number },
  checkId: number | null,
  force: boolean,
) {
  const previousHead = previous.head;
  const split = splitDiff(context.files, MAX_PART_CHARS, MAX_PARTS);
  // 2. Triage.
  const triage = await ask(ctx, "triage", Triage, `${renderPullRequest(context, split.parts[0] ?? null)}\n\nDecide whether to review this pull request, and summarize what it changes in 2-3 sentences.`);
  if (!triage) throw new Error("triage did not return a result");
  // Triage reads only the first part, so it may skip only a pull request it saw in full.
  if (!force && !triage.review && split.parts.length <= 1 && split.omitted.length === 0) {
    await finishCheckStep(repo, checkId, "skipped", { title: "Skipped", summary: triage.reason });
    return { posted: false, reason: triage.reason };
  }

  // 3. What pipkin said about earlier commits and, on a follow-up, the changes
  // since its last complete review.
  const [earlier, changes] = await Promise.all([
    loadEarlierFindingsStep(repo, context.number),
    previousHead === null || previousHead === context.headSha ? null : compareCommitsStep(repo, previousHead, context.headSha),
  ]);
  const spec = renderSpec(context);
  const hasSpec = context.linkedIssues.length > 0 || context.body.trim().length >= 80;
  // A follow-up looks for new problems only in what changed since the last review,
  // so it skips parts of the diff with none of those changes. A requested review,
  // or one without a usable comparison (a force-push), covers everything.
  const scoped = !force && changes !== null ? changes : null;
  const inScope = scoped === null ? null : touchedSince(scoped.files);
  const parts = inScope === null ? split.parts : split.parts.filter((part) => part.ranges.some((range) => inScope(range.path, range.start, range.end ?? Infinity)));
  // A finding someone answered is settled, resolved or not; never raise it again.
  const discussed = earlier.filter((finding) => finding.replies.length > 0);
  const open = earlier.filter((finding) => !finding.resolved);

  // 4. Independent reviewers over each part of the diff, with the follow-up check alongside them.
  const [runs, fixed] = await Promise.all([
    reviewParts(ctx, repo, checkId, context, parts, { scoped, discussed, spec, hasSpec }),
    followUp(ctx, context, changes?.diff ?? null, open),
  ]);
  const failedRuns = runs.filter((run) => run.findings === undefined);
  // Never post an all-clear for passes that did not run; leave the head unreviewed so it is retried.
  if (runs.length > 0 && failedRuns.length === runs.length) throw new Error("every review pass failed");
  const failedReviewers = [...new Set(failedRuns.map((run) => run.reviewer))];
  const ranReviewers = [...new Set(runs.map((run) => run.reviewer))].filter((reviewer) => !failedReviewers.includes(reviewer));
  const proposed = dedupe(
    runs.flatMap((run) =>
      // A finding must be about a file in the part its reviewer read.
      (run.findings ?? []).filter((finding) => run.part.paths.includes(finding.path)).map((finding) => ({ ...finding, reviewer: run.reviewer, part: run.part })),
    ),
  );
  const inChanges = inScope === null ? proposed : proposed.filter((finding) => inScope(finding.path, finding.startLine ?? finding.line, finding.line));
  const alreadyReviewed = proposed.length - inChanges.length;
  const candidates = inChanges.slice(0, MAX_SCORED_FINDINGS);

  // 5. Independent confidence scoring; keep only high-confidence findings.
  await updateCheckStep(repo, checkId, "Reviewing…", `Verifying ${candidates.length} candidate finding${candidates.length === 1 ? "" : "s"}.`);
  const patches = new Map(context.files.map((file) => [file.path, file.patch]));
  const discussedGuidance = renderDiscussedForVerifier(discussed);
  // The verifier reads the part of the diff its candidate came from.
  const verifierPrompt = (part: DiffPart) => {
    const base = `${renderPullRequest(context, part)}\n\n## Rules files\n\n${renderRulesFiles(context, part.paths)}${hasSpec ? `\n\n## Spec\n\n${spec}` : ""}\n\n${FALSE_POSITIVES}\n\n${CONFIDENCE_RUBRIC}`;
    return discussedGuidance ? `${base}\n\n${discussedGuidance}` : base;
  };
  const withSuggestions = candidates.map(({ part, ...finding }) => ({ part, ...withReplacedLines(finding, patches.get(finding.path) ?? null) }));
  const scores = await Promise.all(
    withSuggestions.map(({ part, finding, replacedLines }) =>
      ask(
        ctx,
        "verifier",
        Score,
        `${verifierPrompt(part)}\n\n## Candidate finding (from the ${finding.reviewer} reviewer)\n\n${JSON.stringify({ ...finding, replacedLines }, null, 2)}`,
      ),
    ),
  );
  const unverified = withSuggestions.filter((_, index) => scores[index] === undefined);
  // Later rounds keep finding thinner edge cases; raise the bar once a pull request has had its reviews.
  const minScore = previous.count >= LATE_ROUND ? Math.max(MIN_SCORE, LATE_MIN_SCORE) : MIN_SCORE;
  const verified = withSuggestions
    .map(({ finding }, index) => ({ finding: { ...finding, score: scores[index]?.score ?? 0 } as ScoredFinding, suggestionOk: scores[index]?.suggestionOk === true }))
    .filter(({ finding }) => finding.score >= minScore);
  const dropped = candidates.length - verified.length - unverified.length;

  // 6. Recheck eligibility, then post one review and settle the check.
  const beforeCleanup = await publishBlocker(repo, context, checkId, force);
  if (beforeCleanup) return { posted: false, reason: beforeCleanup };
  const resolved = new Set(await tidyEarlierReviewsStep(repo, context.number, [...fixed]));
  const stillOpen = open.filter((finding) => !resolved.has(finding.threadId));
  // Answered findings count as already raised, resolved or not, so the merge drops repeats of them.
  const raised = [...stillOpen, ...discussed.filter((finding) => finding.resolved || resolved.has(finding.threadId))];
  const merged = await merge(ctx, verified, raised);
  // Post the strongest few as threads; the rest are listed, collapsed, in the summary.
  const ranked = [...merged].sort((a, b) => b.finding.score - a.finding.score);
  const kept = ranked.slice(0, MAX_POSTED_FINDINGS);
  const beforePublish = await publishBlocker(repo, context, checkId, force);
  if (beforePublish) return { posted: false, reason: beforePublish };
  const report: ReviewReport = {
    summary: triage.summary,
    findings: kept.map((entry) => entry.finding),
    stillOpen,
    fixed: open.filter((finding) => resolved.has(finding.threadId)),
    ranReviewers,
    failedReviewers,
    unverified: unverified.length,
    parts: parts.length,
    omitted: split.omitted,
    dropped,
    alreadyReviewed,
    heldBack: ranked.slice(MAX_POSTED_FINDINGS).map((entry) => entry.finding),
    minScore,
    rereview: previousHead !== null || earlier.length > 0,
  };
  const posted = await publishReviewStep(context, report, kept.map((entry) => entry.suggestionOk));

  const conclusion: CheckConclusion = isIncomplete(report) || report.omitted.length > 0 || report.findings.length > 0 || report.stillOpen.length > 0 ? "neutral" : "success";
  await finishCheckStep(repo, checkId, conclusion, {
    title: checkTitle(report),
    summary: checkSummary(report, posted.url),
  });
  return {
    posted: true,
    complete: !isIncomplete(report),
    url: posted.url,
    findings: report.findings.length,
    inlineComments: posted.inlineComments,
    resolvedEarlier: report.fixed.length,
    stillOpen: report.stillOpen.length,
    filtered: dropped,
    alreadyReviewed,
    heldBack: report.heldBack.length,
    failedReviewers,
  };
}

interface ReviewScope {
  /** The changes since pipkin's last complete review, on a follow-up. */
  readonly scoped: { files: readonly { path: string; patch: string | null }[] } | null;
  readonly discussed: readonly EarlierFinding[];
  readonly spec: string;
  readonly hasSpec: boolean;
}

/**
 * Runs every review pass over each part of the diff. Parts go one at a time so
 * a large pull request does not spend the model plan's rate limit all at once;
 * the passes within a part run in parallel. findings is undefined for a pass that failed.
 */
async function reviewParts(
  ctx: WorkflowToolContext,
  repo: Repo,
  checkId: number | null,
  context: PullRequestContext,
  parts: readonly DiffPart[],
  { scoped, discussed, spec, hasSpec }: ReviewScope,
) {
  const runs: { reviewer: Reviewer; part: DiffPart; findings: Finding[] | undefined }[] = [];
  for (const [index, part] of parts.entries()) {
    const progress = parts.length > 1 ? ` (part ${index + 1} of ${parts.length})` : "";
    await updateCheckStep(repo, checkId, "Reviewing…", `Running the review passes${progress}.`);
    const extra = await loadExtrasStep(context, part.paths);
    const changes = scoped === null ? null : renderPatches(scoped.files.filter((file) => part.paths.includes(file.path))).slice(0, MAX_PART_CHARS);
    const scope = renderFollowUpScope(changes, discussed);
    const shared = `${renderPullRequest(context, part)}\n\n${FALSE_POSITIVES}\n\n${FINDING_INSTRUCTIONS}${scope ? `\n\n${scope}` : ""}`;
    const prompts: Partial<Record<Reviewer, string>> = {
      rules: `${shared}\n\n## Rules files\n\n${renderRulesFiles(context, part.paths)}\n\n## ${SMELL_BASELINE}`,
      bugs: shared,
      history: `${shared}\n\n## Git history\n\n${extra.history || "(no history available)"}`,
      precedent: extra.precedent ? `${shared}\n\n## Review comments on earlier pull requests touching these files\n\n${extra.precedent}` : undefined,
      comments: `${shared}\n\n## Post-change file contents\n\n${extra.files}`,
      spec: hasSpec ? `${shared}\n\n## Spec\n\n${spec}` : undefined,
    };
    const ran = (Object.keys(prompts) as Reviewer[]).filter((reviewer) => prompts[reviewer] !== undefined);
    const results = await Promise.all(ran.map((reviewer) => ask(ctx, reviewer, Findings, prompts[reviewer] as string)));
    ran.forEach((reviewer, index) => runs.push({ reviewer, part, findings: results[index]?.findings }));
  }
  return runs;
}

/** Stops cleanup or publication if the reviewed head is no longer eligible. */
async function publishBlocker(repo: Repo, context: PullRequestContext, checkId: number | null, force: boolean) {
  const latest = await loadPullRequestStep(repo, context.number);
  if (latest.headSha !== context.headSha) {
    await finishCheckStep(repo, checkId, "cancelled", { title: "Superseded", summary: "A newer commit was pushed during the review." });
    return "a newer commit was pushed during the review";
  }
  if (!force && (latest.state !== "open" || latest.draft)) {
    await finishCheckStep(repo, checkId, "cancelled", { title: "Cancelled", summary: "The pull request was closed or moved to draft during the review." });
    return "pull request closed or moved to draft during the review";
  }
  return null;
}

function checkSummary(report: ReviewReport, reviewUrl: string) {
  const lines = [`**${headline(report)}.** [Read the review](${reviewUrl}).`, "", report.summary.trim()];
  if (report.fixed.length > 0) lines.push("", `Resolved ${report.fixed.length} earlier finding${report.fixed.length === 1 ? "" : "s"} this push fixed.`);
  if (isIncomplete(report)) lines.push("", "This review is incomplete. pipkin will try again on the next push.");
  else if (report.omitted.length > 0) lines.push("", "Some files were too large to review in full; the review lists them.");
  lines.push("", "pipkin never fails this check for findings; it reports them for a person to judge.");
  return lines.join("\n");
}

/** What a finding's suggestion would replace, so the verifier can judge it. Oversized or unanchorable suggestions are dropped. */
function withReplacedLines(finding: Finding & { reviewer: Reviewer }, patch: string | null) {
  if (finding.suggestion === null) return { finding, replacedLines: null };
  const start = finding.startLine ?? finding.line;
  const replacedLines = start <= finding.line && finding.line - start < MAX_SUGGESTION_LINES ? newSideText(patch, start, finding.line) : null;
  if (replacedLines === null || finding.suggestion.split("\n").length > MAX_SUGGESTION_LINES) return { finding: { ...finding, suggestion: null }, replacedLines: null };
  return { finding, replacedLines };
}

/** Which of pipkin's open earlier findings this head commit fixed. */
async function followUp(ctx: WorkflowToolContext, context: PullRequestContext, changes: string | null, open: readonly EarlierFinding[]) {
  const fixed = new Set<string>();
  // The current diff of just the files the findings are on. A finding on a file
  // that does not fit stays open: it cannot be judged fixed without its code.
  const { parts, omitted } = splitDiff(context.files.filter((file) => open.some((finding) => finding.path === file.path)), MAX_PART_CHARS, 1);
  const onFiles = parts[0] ?? null;
  const judged = open.filter((finding) => !omitted.includes(finding.path));
  if (judged.length === 0) return fixed;
  const result = await ask(
    ctx,
    "followup",
    FollowUp,
    renderFollowUp(context, judged, changes, onFiles),
  );
  if (!result) throw new Error("follow-up pass did not return a result");
  for (const entry of result.results) {
    const finding = judged[entry.index];
    if (finding && entry.fixed) fixed.add(finding.threadId);
  }
  return fixed;
}

const TRANSIENT = /overloaded|rate.?limit|timed? ?out|temporar|unavailable|ECONNRESET|socket hang up|\b(?:429|5\d\d)\b/i;
const ATTEMPTS = 3;

/** One structured turn with a subagent, retried with durable backoff when the model provider fails transiently. */
async function ask<T>(ctx: WorkflowToolContext, agent: string, schema: z.ZodType<T>, message: string): Promise<T | undefined> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const response = await ctx.agent(agent).send(message, { outputSchema: schema, signal: ctx.abortSignal });
    const result = await response.result();
    if (result.status !== "failed") return result.data as T | undefined;
    if (attempt === ATTEMPTS || !TRANSIENT.test(result.error?.message ?? "")) return undefined;
    await sleep(attempt * 20_000);
  }
  return undefined;
}

// Order findings bugs first, so when the merge step treats two as equal the
// most specific axis wins. Exact repeats from one reviewer are dropped here.
const PRIORITY: readonly Reviewer[] = ["bugs", "history", "comments", "spec", "rules", "precedent"];

function dedupe<T extends Finding & { reviewer: Reviewer }>(findings: T[]) {
  const seen = new Set<string>();
  return [...findings]
    .sort((a, b) => PRIORITY.indexOf(a.reviewer) - PRIORITY.indexOf(b.reviewer))
    .filter((finding) => {
      const key = `${finding.reviewer}:${finding.path}:${finding.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

interface Verified {
  readonly finding: ScoredFinding;
  readonly suggestionOk: boolean;
}

/**
 * Collapses findings from different reviewers that describe the same problem,
 * and drops new findings that repeat one already raised in an earlier review:
 * still open, or answered by a person. If the merge step fails, everything is
 * kept rather than silently lost.
 */
async function merge(ctx: WorkflowToolContext, findings: Verified[], earlier: readonly EarlierFinding[]) {
  if (findings.length === 0 || (findings.length < 2 && earlier.length === 0)) return findings;
  const entries = [
    ...earlier.map((finding) => renderEarlierFinding(finding, "[earlier] ")),
    ...findings.map(({ finding }) => `[${finding.reviewer}] ${finding.path}:${finding.line} ${finding.title}\n   ${finding.body}`),
  ];
  const result = await ask(ctx, "merge", Groups, `Findings:\n\n${entries.map((entry, index) => `${index}. ${entry}`).join("\n")}`);
  if (!result) return findings;
  const offset = earlier.length;
  const keep = new Set<number>();
  const covered = new Set<number>();
  for (const group of result.groups) {
    const members = group.members.filter((index) => index >= 0 && index < entries.length && !covered.has(index));
    if (members.length === 0) continue;
    for (const index of members) covered.add(index);
    // A group containing an earlier finding is already on the pull request.
    if (members.some((index) => index < offset)) continue;
    keep.add(members.includes(group.keep) ? group.keep : Math.min(...members));
  }
  findings.forEach((_, index) => covered.has(index + offset) || keep.add(index + offset));
  return findings.filter((_, index) => keep.has(index + offset));
}
