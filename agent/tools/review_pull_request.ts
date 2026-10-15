import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";
import type { Repo } from "../lib/github";
import {
  CONFIDENCE_RUBRIC,
  FALSE_POSITIVES,
  FINDING_INSTRUCTIONS,
  SMELL_BASELINE,
  renderPullRequest,
  renderRulesFiles,
  renderSpec,
} from "../lib/prompts";
import { type Finding, Findings, Groups, type Reviewer, Score, Triage } from "../lib/schemas";
import { alreadyReviewedStep, loadExtrasStep, loadPullRequestStep, publishReviewStep, resolveInstallationStep } from "../lib/steps";
import { renderSummary, type ScoredFinding } from "../lib/summary";

const MIN_SCORE = Number(process.env.PIPKIN_MIN_SCORE ?? 80);
const MAX_SCORED_FINDINGS = 40;

export default defineWorkflowTool({
  description:
    "Run pipkin's full multi-pass review on a pull request and post the result as one GitHub review. Use it once for each new head commit that needs a review.",
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

    // 1. Eligibility and summary.
    const context = await loadPullRequestStep(repo, input.pullRequestNumber);
    if (!input.force && (context.state !== "open" || context.draft)) return { posted: false, reason: `pull request is ${context.draft ? "a draft" : context.state}` };
    if (!input.force && (await alreadyReviewedStep(repo, context.number, context.headSha))) {
      return { posted: false, reason: "this head commit was already reviewed" };
    }
    const triage = await ask(ctx, "triage", Triage, `${renderPullRequest(context)}\n\nDecide whether to review this pull request, and summarize what it changes in 2-3 sentences.`);
    if (!triage) throw new Error("Triage did not return a result.");
    if (!input.force && !triage.review) return { posted: false, reason: triage.reason };

    // 2. Reviewer-specific context.
    const extra = await loadExtrasStep(context);
    const spec = renderSpec(context);
    const hasSpec = context.linkedIssues.length > 0 || context.body.trim().length >= 80;

    // 3. Independent reviewers, in parallel.
    const shared = `${renderPullRequest(context)}\n\n${FALSE_POSITIVES}\n\n${FINDING_INSTRUCTIONS}`;
    const prompts: Partial<Record<Reviewer, string>> = {
      rules: `${shared}\n\n## Rules files\n\n${renderRulesFiles(context)}\n\n## ${SMELL_BASELINE}`,
      bugs: shared,
      history: `${shared}\n\n## Git history\n\n${extra.history || "(no history available)"}`,
      precedent: extra.precedent ? `${shared}\n\n## Review comments on earlier pull requests touching these files\n\n${extra.precedent}` : undefined,
      comments: `${shared}\n\n## Post-change file contents\n\n${extra.files}`,
      spec: hasSpec ? `${shared}\n\n## Spec\n\n${spec}` : undefined,
    };
    const ran = (Object.keys(prompts) as Reviewer[]).filter((reviewer) => prompts[reviewer] !== undefined);
    const results = await Promise.all(ran.map((reviewer) => ask(ctx, reviewer, Findings, prompts[reviewer] as string)));
    const failedReviewers = ran.filter((_, index) => results[index] === undefined);
    // Never post an all-clear for passes that did not run; leave the head unreviewed so it is retried.
    if (failedReviewers.length === ran.length) throw new Error("Every reviewer failed; nothing was posted.");
    const candidates = dedupe(
      ran.flatMap((reviewer, index) => (results[index]?.findings ?? []).map((finding) => ({ ...finding, reviewer }))),
    ).slice(0, MAX_SCORED_FINDINGS);

    // 4. Independent confidence scoring; keep only high-confidence findings.
    const verifierBase = `${renderPullRequest(context)}\n\n## Rules files\n\n${renderRulesFiles(context)}${hasSpec ? `\n\n## Spec\n\n${spec}` : ""}\n\n${FALSE_POSITIVES}\n\n${CONFIDENCE_RUBRIC}`;
    const scores = await Promise.all(
      candidates.map((finding) =>
        ask(ctx, "verifier", Score, `${verifierBase}\n\n## Candidate finding (from the ${finding.reviewer} reviewer)\n\n${JSON.stringify(finding, null, 2)}`),
      ),
    );
    const unverified = candidates.filter((_, index) => scores[index] === undefined);
    const verified: ScoredFinding[] = candidates
      .map((finding, index) => ({ ...finding, score: scores[index]?.score ?? 0 }))
      .filter((finding) => finding.score >= MIN_SCORE);
    const kept = await merge(ctx, verified);
    const dropped = candidates.length - verified.length - unverified.length;

    // 5. Recheck eligibility, then post one review.
    const latest = await loadPullRequestStep(repo, input.pullRequestNumber);
    if (latest.headSha !== context.headSha) return { posted: false, reason: "a newer commit was pushed during the review" };
    if (!input.force && (latest.state !== "open" || latest.draft)) return { posted: false, reason: "pull request closed or moved to draft during the review" };

    const body = renderSummary({
      context,
      summary: triage.summary,
      findings: kept,
      ranReviewers: ran.filter((reviewer) => !failedReviewers.includes(reviewer)),
      failedReviewers,
      unverified: unverified.length,
      dropped,
    });
    // A partial review is posted without the head marker, so the next event retries it.
    const complete = failedReviewers.length === 0 && unverified.length === 0;
    const review = await publishReviewStep(context, body, kept, complete);
    return { posted: true, complete, url: review.url, findings: kept.length, inlineComments: review.inlineComments, filtered: dropped, failedReviewers };
  },
});

async function ask<T>(ctx: WorkflowToolContext, agent: string, schema: z.ZodType<T>, message: string): Promise<T | undefined> {
  const response = await ctx.agent(agent).send(message, { outputSchema: schema, signal: ctx.abortSignal });
  const result = await response.result();
  return result.status === "failed" ? undefined : (result.data as T | undefined);
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

/** Collapses findings from different reviewers that describe the same problem. */
async function merge(ctx: WorkflowToolContext, findings: ScoredFinding[]) {
  if (findings.length < 2) return findings;
  const list = findings
    .map((finding, index) => `${index}. [${finding.reviewer}] ${finding.path}:${finding.line} ${finding.title}\n   ${finding.body}`)
    .join("\n");
  const result = await ask(ctx, "merge", Groups, `Findings:\n\n${list}`);
  if (!result) return findings;
  const keep = new Set<number>();
  const covered = new Set<number>();
  for (const group of result.groups) {
    const members = group.members.filter((index) => index >= 0 && index < findings.length && !covered.has(index));
    if (members.length === 0) continue;
    for (const index of members) covered.add(index);
    keep.add(members.includes(group.keep) ? group.keep : Math.min(...members));
  }
  // Anything the merge step left out is kept rather than silently lost.
  findings.forEach((_, index) => covered.has(index) || keep.add(index));
  return findings.filter((_, index) => keep.has(index));
}
