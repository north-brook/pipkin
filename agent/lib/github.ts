import { createSign } from "node:crypto";
import { botSlug } from "./identity";

// Minimal GitHub App client. Credentials come from GITHUB_APP_ID and
// GITHUB_APP_PRIVATE_KEY, the same env vars eve's GitHub channel reads.

export interface Repo {
  readonly owner: string;
  readonly repo: string;
  readonly installationId: number;
}

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const tokens = new Map<number, { token: string; expiresAt: number }>();

function appJwt(): string {
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !key) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  return `${unsigned}.${signature}`;
}

export async function installationToken(installationId: number): Promise<string> {
  // Local testing without a GitHub App: use a personal token instead.
  if (process.env.PIPKIN_GITHUB_TOKEN) return process.env.PIPKIN_GITHUB_TOKEN;
  const cached = tokens.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub installation token: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { token: string; expires_at: string };
  tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

/** Finds the app's installation for a repository (used for operator-started reviews). */
export async function resolveInstallation(owner: string, repo: string): Promise<number> {
  if (process.env.PIPKIN_GITHUB_TOKEN) return 0;
  const response = await fetch(`${API}/repos/${owner}/${repo}/installation`, {
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`pipkin is not installed on ${owner}/${repo} (${response.status}).`);
  return ((await response.json()) as { id: number }).id;
}

/** The app's own REST login, e.g. "pipkin[bot]". */
export function botLogin() {
  return `${botSlug()}[bot]`;
}

export async function graphql<T>(repo: Repo, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await gh<{ data?: T; errors?: { message: string }[] }>(repo, "POST", "/graphql", { query, variables });
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${response.errors.map((error) => error.message).join("; ")}`);
  return response.data as T;
}

export async function gh<T>(
  repo: Repo,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  accept = "application/vnd.github+json",
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await installationToken(repo.installationId)}`,
      accept,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  if (response.status === 204) return undefined as T;
  // The raw media type is "application/vnd.github.raw+json" but returns file bytes, not JSON.
  return (accept.includes(".raw") ? response.text() : response.json()) as Promise<T>;
}

export function repoPath(repo: Repo) {
  return `/repos/${repo.owner}/${repo.repo}`;
}

/** Fetches every page of a list endpoint (max 3,000 items). */
export async function ghAll<T>(repo: Repo, path: string): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 30; page++) {
    const batch = await gh<T[]>(repo, "GET", `${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

export async function readFileAt(repo: Repo, path: string, ref: string): Promise<string | null> {
  try {
    return await gh<string>(
      repo,
      "GET",
      `${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      undefined,
      "application/vnd.github.raw+json",
    );
  } catch {
    return null;
  }
}
