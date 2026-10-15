import type { PullRequestContext } from "./context";
import { botLogin, gh, ghAll, repoPath, type Repo } from "./github";
import { inlineBody, REVIEW_MARKER, type ScoredFinding } from "./summary";

export { REVIEW_MARKER, type ScoredFinding };

/**
 * Lines on the new side of the diff that GitHub accepts inline comments on,
 * mapped to the hunk they belong to. A multi-line comment must stay in one hunk.
 */
function commentableLines(patch: string | null) {
  const hunks = new Map<number, number>();
  if (!patch) return hunks;
  let line = 0;
  let hunk = -1;
  for (const row of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      line = Number(header[1]);
      hunk++;
      continue;
    }
    if (row.startsWith("-")) continue;
    if (row.startsWith("+") || row.startsWith(" ")) hunks.set(line++, hunk);
  }
  return hunks;
}

/** Posts one pull request review: inline comments where GitHub allows them, everything in the summary. */
export async function publishReview(
  context: PullRequestContext,
  body: string,
  findings: readonly ScoredFinding[],
  complete: boolean,
) {
  const hunksByPath = new Map(context.files.map((file) => [file.path, commentableLines(file.patch)]));
  const comments = findings
    .filter((finding) => hunksByPath.get(finding.path)?.has(finding.line))
    .map((finding) => {
      const hunks = hunksByPath.get(finding.path);
      const multiLine =
        finding.startLine !== null &&
        finding.startLine < finding.line &&
        hunks?.get(finding.startLine) === hunks?.get(finding.line);
      return {
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        ...(multiLine ? { start_line: finding.startLine, start_side: "RIGHT" } : {}),
        body: inlineBody(finding),
      };
    });
  const marked = complete ? `${body}\n\n${REVIEW_MARKER} head=${context.headSha} -->` : body;
  const review = await gh<{ html_url: string }>(context.repo, "POST", `${repoPath(context.repo)}/pulls/${context.number}/reviews`, {
    commit_id: context.headSha,
    event: "COMMENT",
    body: marked,
    comments,
  });
  return { url: review.html_url, inlineComments: comments.length };
}

/** True when pipkin itself already posted a complete review for this head commit. */
export async function alreadyReviewed(repo: Repo, number: number, headSha: string) {
  const login = botLogin().toLowerCase();
  const reviews = await ghAll<{ body: string | null; user: { login: string } | null }>(
    repo,
    `${repoPath(repo)}/pulls/${number}/reviews`,
  );
  return reviews.some(
    (review) =>
      review.user?.login.toLowerCase() === login && review.body?.includes(`${REVIEW_MARKER} head=${headSha}`),
  );
}
