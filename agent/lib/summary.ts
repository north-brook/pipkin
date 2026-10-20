import type { PullRequestContext } from "./context";
import { AXES, type Axis, type Finding, type Reviewer } from "./schemas";

// Pure rendering of pipkin's review body, inline comments and check output.
// Safe to import from workflow bodies.

/** Marker embedded in every complete review summary, recording the head commit it covers. */
export const REVIEW_MARKER = "<!-- pipkin:review";
/** Marker embedded in every inline comment, so later reviews can recognize pipkin's own findings. */
export const FINDING_MARKER = "<!-- pipkin:finding";

const AXIS_ORDER: readonly Axis[] = ["Bugs", "Standards", "Spec"];

export interface ScoredFinding extends Finding {
  readonly reviewer: Reviewer;
  readonly score: number;
}

/** A finding pipkin posted in an earlier review of the same pull request. */
export interface EarlierFinding {
  readonly threadId: string;
  readonly url: string;
  readonly path: string;
  readonly line: number | null;
  readonly title: string;
  readonly body: string;
  readonly axis: Axis | null;
  readonly resolved: boolean;
  /** Replies from people in the finding's thread, oldest first. */
  readonly replies: readonly { author: string; body: string }[];
}

export interface ReviewReport {
  /** Triage's 2-3 sentence summary of the change. */
  readonly summary: string;
  /** New findings, in the order they are posted. */
  readonly findings: readonly ScoredFinding[];
  /** Earlier findings that are still unresolved. */
  readonly stillOpen: readonly EarlierFinding[];
  /** Earlier findings that this head commit fixed. */
  readonly fixed: readonly EarlierFinding[];
  readonly ranReviewers: readonly Reviewer[];
  readonly failedReviewers: readonly Reviewer[];
  readonly unverified: number;
  /** How many parts of the diff the passes reviewed; a large diff is split to fit them. */
  readonly parts: number;
  /** Changed files that did not fit, in full or in part, into the parts reviewed. */
  readonly omitted: readonly string[];
  readonly dropped: number;
  /** Candidates about lines pipkin already reviewed, left out of this follow-up. */
  readonly alreadyReviewed: number;
  /** Verified findings beyond this review's cap: listed in the summary, with no thread. */
  readonly heldBack: readonly ScoredFinding[];
  /** The confidence score a finding needed to be posted in this review. */
  readonly minScore: number;
  /** pipkin reviewed an earlier commit of this pull request. */
  readonly rereview: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : word.endsWith("s") ? "es" : "s"}`;

export function cleanTitle(title: string) {
  return title.trim().replace(/\.$/, "");
}

function fileLabel(path: string, line: number | null) {
  return `${path.split("/").pop()}${line === null ? "" : `:${line}`}`;
}

function blobLink(context: PullRequestContext, finding: Finding) {
  const start = finding.startLine ?? finding.line;
  const range = start === finding.line ? `L${start}` : `L${start}-L${finding.line}`;
  return `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${context.headSha}/${finding.path}#${range}`;
}

/**
 * A pass failed or a candidate went unverified, so a retry could find more. Files
 * too large to review are not retried: they would be just as large next time.
 */
export function isIncomplete(report: ReviewReport) {
  return report.failedReviewers.length > 0 || report.unverified > 0;
}

export function headline(report: ReviewReport) {
  const count = report.findings.length;
  if (count === 0) return report.rereview ? "No new issues" : "No issues found";
  return `${plural(count, report.rereview ? "new issue" : "issue")} found`;
}

/** Short title for the check run, e.g. "2 issues found" or "No new issues · 1 still open". */
export function checkTitle(report: ReviewReport) {
  const parts = [headline(report)];
  if (report.stillOpen.length > 0) parts.push(`${report.stillOpen.length} still open`);
  if (isIncomplete(report)) parts.push("incomplete");
  else if (report.omitted.length > 0) parts.push(`${plural(report.omitted.length, "file")} not fully reviewed`);
  return parts.join(" · ");
}

/** The body of one inline review comment. */
export function inlineBody(finding: ScoredFinding, withSuggestion: boolean) {
  const parts = [`**${cleanTitle(finding.title)}**`, "", finding.body.trim()];
  if (withSuggestion && finding.suggestion !== null) {
    const fence = finding.suggestion.includes("```") ? "````" : "```";
    parts.push("", `${fence}suggestion`, finding.suggestion, fence);
  }
  const axis = AXES[finding.reviewer];
  parts.push("", `<sub>${[axis, finding.source].filter(Boolean).join(" · ")}</sub>`, `${FINDING_MARKER} axis=${axis} -->`);
  return parts.join("\n");
}

/** Recovers the title, axis and text of one of pipkin's inline comments. */
export function parseInlineBody(body: string): { title: string; axis: Axis | null; text: string } {
  const title = /^\*\*(.+?)\*\*/.exec(body.trim())?.[1] ?? body.trim().split("\n")[0];
  const axisName = /pipkin:finding axis=(\w+)/.exec(body)?.[1] ?? /<sub>(Bugs|Standards|Spec)\b/.exec(body)?.[1];
  const axis = AXIS_ORDER.find((candidate) => candidate === axisName) ?? null;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<sub>[\s\S]*?<\/sub>/g, "")
    .replace(/^\s*\*\*.+?\*\*/, "")
    .replace(/(`{3,})suggestion\n[\s\S]*?\n\1/g, "")
    .trim();
  return { title: cleanTitle(title), axis, text };
}

/**
 * The review summary. `links[i]` is the inline comment for `report.findings[i]`;
 * findings without one are shown in full here, since they have no thread.
 */
export function renderReview(context: PullRequestContext, report: ReviewReport, links: readonly (string | undefined)[], botName: string) {
  const lines = [`### ${headline(report)}`, ""];
  if (report.failedReviewers.length > 0) {
    lines.push(`> [!NOTE]`, `> Incomplete review: the ${report.failedReviewers.join(", ")} pass${report.failedReviewers.length === 1 ? "" : "es"} failed. pipkin will try again on the next push.`, "");
  }
  lines.push(report.summary.trim(), "");

  for (const axis of AXIS_ORDER) {
    const entries = report.findings.map((finding, index) => ({ finding, link: links[index] })).filter(({ finding }) => AXES[finding.reviewer] === axis);
    if (entries.length === 0) continue;
    lines.push(`**${axis}**`, "");
    for (const { finding, link } of entries) {
      const where = `[\`${fileLabel(finding.path, finding.line)}\`](${blobLink(context, finding)})`;
      const title = cleanTitle(finding.title);
      lines.push(link ? `- [${title}](${link}) · ${where}` : `- **${title}** · ${where}`);
      if (!link) lines.push("", ...finding.body.trim().split("\n").map((row) => `  ${row}`), "");
    }
    lines.push("");
  }

  if (report.heldBack.length > 0) {
    lines.push(`<details>`, `<summary>Lower-scored findings, not posted as threads (${report.heldBack.length})</summary>`, "");
    for (const finding of report.heldBack) lines.push(`- **${cleanTitle(finding.title)}** · [\`${fileLabel(finding.path, finding.line)}\`](${blobLink(context, finding)})`);
    lines.push("", `</details>`, "");
  }

  if (report.stillOpen.length > 0) {
    lines.push(`<details>`, `<summary>Still open from earlier reviews (${report.stillOpen.length})</summary>`, "");
    for (const finding of report.stillOpen) lines.push(`- [${finding.title}](${finding.url}) · \`${fileLabel(finding.path, finding.line)}\``);
    lines.push("", `</details>`, "");
  }

  const details: string[] = [];
  const passes = report.ranReviewers.length > 0 ? `: ${report.ranReviewers.join(", ")}` : "";
  if (report.ranReviewers.length === 0 && report.failedReviewers.length === 0) {
    const reason = context.files.length === 0 ? "This pull request only changes lock or generated files" : "None of this pull request's changes since pipkin's last review need a new pass";
    details.push(`${reason}, so no review passes ran on \`${context.headSha.slice(0, 7)}\`.`);
  } else {
    const split = report.parts > 1 ? `, in ${report.parts} parts of the diff` : "";
    details.push(`Reviewed \`${context.headSha.slice(0, 7)}\` with ${plural(report.ranReviewers.length, "pass")}${passes}${split}.`);
  }
  if (report.fixed.length > 0) details.push(`Resolved ${plural(report.fixed.length, "earlier finding")} that this push fixed.`);
  if (report.ranReviewers.length > 0 && !report.ranReviewers.includes("spec") && !report.failedReviewers.includes("spec")) {
    details.push("Skipped the spec pass: no description or linked issue to check against.");
  }
  if (report.alreadyReviewed > 0) details.push(`Left out ${plural(report.alreadyReviewed, "candidate")} about lines an earlier review already covered.`);
  if (report.dropped > 0) details.push(`Filtered out ${plural(report.dropped, "candidate")} scoring under ${report.minScore}.`);
  if (report.unverified > 0) details.push(`Held back ${plural(report.unverified, "candidate")} that could not be verified.`);
  if (context.skippedFiles.length > 0) details.push(`Left out ${plural(context.skippedFiles.length, "lock or generated file")}.`);
  if (report.omitted.length > 0) {
    details.push(
      `Could not review all of ${plural(report.omitted.length, "file")}, too large for the review; they are listed below. Mark generated files \`linguist-generated\` in \`.gitattributes\` and pipkin leaves them out.`,
    );
  }
  lines.push(`<details>`, `<summary>Review details</summary>`, "", ...details.map((detail) => `- ${detail}`), "", `</details>`, "");
  if (report.omitted.length > 0) {
    lines.push(`<details>`, `<summary>Not fully reviewed (${report.omitted.length})</summary>`, "", ...report.omitted.map((path) => `- \`${path}\``), "", `</details>`, "");
  }

  lines.push(`<sub>Reply with \`@${botName}\` to ask about a finding, or comment \`@${botName} review\` to run the review again.</sub>`);
  return lines.join("\n").trimEnd();
}
