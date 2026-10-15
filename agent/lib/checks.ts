import { gh, repoPath, type Repo } from "./github";
import { CHECK_EXTERNAL_ID, CHECK_NAME } from "./identity";

// The "pipkin" check run on a pull request's head commit. It shows progress
// while a review runs, and its conclusion is never "failure" for findings:
// pipkin informs, it does not gate merges.

export interface CheckOutput {
  readonly title: string;
  readonly summary: string;
  readonly text?: string;
}

export type CheckConclusion = "success" | "neutral" | "skipped" | "cancelled" | "failure";

const MAX_SUMMARY = 65_000;

function clip(output: CheckOutput): CheckOutput {
  return { ...output, summary: output.summary.slice(0, MAX_SUMMARY), text: output.text?.slice(0, MAX_SUMMARY) };
}

export async function startCheck(repo: Repo, headSha: string, detailsUrl: string, title: string, summary: string) {
  const check = await gh<{ id: number }>(repo, "POST", `${repoPath(repo)}/check-runs`, {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    external_id: CHECK_EXTERNAL_ID,
    details_url: detailsUrl,
    started_at: new Date().toISOString(),
    output: clip({ title, summary }),
  });
  return check.id;
}

export async function updateCheck(repo: Repo, checkId: number, title: string, summary: string) {
  await gh(repo, "PATCH", `${repoPath(repo)}/check-runs/${checkId}`, { output: clip({ title, summary }) });
}

/**
 * Completes the check. Findings are not added as annotations: they are already
 * inline review comments, and annotations would show each one twice in the diff.
 */
export async function finishCheck(repo: Repo, checkId: number, conclusion: CheckConclusion, output: CheckOutput) {
  await gh(repo, "PATCH", `${repoPath(repo)}/check-runs/${checkId}`, {
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: clip(output),
  });
}
