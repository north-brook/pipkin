import type { PullRequestContext } from "./context";
import { inlineAnchor } from "./diff";
import { botLogin, gh, graphql, repoPath, type Repo } from "./github";
import { botName, botSlug } from "./identity";
import {
  type EarlierFinding,
  inlineBody,
  isIncomplete,
  parseInlineBody,
  renderReview,
  REVIEW_MARKER,
  type ReviewReport,
} from "./summary";

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: 1) { nodes { url body author { login } } }
        }
      }
    }
  }
}`;

const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 100) { nodes { id body isMinimized author { login } } }
    }
  }
}`;

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          path: string;
          line: number | null;
          originalLine: number | null;
          comments: { nodes: { url: string; body: string; author: { login: string } | null }[] };
        }[];
      };
    };
  };
}

interface ReviewsResponse {
  repository: { pullRequest: { reviews: { nodes: { id: string; body: string; isMinimized: boolean; author: { login: string } | null }[] } } };
}

function isPipkin(login: string | undefined) {
  const value = login?.toLowerCase();
  return value === botSlug().toLowerCase() || value === botLogin().toLowerCase();
}

/** Every inline finding pipkin has posted on this pull request, resolved or not. */
export async function loadEarlierFindings(repo: Repo, number: number): Promise<EarlierFinding[]> {
  const findings: EarlierFinding[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: ThreadsResponse = await graphql<ThreadsResponse>(repo, THREADS_QUERY, { owner: repo.owner, repo: repo.repo, number, after });
    const threads = data.repository.pullRequest.reviewThreads;
    for (const thread of threads.nodes) {
      const first = thread.comments.nodes[0];
      if (!first || !isPipkin(first.author?.login)) continue;
      // Older reviews predate the finding marker; any root comment pipkin wrote is a finding.
      const parsed = parseInlineBody(first.body);
      findings.push({
        threadId: thread.id,
        url: first.url,
        path: thread.path,
        line: thread.line ?? thread.originalLine,
        title: parsed.title,
        body: parsed.text,
        axis: parsed.axis,
        resolved: thread.isResolved,
      });
    }
    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return findings;
}

/** The head commit of pipkin's latest complete review, or null when it has not reviewed this pull request. */
export async function lastReviewedHead(repo: Repo, number: number) {
  const data = await graphql<ReviewsResponse>(repo, REVIEWS_QUERY, { owner: repo.owner, repo: repo.repo, number });
  const heads = data.repository.pullRequest.reviews.nodes
    .filter((review) => isPipkin(review.author?.login))
    .map((review) => new RegExp(`${REVIEW_MARKER} head=([0-9a-f]{40})`).exec(review.body)?.[1])
    .filter((head): head is string => head !== undefined);
  return heads.at(-1) ?? null;
}

/** The diff between two commits, for the follow-up check. Null when GitHub cannot compare them (e.g. after a force-push). */
export async function compareCommits(repo: Repo, base: string, head: string, maxChars: number) {
  try {
    const comparison = await gh<{ files?: { filename: string; patch?: string }[] }>(repo, "GET", `${repoPath(repo)}/compare/${base}...${head}`);
    const diff = (comparison.files ?? []).map((file) => `diff --git a/${file.filename} b/${file.filename}\n${file.patch ?? "(binary or too large to display)"}`).join("\n");
    return diff.slice(0, maxChars);
  } catch {
    return null;
  }
}

/** Resolves the review threads of findings a newer commit fixed. Failures are skipped; the thread just stays open. */
export async function resolveThreads(repo: Repo, threadIds: readonly string[]) {
  let resolved = 0;
  for (const threadId of threadIds) {
    try {
      await graphql(repo, `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId });
      resolved++;
    } catch (error) {
      console.warn(`[pipkin] could not resolve review thread ${threadId}:`, error);
    }
  }
  return resolved;
}

/** Collapses pipkin's earlier review summaries as outdated, so only the latest one stays expanded. */
export async function minimizeEarlierReviews(repo: Repo, number: number) {
  const data = await graphql<ReviewsResponse>(repo, REVIEWS_QUERY, { owner: repo.owner, repo: repo.repo, number });
  for (const review of data.repository.pullRequest.reviews.nodes) {
    // Replies in review threads also create reviews, with an empty body; leave those alone.
    if (review.isMinimized || !isPipkin(review.author?.login) || review.body.trim() === "") continue;
    try {
      await graphql(repo, `mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }`, { id: review.id });
    } catch (error) {
      console.warn(`[pipkin] could not minimize review ${review.id}:`, error);
    }
  }
}

/**
 * Posts one pull request review: an inline comment for every finding GitHub
 * will anchor, and the summary. Returns the review URL and, for each finding,
 * the URL of its inline comment when it got one.
 */
export async function publishReview(context: PullRequestContext, report: ReviewReport, suggestionOk: readonly boolean[]) {
  const { findings } = report;
  const patches = new Map(context.files.map((file) => [file.path, file.patch]));
  const anchored = findings.map((finding) => inlineAnchor(patches.get(finding.path) ?? null, finding.line, finding.startLine));
  const comments = findings.flatMap((finding, index) => {
    const anchor = anchored[index];
    if (!anchor) return [];
    // A suggestion replaces exactly the anchored lines, so it is only safe when the anchor kept the finding's range.
    const keepsRange = (anchor.startLine ?? anchor.line) === (finding.startLine ?? finding.line);
    return [
      {
        path: finding.path,
        line: anchor.line,
        side: "RIGHT",
        ...(anchor.startLine !== null ? { start_line: anchor.startLine, start_side: "RIGHT" } : {}),
        body: inlineBody(finding, suggestionOk[index] === true && keepsRange),
      },
    ];
  });

  // GitHub only returns comment URLs after the review exists, so post it pending,
  // read the comment URLs, then submit it with a summary that links to them.
  await deletePendingReviews(context.repo, context.number);
  const pending = await gh<{ id: number }>(context.repo, "POST", `${repoPath(context.repo)}/pulls/${context.number}/reviews`, {
    commit_id: context.headSha,
    comments,
  });
  try {
    const posted = await gh<{ body: string; html_url: string }[]>(
      context.repo,
      "GET",
      `${repoPath(context.repo)}/pulls/${context.number}/reviews/${pending.id}/comments?per_page=100`,
    );
    const urlByBody = new Map(posted.map((comment) => [comment.body, comment.html_url]));
    let next = 0;
    const links = findings.map((_, index) => {
      if (!anchored[index]) return undefined;
      const position = next++;
      return urlByBody.get(comments[position].body) ?? posted[position]?.html_url;
    });
    const body = renderReview(context, report, links, botName());
    const marked = !isIncomplete(report) ? `${body}\n\n${REVIEW_MARKER} head=${context.headSha} -->` : body;
    const review = await gh<{ html_url: string }>(
      context.repo,
      "POST",
      `${repoPath(context.repo)}/pulls/${context.number}/reviews/${pending.id}/events`,
      { event: "COMMENT", body: marked },
    );
    return { url: review.html_url, inlineComments: comments.length };
  } catch (error) {
    await gh(context.repo, "DELETE", `${repoPath(context.repo)}/pulls/${context.number}/reviews/${pending.id}`).catch(() => undefined);
    throw error;
  }
}

/**
 * GitHub allows one pending review per author. One left behind by an interrupted
 * publish would block every later review, so clear pipkin's before starting.
 */
async function deletePendingReviews(repo: Repo, number: number) {
  const reviews = await gh<{ id: number; state: string; user: { login: string } | null }[]>(
    repo,
    "GET",
    `${repoPath(repo)}/pulls/${number}/reviews?per_page=100`,
  );
  for (const review of reviews) {
    if (review.state === "PENDING" && isPipkin(review.user?.login)) {
      await gh(repo, "DELETE", `${repoPath(repo)}/pulls/${number}/reviews/${review.id}`);
    }
  }
}
