import { applyConfidenceFilterToFindings, dedupeAgainstPrevious, getCommentContentForExclusion } from './dedupe/dedupeUtils';
import { fixThreadPositions } from './sanitize/commentLocator';
import {
  Finding,
  PreviousComment,
  ReviewComment,
  ReviewInput,
  ReviewPolicy,
  ReviewReport,
  ReviewSummary,
  ThreadContext,
} from './types';
import { LlmClient, LlmReviewRequest, ReviewThread } from './llm/types';


/**
 * Ensures file paths consistently start with a leading slash for matching.
 * @param path The file path to normalize.
 * @returns The normalized file path.
 */
function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Builds the LLM review request payload.
 * @param filePath The file path for the LLM request.
 * @param diff The unified diff for the LLM request.
 * @param existingComments The existing comments for the LLM request.
 * @param policy The review policy for the LLM request.
 * @returns The built LLM review request.
 */
function buildLlmRequest(
  filePath: string,
  diff: string,
  existingComments: string[],
  policy: ReviewPolicy
): LlmReviewRequest {
  // Build and return the LLM review request.
  return {
    filePath: normalizePath(filePath),
    diff,
    existingComments,
    options: {
      checks: policy.checks,
      modifiedLinesOnly: policy.modifiedLinesOnly,
      additionalPrompts: policy.prompts.additional,
      confidenceMode: policy.confidence.enabled,
      systemPrompt: policy.prompts.systemPrompt,
    },
  };
}

/**
 * Derives a simple line range (lineStart/lineEnd) from the richer ThreadContext.
 * This is mainly for adapters that only support line ranges.
 *
 * Note:
 * - Azure DevOps supports Position objects; prefer using ThreadContext positions.
 */
function deriveLineRange(ctx?: ThreadContext): { lineStart?: number; lineEnd?: number } {
  // Determine line start from thread context.
  const start =
    ctx?.rightFileStart?.line ??
    ctx?.leftFileStart?.line;
  // Determine line end from thread context.
  const end =
    ctx?.rightFileEnd?.line ??
    ctx?.leftFileEnd?.line;
  // Return the derived line range.
  return { lineStart: start, lineEnd: end };
}

/**
 * Transforms a review thread into one or more findings.
 * @param thread The review thread to convert.
 * @param filePath The file path for the findings.
 * @returns The converted findings.
 */
function threadToFindings(thread: ReviewThread, filePath: string): Finding[] {
  // Initialize findings array.
  const findings: Finding[] = [];
  // Determine line range from thread context.
  const { lineStart, lineEnd } = deriveLineRange(thread.threadContext);

  // Convert each comment in the thread to a finding.
  for (const comment of thread.comments) {
    findings.push({
      id: '',
      filePath,
      lineStart,
      lineEnd,
      severity: deriveSeverity(comment.issueType),
      category: comment.issueType,
      title: comment.issueType ?? 'Code review',
      content: comment.content,
      confidence: comment.confidenceScore,
      suggestion: comment.fixSuggestion,
      threadContext: thread.threadContext as ThreadContext,
      sourceThread: thread,
    });
  }
  return findings;
}

/**
 * Derives severity level from issue type string.
 * @param issueType The issue type string to derive severity from.
 * @returns The derived severity level.
 */
function deriveSeverity(issueType?: string): 'low' | 'medium' | 'high' | 'critical' {
  // Map issue types to severity levels.
  switch ((issueType ?? '').toUpperCase()) {
    case 'SECURITY': return 'critical'; // Security issues are critical
    case 'BUG': return 'high'; // Bugs are high severity
    case 'PERFORMANCE': return 'high'; // Performance issues are high severity
    case 'BEST_PRACTICE': return 'medium'; // Best practices are medium severity
    default: return 'medium'; // Default to medium severity
  }
}

/**
 * Shapes a markdown summary of the review results.
 * @param summary The summary to format.
 * @returns The formatted summary string.
 */
function summarize(summary: ReviewSummary): string {
  return `Findings: ${summary.remaining} (${summary.filtered} filtered out, total generated ${summary.total}).`;
}

/**
 * Computes a summary of findings for reporting.
 * @param findings The findings to summarize.
 * @param filteredOut The filtered out findings.
 * @returns The computed summary.
 */
function computeSummary(findings: Finding[], filteredOut: Finding[]): ReviewSummary {
  const total = findings.length + filteredOut.length;
  const remaining = findings.length;
  return { total, filtered: filteredOut.length, remaining };
}

/**
 * Removes sourceThread from findings to keep payload small and avoid duplication.
 * Keep sourceThread only for internal debug scenarios.
 */
function stripSourceThreads(report: ReviewReport): ReviewReport {
  return {
    ...report,
    findings: report.findings.map(f => ({ ...f, sourceThread: undefined })),
    filteredOut: report.filteredOut?.map(f => ({ ...f, sourceThread: undefined })),
  };
}

/**
 * Core entry point: orchestrates per-file LLM review, confidence filtering,
 * dedupe against previous comments, and returns a normalized report.
 * @param input The review input containing files, policy, and previous comments.
 * @param llmClient The LLM client to use for code review.
 * @returns The final review report.
 */
export async function reviewCode(input: ReviewInput, llmClient: LlmClient): Promise<ReviewReport> {
  // Handle case with no files to review.
  if (!input.files?.length) {
    // Return empty report.
    return { summaryMarkdown: 'No files to review.', findings: [], filteredOut: [] };
  }

  // Accumulators for final report.
  const filteredOut: Finding[] = [];
  // Final findings after all processing.
  const findings: Finding[] = [];
  // Comments generated during this run for dedupe purposes.
  const runComments: ReviewComment[] = [];
  // Track seen signatures to avoid duplicates within this run.
  const seenSignatures = new Set<string>();
  // Track if dedupe criteria has been met in this run.
  let dedupeCriteriaMet = false;

  // Process each file in the input. Each file gets its own LLM review.
  for (const file of input.files) {
    // Extract previous comments for this file.
    const previousFileComments = (input.previousComments ?? [])
      .filter((c) => normalizePath(c.filePath ?? '') === normalizePath(file.path))
      .map((c): ReviewComment => ({ content: c.content, commentType: 0 }));

    // Determine which comments to exclude based on dedupe logic.
    const [commentsForExclusion, newDedupeMet] = getCommentContentForExclusion(
      previousFileComments,
      runComments,
      input.policy,
      dedupeCriteriaMet
    );
    // Update dedupe criteria met flag.
    dedupeCriteriaMet = newDedupeMet;

    // Build and send LLM request for this file.
    const request = buildLlmRequest(file.path, file.diff, commentsForExclusion, input.policy);
    // Call LLM to review the code changes.
    const response = await llmClient.reviewCode(request);

    // Adjust approximate line/offsets from the model to align with actual diff.
    const sanitizedThreads = fixThreadPositions(response.threads ?? [], file.diff);
    // Collect current run comments for dedupe purposes.
    const currentRunComments = sanitizedThreads.flatMap((thread) => thread.comments);
    // Add to overall run comments.
    runComments.push(...currentRunComments);

    // Convert threads to findings for further processing.
    const threadFindings = sanitizedThreads.flatMap((thread) => threadToFindings(thread, normalizePath(file.path)));

    // Apply confidence filtering as per policy.
    const { remaining: confidenceRemaining, filteredOut: confidenceFiltered } = applyConfidenceFilterToFindings(
      threadFindings,
      input.policy
    );
    // First filter by confidence, then dedupe against previous comments.
    filteredOut.push(...confidenceFiltered);

    // Dedupe against previous comments if enabled.
    const { deduped, removed } = dedupeAgainstPrevious(confidenceRemaining, input.previousComments, seenSignatures);
    // Add deduped findings to final results.
    findings.push(...deduped);
    // Collect removed findings as filtered out.
    filteredOut.push(...removed);
  }

  // Compute summary for the report.
  const summary = computeSummary(findings, filteredOut);

  // Return the final review report.
  const finalReport: ReviewReport = {
    summaryMarkdown: summarize(summary),
    findings,
    filteredOut,
  };
  // Strip sourceThread from findings before returning.
  return stripSourceThreads(finalReport);
}

/**
 * Default export for reviewCode function.
 */
export default reviewCode;
