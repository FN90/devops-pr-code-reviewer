import { createHash } from 'crypto';
import { Finding, PreviousComment, ReviewComment, ReviewPolicy } from '../types';

/** Filters comments based on confidence threshold only. */
export function filterCommentsByConfidence(comments: ReviewComment[], confidenceMinimum: number) {
  const filteredOut: ReviewComment[] = [];
  const remaining: ReviewComment[] = [];
  comments.forEach((comment) => {
    if (comment.confidenceScore !== undefined && comment.confidenceScore < confidenceMinimum) {
      filteredOut.push(comment);
    } else {
      remaining.push(comment);
    }
  });
  return { filteredOut, remaining };
}

/** Applies policy-driven confidence filtering to comments. */
export function filterCommentsByPolicy(comments: ReviewComment[], policy: ReviewPolicy) {
  if (!policy.confidence.enabled) {
    return { filteredOut: [] as ReviewComment[], remaining: comments };
  }
  return filterCommentsByConfidence(comments, policy.confidence.minimum);
}

/**
 * Determines exclusion list for the current file by considering prior comments and
 * cross-file dedupe rules. Returns both exclusion content and dedupe state flag.
 */
export function getCommentContentForExclusion(
  fileComments: ReviewComment[],
  runComments: ReviewComment[],
  policy: ReviewPolicy,
  deduplicationCriteriaMet: boolean
): [string[], boolean] {
  let commentsForExclusion = [...fileComments];
  let dedupeMet = deduplicationCriteriaMet;
  if (policy.dedupeAcrossFiles.enabled) {
    if (!dedupeMet) {
      const currentRunCommentCount = filterCommentsByPolicy(runComments, policy).remaining.length;
      if (currentRunCommentCount > policy.dedupeAcrossFiles.threshold) {
        dedupeMet = true;
      }
    }
    if (dedupeMet) {
      commentsForExclusion = [...fileComments, ...runComments];
    }
  }
  return [commentsForExclusion.map((comment) => comment.content), dedupeMet];
}

/** Creates a deterministic signature used to dedupe findings across runs. */
export function buildFindingSignature(input: {
  filePath?: string;
  content: string;
  lineStart?: number;
  lineEnd?: number;
}): string {
  const normalized = `${input.filePath ?? ''}|${input.content.trim()}`;
  return createHash('sha256').update(normalized).digest('hex');
}

/** Applies confidence filter to normalized findings. */
export function applyConfidenceFilterToFindings(findings: Finding[], policy: ReviewPolicy) {
  if (!policy.confidence.enabled) {
    return { remaining: findings, filteredOut: [] as Finding[] };
  }
  const remaining: Finding[] = [];
  const filteredOut: Finding[] = [];
  for (const finding of findings) {
    if (finding.confidence !== undefined && finding.confidence < policy.confidence.minimum) {
      filteredOut.push(finding);
    } else {
      remaining.push(finding);
    }
  }
  return { remaining, filteredOut };
}

/**
 * Removes duplicates against previous comments and within the same run, returning
 * deduped findings and a list of removed ones for reporting.
 */
export function dedupeAgainstPrevious(
  findings: Finding[],
  previousComments: PreviousComment[] | undefined,
  seenSignatures: Set<string>
) {
  const removed: Finding[] = [];
  const previousSignatures = new Set(
    (previousComments ?? []).map((c) => buildFindingSignature({ filePath: c.filePath, content: c.content }))
  );

  const deduped: Finding[] = [];
  for (const finding of findings) {
    const signature = finding.id && finding.id.length ? finding.id : buildFindingSignature(finding);
    const alreadySeen = seenSignatures.has(signature) || previousSignatures.has(signature);
    if (alreadySeen) {
      removed.push(finding);
    } else {
      seenSignatures.add(signature);
      deduped.push({ ...finding, id: signature });
    }
  }

  return { deduped, removed };
}
