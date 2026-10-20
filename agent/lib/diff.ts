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
 * pipkin's last review. A deletion counts at the new-side line where it was made,
 * so a removed guard puts the lines around it in scope. A file missing from those
 * changes was already reviewed; one whose patch GitHub omitted (too large or
 * binary) counts as changed throughout.
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
      else if (row.startsWith("-")) lines.push(line);
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

/** Patches as one combined diff, for prompts. */
export function renderPatches(files: readonly { path: string; patch: string | null }[]) {
  return files.map((file) => `diff --git a/${file.path} b/${file.path}\n${file.patch ?? "(binary or too large to display)"}`).join("\n");
}

/** A slice of a pull request's diff small enough for one review pass. */
export interface DiffPart {
  readonly index: number;
  readonly count: number;
  /** Files with at least one hunk in this part. */
  readonly paths: readonly string[];
  readonly diff: string;
  /** Some of the diff fit in no part. */
  readonly partial: boolean;
}

/**
 * Splits a diff into at most maxParts parts of at most maxChars each. Files are
 * packed first-fit in order, so one that does not fit never stops the rest. A
 * file too large for one part is split between hunks, and a hunk too large for
 * one part is cut. Every file with something left out is listed in omitted.
 */
export function splitDiff(
  files: readonly { path: string; patch: string | null; previousPath?: string | null }[],
  maxChars: number,
  maxParts: number,
) {
  const packed: { paths: string[]; diff: string }[] = [];
  const omitted = new Set<string>();
  for (const file of files) {
    const header = `diff --git a/${file.previousPath ?? file.path} b/${file.path}\n`;
    for (const piece of pieces(file.patch ?? "(binary or too large to display)", maxChars - header.length - 1)) {
      if (piece.cut) omitted.add(file.path);
      const section = `${header}${piece.text}\n`;
      let part = packed.find((candidate) => candidate.diff.length + section.length <= maxChars);
      if (!part && packed.length < maxParts) packed.push((part = { paths: [], diff: "" }));
      if (!part) {
        omitted.add(file.path);
        continue;
      }
      part.diff += section;
      if (!part.paths.includes(file.path)) part.paths.push(file.path);
    }
  }
  const parts: DiffPart[] = packed.map((part, index) => ({ ...part, index, count: packed.length, partial: omitted.size > 0 }));
  return { parts, omitted: [...omitted] };
}

/** A patch as runs of whole hunks of at most budget characters each; a longer hunk is cut. */
function pieces(patch: string, budget: number) {
  if (patch.length <= budget) return [{ text: patch, cut: false }];
  const result: { text: string; cut: boolean }[] = [];
  let run = "";
  for (const hunk of patch.split(/\n(?=@@ )/)) {
    if (run && run.length + 1 + hunk.length <= budget) {
      run += `\n${hunk}`;
      continue;
    }
    if (run) result.push({ text: run, cut: false });
    run = hunk;
    if (run.length > budget) {
      const end = run.lastIndexOf("\n", budget);
      result.push({ text: run.slice(0, end > 0 ? end : budget), cut: true });
      run = "";
    }
  }
  if (run) result.push({ text: run, cut: false });
  return result;
}
