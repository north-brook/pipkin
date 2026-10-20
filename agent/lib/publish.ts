import type { PullRequestContext } from "./context";
import { inlineAnchor, renderPatches } from "./diff";
import { botLogin, gh, ghAll, graphql, repoPath, type Repo } from "./github";
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
          comments(first: 30) { nodes { url body state author { login __typename } } }
        }
      }
    }
  }
}`;

const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 100) { nodes { id body isMinimized author { login __typename } } }
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
          comments: { nodes: { url: string; body: string; state: string; author: { login: string; __typename: string } | null }[] };
        }[];
      };
    };
  };
}

interface ReviewsResponse {
  repository: { pullRequest: { reviews: { nodes: { id: string; body: string; isMinimized: boolean; author: { login: string; __typename: string } | null }[] } } };
}

function isPipkin(login: string | undefined, actorType: string | undefined) {
  const value = login?.toLowerCase();
  return actorType === "Bot" && (value === botSlug().toLowerCase() || value === botLogin().toLowerCase());
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
      if (!first || first.state !== "SUBMITTED" || !isPipkin(first.author?.login, first.author?.__typename)) continue;
      // Older reviews predate the finding marker; any root comment pipkin wrote is a finding.
      const parsed = parseInlineBody(first.body);
      // What people said back. Bots, pipkin included, are not a verdict on the finding.
      const replies = thread.comments.nodes
        .slice(1)
        .filter((comment) => comment.state === "SUBMITTED" && comment.author?.__typename !== "Bot" && comment.body.trim() !== "")
        .map((comment) => ({ author: comment.author?.login ?? "ghost", body: comment.body.trim() }));
      findings.push({
        threadId: thread.id,
        url: first.url,
        path: thread.path,
        line: thread.line ?? thread.originalLine,
        title: parsed.title,
        body: parsed.text,
        axis: parsed.axis,
        resolved: thread.isResolved,
        replies,
      });
    }
    if (!threads.pageInfo.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }
  return findings;
}

/**
 * The head commit of pipkin's latest complete review (null when it has not
 * reviewed this pull request), and how many complete reviews it has posted.
 */
export async function lastReviewedHead(repo: Repo, number: number) {
  const data = await graphql<ReviewsResponse>(repo, REVIEWS_QUERY, { owner: repo.owner, repo: repo.repo, number });
  const heads = data.repository.pullRequest.reviews.nodes
    .filter((review) => isPipkin(review.author?.login, review.author?.__typename))
    .map((review) => new RegExp(`${REVIEW_MARKER} head=([0-9a-f]{40})`).exec(review.body)?.[1])
    .filter((head): head is string => head !== undefined);
  return { head: heads.at(-1) ?? null, count: heads.length };
}

/** GitHub's compare endpoint lists at most this many files; a longer list may be missing some. */
const COMPARE_FILE_LIMIT = 300;

/**
 * The changes between two commits: each file's patch (null when GitHub omits it)
 * and a combined diff for prompts, cut at maxChars. Null when GitHub cannot
 * compare them, base is not an ancestor of head (a force-push rewrote what was
 * reviewed), or the file list may be incomplete.
 */
export async function compareCommits(repo: Repo, base: string, head: string, maxChars: number) {
  try {
    const comparison = await gh<{ merge_base_commit?: { sha: string }; files?: { filename: string; patch?: string }[] }>(
      repo,
      "GET",
      `${repoPath(repo)}/compare/${base}...${head}`,
    );
    // A three-dot compare diffs from the merge base, which is only "since base" when base is an ancestor.
    if (comparison.merge_base_commit?.sha !== base) return null;
    const files = (comparison.files ?? []).map((file) => ({ path: file.filename, patch: file.patch ?? null }));
    if (files.length >= COMPARE_FILE_LIMIT) return null;
    const diff = renderPatches(files);
    return { files, diff: diff.slice(0, maxChars), truncated: diff.length > maxChars };
  } catch {
    return null;
  }
}

/** Resolves the review threads of findings a newer commit fixed. Failures are skipped; the thread just stays open. */
export async function resolveThreads(repo: Repo, threadIds: readonly string[]) {
  const resolved: string[] = [];
  for (const threadId of threadIds) {
    try {
      await graphql(repo, `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId });
      resolved.push(threadId);
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
    if (review.isMinimized || !isPipkin(review.author?.login, review.author?.__typename) || review.body.trim() === "") continue;
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
  const reviews = await ghAll<{ id: number; state: string; user: { login: string; type: string } | null }>(
    repo,
    `${repoPath(repo)}/pulls/${number}/reviews`,
  );
  for (const review of reviews) {
    if (review.state === "PENDING" && isPipkin(review.user?.login, review.user?.type)) {
      await gh(repo, "DELETE", `${repoPath(repo)}/pulls/${number}/reviews/${review.id}`);
    }
  }
}
