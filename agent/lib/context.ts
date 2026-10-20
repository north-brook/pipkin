import { matchesGlob } from "node:path";
import { gh, ghAll, readFileAt, repoPath, type Repo } from "./github";

// Everything the reviewers see is gathered here, up front, so each reviewer is
// a pure prompt-in / findings-out call that needs no sandbox or GitHub access.

// Lock files, build output and generated code are left out of every review. A
// repository can mark more with linguist-generated or linguist-vendored in its
// root .gitattributes.
const SKIPPED_FILES = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|go\.sum|go\.work\.sum|Package\.resolved|\.terraform\.lock\.hcl)$/,
  /\.(lock|lockb)$/,
  /\.(min\.js|min\.css|map|snap)$/,
  /(\.generated\.[\w.]+|\.g\.dart|\.pb\.go|_pb2(_grpc)?\.pyi?)$/,
  /(^|\/)(dist|build|vendor|node_modules|__generated__)\//,
];
const SKIPPED_ATTRIBUTES = ["linguist-generated", "linguist-vendored"];

const RULES_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];
const ROOT_STANDARDS_FILES = [
  "CONTRIBUTING.md",
  "CODING_STANDARDS.md",
  "STYLEGUIDE.md",
  "docs/CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
];

const MAX_FILE_CHARS = 40_000;
const MAX_FILES_WITH_CONTENT = 25;
const MAX_TOTAL_FILE_CHARS = 200_000;

export interface ChangedFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
  readonly previousPath: string | null;
}

export interface RulesFile {
  readonly path: string;
  /** The directory whose files the rules govern; null for repository-wide documents. */
  readonly scope: string | null;
  readonly url: string;
  readonly content: string;
}

export interface LinkedIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

export interface PullRequestContext {
  readonly repo: Repo;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly url: string;
  readonly state: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly commits: readonly string[];
  readonly files: readonly ChangedFile[];
  readonly skippedFiles: readonly string[];
  readonly rulesFiles: readonly RulesFile[];
  readonly linkedIssues: readonly LinkedIssue[];
}

interface PullResponse {
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  state: string;
  draft: boolean;
  head: { sha: string };
  base: { sha: string; ref: string };
}

interface FileResponse {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/** A pull request's current head and state, in one request: enough to tell whether a running review is still worth finishing. */
export async function loadPullRequestStatus(repo: Repo, number: number) {
  const pull = await gh<PullResponse>(repo, "GET", `${repoPath(repo)}/pulls/${number}`);
  return { headSha: pull.head.sha, state: pull.state, draft: pull.draft };
}

export async function loadPullRequest(repo: Repo, number: number): Promise<PullRequestContext> {
  const base = `${repoPath(repo)}/pulls/${number}`;
  const [pull, rawFiles, commits] = await Promise.all([
    gh<PullResponse>(repo, "GET", base),
    ghAll<FileResponse>(repo, `${base}/files`),
    ghAll<{ commit: { message: string } }>(repo, `${base}/commits`),
  ]);
  const generated = generatedPatterns(await readFileAt(repo, ".gitattributes", pull.base.sha));

  const files: ChangedFile[] = [];
  const skippedFiles: string[] = [];
  for (const file of rawFiles) {
    if (SKIPPED_FILES.some((pattern) => pattern.test(file.filename)) || generated(file.filename)) {
      skippedFiles.push(file.filename);
      continue;
    }
    files.push({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      previousPath: file.previous_filename ?? null,
    });
  }

  const commitMessages = commits.map((c) => c.commit.message);
  const [rulesFiles, linkedIssues] = await Promise.all([
    loadRulesFiles(repo, pull.base.sha, files),
    loadLinkedIssues(repo, number, [pull.body ?? "", ...commitMessages].join("\n")),
  ]);

  return {
    repo,
    number,
    title: pull.title,
    body: pull.body ?? "",
    author: pull.user.login,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    baseRef: pull.base.ref,
    commits: commitMessages,
    files,
    skippedFiles,
    rulesFiles,
    linkedIssues,
  };
}

/**
 * Whether the root .gitattributes marks a path as generated or vendored. Read at
 * the base commit, like the rules files. As in git, each attribute takes the value
 * of the last line that sets it for the path.
 */
function generatedPatterns(gitattributes: string | null) {
  const rules: { glob: string; attribute: string; skip: boolean }[] = [];
  for (const line of (gitattributes ?? "").split("\n")) {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#")) continue;
    for (const attribute of attributes) {
      const name = attribute.replace(/^-/, "").replace(/=.*$/, "");
      if (!SKIPPED_ATTRIBUTES.includes(name)) continue;
      const skip = !attribute.startsWith("-") && !/=false$/.test(attribute);
      // A pattern without a slash matches at any depth; one with a slash is relative to the root.
      const anchored = pattern.replace(/\/$/, "/**");
      const glob = anchored.includes("/") ? anchored.replace(/^\//, "") : `**/${anchored}`;
      rules.push({ glob, attribute: name, skip });
    }
  }
  return (path: string) =>
    SKIPPED_ATTRIBUTES.some((attribute) => rules.filter((rule) => rule.attribute === attribute && matchesGlob(path, rule.glob)).at(-1)?.skip ?? false);
}

/**
 * The root and every changed directory's AGENTS.md / CLAUDE.md, plus the root
 * contributing and coding-standards documents. Read at the base commit, so a
 * pull request cannot relax the rules it is reviewed against.
 */
async function loadRulesFiles(repo: Repo, ref: string, files: readonly ChangedFile[]) {
  const directories = new Set<string>([""]);
  for (const file of files) {
    const parts = file.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const candidates = [
    ...ROOT_STANDARDS_FILES,
    ...[...directories].flatMap((dir) => RULES_FILE_NAMES.map((name) => (dir ? `${dir}/${name}` : name))),
  ];
  const loaded = await Promise.all(
    candidates.map(async (path) => {
      const content = await readFileAt(repo, path, ref);
      return content === null
        ? null
        : {
            path,
            scope: RULES_FILE_NAMES.some((name) => path === name || path.endsWith(`/${name}`)) ? path.split("/").slice(0, -1).join("/") : null,
            url: `https://github.com/${repo.owner}/${repo.repo}/blob/${ref}/${path}`,
            content: content.slice(0, MAX_FILE_CHARS),
          };
    }),
  );
  return loaded.filter((file): file is RulesFile => file !== null);
}

const ISSUE_REFERENCE = /(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

async function loadLinkedIssues(repo: Repo, pullNumber: number, text: string): Promise<LinkedIssue[]> {
  const numbers = new Set<number>();
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    const [, otherRepo, number] = match;
    if (otherRepo && otherRepo.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) continue;
    const value = Number(number);
    if (value !== pullNumber) numbers.add(value);
  }
  const issues = await Promise.all(
    [...numbers].slice(0, 5).map(async (number) => {
      try {
        const issue = await gh<{ title: string; body: string | null; html_url: string }>(
          repo,
          "GET",
          `${repoPath(repo)}/issues/${number}`,
        );
        return { number, title: issue.title, body: (issue.body ?? "").slice(0, MAX_FILE_CHARS), url: issue.html_url };
      } catch {
        return null;
      }
    }),
  );
  return issues.filter((issue): issue is LinkedIssue => issue !== null);
}

/** Full post-change contents of modified files, for reviewers that read comments in context. */
export async function loadChangedFileContents(context: PullRequestContext, files: readonly ChangedFile[]) {
  const targets = files.filter((file) => file.status !== "removed").slice(0, MAX_FILES_WITH_CONTENT);
  const contents = await Promise.all(
    targets.map(async (file) => {
      const content = await readFileAt(context.repo, file.path, context.headSha);
      return content === null ? null : { path: file.path, content: content.slice(0, MAX_FILE_CHARS) };
    }),
  );
  let budget = MAX_TOTAL_FILE_CHARS;
  const kept: { path: string; content: string }[] = [];
  for (const entry of contents) {
    if (entry === null || budget <= 0) continue;
    const content = entry.content.slice(0, budget);
    budget -= content.length;
    kept.push({ path: entry.path, content });
  }
  return kept;
}

const BLAME_QUERY = `query($owner: String!, $repo: String!, $ref: String!, $path: String!) {
  repository(owner: $owner, name: $repo) {
    object(expression: $ref) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            age
            commit { abbreviatedOid committedDate messageHeadline associatedPullRequests(first: 1) { nodes { number title } } }
          }
        }
        history(path: $path, first: 8) {
          nodes { abbreviatedOid committedDate messageHeadline }
        }
      }
    }
  }
}`;

interface BlameResponse {
  data?: {
    repository: {
      object: {
        blame?: {
          ranges: {
            startingLine: number;
            endingLine: number;
            commit: {
              abbreviatedOid: string;
              committedDate: string;
              messageHeadline: string;
              associatedPullRequests: { nodes: { number: number; title: string }[] };
            };
          }[];
        };
        history?: { nodes: { abbreviatedOid: string; committedDate: string; messageHeadline: string }[] };
      } | null;
    };
  };
}

/**
 * Blame on the base revision for the lines each hunk touches, plus each file's
 * recent commit history. This is what the history reviewer reasons over.
 */
export async function loadHistory(context: PullRequestContext, files: readonly ChangedFile[]) {
  const modified = files.filter((file) => file.status === "modified" || file.status === "renamed").slice(0, 12);
  const sections = await Promise.all(
    modified.map(async (file) => {
      const path = file.previousPath ?? file.path;
      try {
        const response = await gh<BlameResponse>(context.repo, "POST", "/graphql", {
          query: BLAME_QUERY,
          variables: { owner: context.repo.owner, repo: context.repo.repo, ref: context.baseSha, path },
        });
        const object = response.data?.repository.object;
        if (!object) return null;
        const touched = touchedBaseLines(file.patch);
        const ranges = (object.blame?.ranges ?? []).filter((range) =>
          touched.some(([start, end]) => range.startingLine <= end && range.endingLine >= start),
        );
        const seen = new Set<string>();
        const blameLines = ranges
          .filter((range) => !seen.has(range.commit.abbreviatedOid) && seen.add(range.commit.abbreviatedOid))
          .slice(0, 15)
          .map((range) => {
            const pr = range.commit.associatedPullRequests.nodes[0];
            return `  L${range.startingLine}-${range.endingLine} ${range.commit.abbreviatedOid} ${range.commit.committedDate.slice(0, 10)} ${range.commit.messageHeadline}${pr ? ` (#${pr.number})` : ""}`;
          });
        const history = (object.history?.nodes ?? []).map(
          (commit) => `  ${commit.abbreviatedOid} ${commit.committedDate.slice(0, 10)} ${commit.messageHeadline}`,
        );
        return `### ${path}\nBlame for lines this PR changes:\n${blameLines.join("\n") || "  (none)"}\nRecent commits:\n${history.join("\n") || "  (none)"}`;
      } catch {
        return null;
      }
    }),
  );
  return sections.filter(Boolean).join("\n\n");
}

/** Base-side line ranges ("-" side) touched by each hunk of a unified diff. */
function touchedBaseLines(patch: string | null): [number, number][] {
  if (!patch) return [];
  const ranges: [number, number][] = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push([start, start + Math.max(length, 1) - 1]);
  }
  return ranges;
}

/**
 * Review comments left on earlier merged PRs that touched the same files.
 * Uses the commits API to find PRs per file, which works without code search.
 */
export async function loadPrecedent(context: PullRequestContext, files: readonly ChangedFile[]) {
  const pullNumbers = new Set<number>();
  const shas = new Set<string>();
  await Promise.all(
    files.filter((file) => file.status !== "added").slice(0, 8).map(async (file) => {
      try {
        const commits = await gh<{ sha: string }[]>(
          context.repo,
          "GET",
          `${repoPath(context.repo)}/commits?path=${encodeURIComponent(file.previousPath ?? file.path)}&sha=${context.baseSha}&per_page=6`,
        );
        for (const commit of commits) shas.add(commit.sha);
      } catch {
        // History is best-effort context.
      }
    }),
  );
  await Promise.all(
    [...shas].map(async (sha) => {
      try {
        const pulls = await gh<{ number: number; merged_at: string | null }[]>(
          context.repo,
          "GET",
          `${repoPath(context.repo)}/commits/${sha}/pulls`,
        );
        for (const pull of pulls) if (pull.merged_at && pull.number !== context.number) pullNumbers.add(pull.number);
      } catch {
        // Best-effort.
      }
    }),
  );

  const changedPaths = new Set(files.flatMap((file) => [file.path, file.previousPath ?? file.path]));
  const sections = await Promise.all(
    [...pullNumbers].slice(0, 8).map(async (number) => {
      try {
        const comments = await gh<{ path: string; body: string; user: { login: string; type: string }; html_url: string }[]>(
          context.repo,
          "GET",
          `${repoPath(context.repo)}/pulls/${number}/comments?per_page=100`,
        );
        const relevant = comments
          .filter((comment) => comment.user.type !== "Bot" && changedPaths.has(comment.path))
          .slice(0, 10)
          .map((comment) => `  - ${comment.path} (@${comment.user.login}, ${comment.html_url}): ${comment.body.slice(0, 600).replace(/\s+/g, " ")}`);
        return relevant.length ? `### PR #${number}\n${relevant.join("\n")}` : null;
      } catch {
        return null;
      }
    }),
  );
  return sections.filter(Boolean).join("\n\n");
}
