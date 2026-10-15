// pipkin's names on GitHub. Pure; safe to import anywhere.

/** The `@name` pipkin answers to in comments. */
export function botName() {
  return process.env.PIPKIN_BOT_NAME ?? process.env.GITHUB_APP_SLUG ?? "pipkin";
}

/** The GitHub App slug, which is also the app's GraphQL login, e.g. "pipkin". */
export function botSlug() {
  return process.env.GITHUB_APP_SLUG ?? "pipkin";
}
