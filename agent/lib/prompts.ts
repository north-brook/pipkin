import type { PullRequestContext } from "./context";
import type { EarlierFinding } from "./summary";

const MAX_REPLY_CHARS = 600;

/** One earlier finding, with what people replied to it, as a line of a numbered list. */
export function renderEarlierFinding(finding: EarlierFinding, label = "") {
  const entry = [`${label}${finding.path}:${finding.line ?? "?"} ${finding.title}`, `   ${finding.body.replace(/\n+/g, " ")}`];
  for (const reply of finding.replies) {
    const text = reply.body.replace(/\s+/g, " ");
    entry.push(`   Reply from @${reply.author}: ${text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text}`);
  }
  return entry.join("\n");
}

/** Context for checking whether a later head fixed earlier findings. */
export function renderFollowUp(context: PullRequestContext, open: readonly EarlierFinding[], changes: string | null) {
  const list = open.map((finding, index) => `${index}. ${renderEarlierFinding(finding)}`).join("\n");
  return `## Earlier findings still open\n\n${list}\n\n## Changes since pipkin's last complete review\n\n${changes === null ? "No earlier complete review or comparison is available. Judge each finding against the current pull request." : `\`\`\`diff\n${changes}\n\`\`\``}\n\n## Current pull request\n\n${renderPullRequest(context)}`;
}

// The reviewer passes, false-positive list and confidence rubric are adapted
// from Anthropic's Claude Code `code-review` plugin (Apache-2.0). The Spec axis
// and the smell baseline are adapted from Matt Pocock's `code-review` skill
// (MIT). See NOTICE.

export const FALSE_POSITIVES = `Do not report any of these (they are false positives):
- Pre-existing issues, or real issues on lines this pull request did not modify.
- Something that looks like a bug but is not actually a bug.
- Pedantic nitpicks that a senior engineer would not call out.
- Anything a linter, typechecker, compiler or test suite would catch (missing or wrong imports, type errors, broken tests, formatting, newline style). Assume CI runs those separately.
- General quality concerns (test coverage, generic security hardening, documentation) unless a rules file explicitly requires them.
- Issues a rules file calls out but the code explicitly silences (for example with a lint-ignore comment).
- Changes in behaviour that are clearly intentional or directly part of the broader change.`;

export const CONFIDENCE_RUBRIC = `Score how confident you are that the issue is real, from 0 to 100:
- 0: Not confident at all. A false positive that does not stand up to light scrutiny, or a pre-existing issue.
- 25: Somewhat confident. It might be real but you could not verify it. If it is stylistic, no rules file explicitly calls it out.
- 50: Moderately confident. You verified it is real, but it is a nitpick or will rarely happen in practice. Relative to the rest of the pull request it is not very important.
- 75: Highly confident. You double-checked and it is very likely real and will be hit in practice; the existing approach is insufficient. It directly impacts functionality.
- 100: Certain. You double-checked and confirmed it is definitely real and will happen frequently. The evidence directly confirms it.
A finding that quotes a rule from a rules file, where you confirmed the rule exists, applies to the changed lines, and is clearly broken, is certain: score it 90 or higher.
A spec finding that quotes a requirement you confirmed in the spec, which the diff clearly misses or contradicts, is certain: score it 90 or higher.`;

export const SMELL_BASELINE = `Smell baseline (Fowler, Refactoring ch. 3). Each is a judgement call, never a hard violation, and a documented repo standard always overrides it:
- Mysterious Name: a name that does not reveal what it does or holds. Fix: rename it.
- Duplicated Code: the same logic shape in more than one hunk or file of the change. Fix: extract the shared shape.
- Feature Envy: a method that reaches into another object's data more than its own. Fix: move it onto that data.
- Data Clumps: the same few fields or params keep travelling together. Fix: bundle them into one type.
- Primitive Obsession: a primitive standing in for a domain concept. Fix: give the concept its own small type.
- Repeated Switches: the same switch/if-cascade on the same type recurs. Fix: polymorphism or one shared map.
- Shotgun Surgery: one logical change forces scattered edits across many files. Fix: gather what changes together.
- Divergent Change: one module edited for several unrelated reasons. Fix: split it.
- Speculative Generality: abstraction or hooks for needs the spec does not have. Fix: inline it back.
- Message Chains: long a.b().c().d() navigation. Fix: hide the walk behind one method.
- Middle Man: a class or function that mostly delegates onward. Fix: call the real target directly.
- Refused Bequest: a subclass that ignores most of what it inherits. Fix: use composition.`;

export const FINDING_INSTRUCTIONS = `Report each issue as one finding with:
- path: the file path exactly as it appears in the diff.
- line: a line number on the new (right-hand) side of the diff that the issue is about. It must be an added or context line inside a hunk of this diff.
- startLine: optional, for a multi-line range ending at line.
- title: one short sentence naming the problem, with no priority or severity tags.
- body: why it is a problem and what to do instead, in at most 4 sentences. Quote the specific code. If a rules file or spec motivates it, quote the exact rule or requirement.
- source: when the finding quotes a rule or requirement, where it comes from: the rules file path (for example AGENTS.md), "PR description", or "issue #N". Otherwise null. Never put code locations here.
- suggestion: the exact replacement text for lines startLine..line (or just line), only when the fix is small, self-contained and you are certain of it. Give the complete new text of those lines with their original indentation, and nothing else. Use null when you are unsure or the fix reaches beyond those lines.
Return an empty list when you find nothing worth reporting. Finding nothing is a normal, good outcome.`;

/**
 * What a review leaves alone: on a follow-up, lines pipkin already reviewed;
 * always, findings people have already answered. Empty when neither applies.
 */
export function renderFollowUpScope(changes: string | null, discussed: readonly EarlierFinding[]) {
  const parts: string[] = [];
  if (changes !== null) {
    parts.push(`## This is a follow-up review

pipkin already reviewed an earlier commit of this pull request. Report only problems in the changes since that review, shown below. Use the full diff above for context, but do not report anything about lines these changes did not touch: they were already reviewed.

\`\`\`diff
${changes}
\`\`\``);
  }
  if (discussed.length > 0) {
    parts.push(`## Findings already discussed on this pull request

Someone has replied to each of these. Do not report them again, or a variation of the same concern, whether the reply says it was fixed or that it is not a problem.

${discussed.map((finding) => `- ${renderEarlierFinding(finding)}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Verifier guidance for findings people already answered. Empty when there are none. */
export function renderDiscussedForVerifier(discussed: readonly EarlierFinding[]) {
  if (discussed.length === 0) return "";
  return `${renderFollowUpScope(null, discussed)}\n\nScore a candidate that repeats one of these, or is a narrow variation of it, at most 25.`;
}

export function renderPullRequest(context: PullRequestContext, options: { includeDiff?: boolean } = {}) {
  const parts = [
    `Repository: ${context.repo.owner}/${context.repo.repo}`,
    `Pull request #${context.number}: ${context.title}`,
    `Author: @${context.author}`,
    `Base: ${context.baseRef} (${context.baseSha.slice(0, 12)})  Head: ${context.headSha.slice(0, 12)}`,
    "",
    "Description:",
    context.body.trim() || "(empty)",
    "",
    "Commits:",
    ...context.commits.map((message) => `- ${message.split("\n")[0]}`),
    "",
    `Changed files (${context.files.length}):`,
    ...context.files.map((file) => `- ${file.path} [${file.status}] +${file.additions} -${file.deletions}`),
  ];
  if (context.skippedFiles.length) parts.push(`Skipped generated/lock files: ${context.skippedFiles.join(", ")}`);
  if (options.includeDiff !== false) {
    parts.push("", "Diff:", "```diff", context.diff, "```");
    if (context.truncated) parts.push("(The diff was truncated; review only what is shown.)");
  }
  return parts.join("\n");
}

export function renderRulesFiles(context: PullRequestContext) {
  if (context.rulesFiles.length === 0) return "No rules files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CODING_STANDARDS.md) were found.";
  return context.rulesFiles
    .map((file) => `### ${file.path}\n${file.content}`)
    .join("\n\n");
}

export function renderSpec(context: PullRequestContext) {
  const parts: string[] = [];
  if (context.body.trim()) parts.push(`### Pull request description\n${context.body.trim()}`);
  for (const issue of context.linkedIssues) {
    parts.push(`### Issue #${issue.number}: ${issue.title}\n${issue.url}\n\n${issue.body.trim() || "(empty)"}`);
  }
  return parts.join("\n\n");
}
