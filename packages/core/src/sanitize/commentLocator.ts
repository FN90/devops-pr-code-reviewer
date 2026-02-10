import parseGitDiff, { AddedLine, AnyChunk, AnyLineChange, DeletedLine, GitDiff, UnchangedLine } from 'parse-git-diff';
import { ReviewThread } from '../llm/types';

// Adjusts threadContext line/offsets to align with provided diff. Useful when the model emits approximate positions.
export function fixThreadPositions(threads: ReviewThread[], diff: string): ReviewThread[] {
  if (!threads.length) return threads;
  const parsedDiff = parseGitDiff(diff);
  for (const thread of threads) {
    if (thread.threadContext) {
      fixThreadContextLineNumberAndOffsets(thread.threadContext as any, parsedDiff, true);
      fixThreadContextLineNumberAndOffsets(thread.threadContext as any, parsedDiff, false);
    }
  }
  return threads;
}

function fixThreadContextLineNumberAndOffsets(threadContext: any, parsedDiff: GitDiff, isRightSide: boolean): void {
  const fileStart = isRightSide ? threadContext.rightFileStart : threadContext.leftFileStart;
  const fileEnd = isRightSide ? threadContext.rightFileEnd : threadContext.leftFileEnd;

  if (fileStart?.snippet?.length) {
    updateFileStartAndEnd(fileStart, fileEnd, parsedDiff, isRightSide);
  }
}

function updateFileStartAndEnd(fileStart: any, fileEnd: any, parsedDiff: GitDiff, isRightSide: boolean): void {
  const snippets = fileStart.snippet.split(/[\r\n]+/);
  const isMultilineSnippet = snippets.length > 1;
  const snippetFirst = snippets[0];

  const { lineNumber, offset } = getLineNumberAndOffset(parsedDiff, snippetFirst, fileStart.line, isRightSide);
  if (lineNumber === undefined || offset === undefined) {
    return;
  }

  fileStart.line = lineNumber;
  fileStart.offset = offset;
  fileEnd.line = lineNumber;
  fileEnd.offset = offset + snippetFirst.length;

  if (isMultilineSnippet) {
    updateFileEndForMultilineSnippet(fileEnd, snippets, parsedDiff, isRightSide);
  }
}

function updateFileEndForMultilineSnippet(fileEnd: any, snippets: string[], parsedDiff: GitDiff, isRightSide: boolean): void {
  const snippetLast = snippets[snippets.length - 1];
  const { lineNumber: lastLineNumber, offset: lastLineOffset } = getLineNumberAndOffset(
    parsedDiff,
    snippetLast,
    fileEnd.line,
    isRightSide
  );
  if (lastLineNumber === undefined || lastLineOffset === undefined) {
    return;
  }
  fileEnd.line = lastLineNumber;
  fileEnd.offset = lastLineOffset + snippetLast.length;
}

function getLineNumberAndOffset(
  parsedDiff: GitDiff,
  searchText: string,
  originalLineNumber: number,
  shouldSearchRightSide: boolean = true
): { lineNumber: number | undefined; offset: number | undefined } {
  const line = getGitDiffLine(parsedDiff, searchText, originalLineNumber, shouldSearchRightSide);
  if (!line) {
    return { lineNumber: undefined, offset: undefined };
  }
  const lineNumber = getLineNumber(line, shouldSearchRightSide);
  const offset = line.content.indexOf(searchText) + 1;
  return { lineNumber, offset };
}

function getLineNumber(diffLineMeta: AnyLineChange, isRightSide: boolean): number | undefined {
  return isRightSide
    ? (diffLineMeta as AddedLine | UnchangedLine)?.lineAfter
    : (diffLineMeta as DeletedLine | UnchangedLine)?.lineBefore;
}

function getGitDiffLine(
  diff: GitDiff,
  searchText: string,
  originalLineNumber: number,
  shouldSearchRightSide: boolean = true
) {
  const changes = getChangesFromDiff(diff);
  const lines = filterChanges(changes, searchText, shouldSearchRightSide);
  const line = findClosestLine(lines, originalLineNumber, shouldSearchRightSide);
  return line;
}

function getChangesFromDiff(diff: GitDiff): AnyLineChange[] {
  if (!diff.files.length) {
    return [];
  }
  return diff.files[0].chunks.flatMap((chunk: AnyChunk) => ('changes' in chunk ? chunk.changes : []));
}

function filterChanges(
  changes: AnyLineChange[],
  searchText: string,
  shouldSearchRightSide: boolean
): AnyLineChange[] {
  return changes.filter(
    (change: AnyLineChange) =>
      change.content.includes(searchText) &&
      (change.type === 'UnchangedLine' || change.type === (shouldSearchRightSide ? 'AddedLine' : 'DeletedLine'))
  );
}

function findClosestLine(
  lines: AnyLineChange[],
  originalLineNumber: number,
  shouldSearchRightSide: boolean
): AnyLineChange | undefined {
  if (!lines.length) return undefined;
  return lines.reduce((previous: AnyLineChange, current: AnyLineChange) => {
    if (shouldSearchRightSide) {
      const currentLine = current as AddedLine | UnchangedLine;
      const previousLine = previous as AddedLine | UnchangedLine;
      return Math.abs(currentLine.lineAfter - originalLineNumber) < Math.abs(previousLine.lineAfter - originalLineNumber)
        ? currentLine
        : previousLine;
    } else {
      const currentLine = current as DeletedLine | UnchangedLine;
      const previousLine = previous as DeletedLine | UnchangedLine;
      return Math.abs(currentLine.lineBefore - originalLineNumber) < Math.abs(previousLine.lineBefore - originalLineNumber)
        ? currentLine
        : previousLine;
    }
  }, lines[0]);
}
