// Pure helpers over unified diff patches. Safe to import from workflow bodies.

/**
 * Lines on the new side of the diff that GitHub accepts inline comments on,
 * mapped to the hunk they belong to and their text. A multi-line comment must
 * stay in one hunk.
 */
export function newSideLines(patch: string | null) {
  const lines = new Map<number, { hunk: number; text: string }>();
  if (!patch) return lines;
  let line = 0;
  let hunk = -1;
  for (const row of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      line = Number(header[1]);
      hunk++;
      continue;
    }
    if (row.startsWith("-") || row.startsWith("\\")) continue;
    if (row.startsWith("+") || row.startsWith(" ")) lines.set(line++, { hunk, text: row.slice(1) });
  }
  return lines;
}

/** Where a finding can be anchored inline, or null when GitHub would reject the comment. */
export function inlineAnchor(patch: string | null, line: number, startLine: number | null) {
  const lines = newSideLines(patch);
  const end = lines.get(line);
  if (!end) return null;
  const start = startLine !== null && startLine < line ? lines.get(startLine) : undefined;
  if (startLine === null || startLine >= line || !start || start.hunk !== end.hunk) return { startLine: null, line };
  return { startLine, line };
}

/** The new-side text of lines start..end, when every line is in the diff. */
export function newSideText(patch: string | null, start: number, end: number) {
  const lines = newSideLines(patch);
  const text: string[] = [];
  for (let line = start; line <= end; line++) {
    const entry = lines.get(line);
    if (!entry) return null;
    text.push(entry.text);
  }
  return text.join("\n");
}

/** How far from a changed line a finding may anchor and still count as being about that change. */
const SCOPE_SLACK = 3;

/**
 * Whether a finding on lines start..end of a file is about the changes since
 * pipkin's last review. A file missing from those changes was already reviewed;
 * one whose patch GitHub omitted (too large or binary) counts as changed throughout.
 */
export function touchedSince(files: readonly { path: string; patch: string | null }[]) {
  const added = new Map<string, number[] | null>();
  for (const file of files) {
    if (file.patch === null) {
      added.set(file.path, null);
      continue;
    }
    const lines: number[] = [];
    let line = 0;
    for (const row of file.patch.split("\n")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (header) line = Number(header[1]);
      else if (row.startsWith("+")) lines.push(line++);
      else if (row.startsWith(" ")) line++;
    }
    added.set(file.path, lines);
  }
  return (path: string, start: number, end: number) => {
    if (!added.has(path)) return false;
    const lines = added.get(path);
    return lines === null || lines === undefined || lines.some((line) => line >= start - SCOPE_SLACK && line <= end + SCOPE_SLACK);
  };
}
