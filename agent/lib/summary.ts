import type { PullRequestContext } from "./context";
import { AXES, type Axis, type Finding, type Reviewer } from "./schemas";

// Pure rendering of the review summary. Safe to import from workflow bodies.

/** Marker embedded in every review pipkin posts, so reruns can tell a head was already reviewed. */
export const REVIEW_MARKER = "<!-- pipkin:review";

export interface ScoredFinding extends Finding {
  readonly reviewer: Reviewer;
  readonly score: number;
}

function blobLink(context: PullRequestContext, finding: Finding) {
  const start = Math.max(1, (finding.startLine ?? finding.line) - 1);
  return `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${context.headSha}/${finding.path}#L${start}-L${finding.line + 1}`;
}

export function inlineBody(finding: ScoredFinding) {
  const source = finding.source ? `\n\n<sub>${AXES[finding.reviewer]} · ${finding.source}</sub>` : `\n\n<sub>${AXES[finding.reviewer]}</sub>`;
  return `**${finding.title}**\n\n${finding.body}${source}`;
}

export function renderSummary(input: {
  context: PullRequestContext;
  summary: string;
  findings: readonly ScoredFinding[];
  ranReviewers: readonly Reviewer[];
  failedReviewers: readonly Reviewer[];
  unverified: number;
  dropped: number;
}) {
  const { context, summary, findings, ranReviewers, failedReviewers, unverified, dropped } = input;
  const skippedSpec = !ranReviewers.includes("spec") && !failedReviewers.includes("spec");
  const axes: Axis[] = ["Bugs", "Standards", "Spec"];
  const lines = [`### pipkin review`, "", summary.trim(), ""];
  if (findings.length === 0 && failedReviewers.length === 0 && unverified === 0) {
    lines.push("No issues found. Checked for bugs, rules-file compliance, history, prior review feedback" + (ranReviewers.includes("spec") ? ", and the spec." : "."));
  } else if (findings.length === 0) {
    lines.push("No issues found in the passes that completed.");
  } else {
    lines.push(`Found ${findings.length} issue${findings.length === 1 ? "" : "s"}:`, "");
    for (const axis of axes) {
      const axisFindings = findings.filter((finding) => AXES[finding.reviewer] === axis);
      if (axisFindings.length === 0) continue;
      lines.push(`**${axis}**`, "");
      axisFindings.forEach((finding, index) => {
        lines.push(`${index + 1}. ${finding.title}${finding.source ? ` (${finding.source})` : ""}`, `   ${blobLink(context, finding)}`);
      });
      lines.push("");
    }
  }
  if (failedReviewers.length > 0) lines.push(`<sub>This review is incomplete: the ${failedReviewers.join(", ")} pass${failedReviewers.length === 1 ? "" : "es"} failed. pipkin will retry on the next push, or mention it to re-run.</sub>`);
  if (unverified > 0) lines.push(`<sub>${unverified} candidate${unverified === 1 ? " was" : "s were"} not posted because verification failed.</sub>`);
  if (skippedSpec) lines.push("<sub>No spec found in the description or linked issues, so the Spec axis was skipped.</sub>");
  if (dropped > 0) lines.push(`<sub>${dropped} lower-confidence candidate${dropped === 1 ? " was" : "s were"} filtered out.</sub>`);
  if (context.truncated) lines.push("<sub>The diff was too large to review in full; later files were not reviewed.</sub>");
  return lines.join("\n").trimEnd();
}

