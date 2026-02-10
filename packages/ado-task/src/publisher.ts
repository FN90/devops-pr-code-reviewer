import { Finding, ReviewReport } from '@devops-ai-reviewer/core';
import { AdoPullRequest } from './adoPullRequest';
import * as tl from 'azure-pipelines-task-lib/task';

/**
 * Responsible for publishing review findings to ADO PR threads using different strategies.
 *
 * Key ADO gotchas:
 * - ADO thread API is very particular about payload shape; malformed payloads can cause 400s.
 * - Attaching to files requires `threadContext.filePath` and is more stable with `changeTrackingId`.
 * - Line-level anchoring is fragile due to ADO diff mapping and AI line references; file-level threads are more robust.
 */
const enum CommentType {
  Text = 1,
  CodeChange = 2,
}

/**
 * Supported publishing strategies.
 *
 * - inline: one PR thread per finding (attempt line-level anchoring)
 * - file:   one PR thread per file (aggregated content per file)
 * - pr_summary: one PR thread total (aggregated content across files)
 */
export type CommentMode = 'inline' | 'file' | 'pr_summary';

/**
 * Publishes review findings to ADO PR threads using the selected comment mode.
 * Designed to be resilient to ADO API quirks and provide a good user experience.
 * Responsibilities:
 * - Build thread payloads according to the selected mode.
 * - Sanitize payloads to avoid ADO 400 errors.
 * - Handle edge cases like missing file paths or line numbers gracefully.
 */
export class Publisher {

  /**
   * Constructor.
   * @param pr Pull request context for publishing threads.
   * @param changeIdByPath Change tracking IDs mapped by file path, used for more stable file attachment.
   * @param commentMode Comment publishing mode (inline, file, pr_summary).
   * @param options Options for controlling content limits and formatting.
   */
  constructor(
    private pr: AdoPullRequest,
    private changeIdByPath: Map<string, number | undefined>,
    private commentMode: CommentMode = 'file',
    private options?: {
      /** In pr_summary/file modes: limit number of findings printed per file (0 = unlimited). */
      maxFindingsPerFile?: number;
      /** Include confidence line in formatted output. */
      includeConfidence?: boolean;
    }
  ) { }

  /**
   * Entry point: publishes a ReviewReport using the selected comment mode.
   */
  async publish(report: ReviewReport): Promise<void> {
    // Extract findings and options for easier access.
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    // Default options: include confidence by default, no limit on findings per file.
    const includeConfidence = this.options?.includeConfidence ?? true;
    // For file/pr_summary modes, apply the max findings per file limit if specified.
    const maxPerFile = this.options?.maxFindingsPerFile ?? 0;

    // Always post a breadcrumb summary so users see it ran.
    if (findings.length === 0) {
      tl.warning('No findings to publish; posting summary thread.');
      await this.safeAddThread(this.toTextThread('✅ DevOps AI Code Reviewer ran successfully. No findings for the selected changes.'));
      return;
    }

    // Mode switch
    switch (this.commentMode) {
      case 'pr_summary': {
        const content = this.buildPrSummaryMarkdown(findings, { includeConfidence, maxPerFile });
        await this.safeAddThread(this.toTextThread(content));
        return;
      }

      case 'file': {
        // 1 thread per file (best UX; low noise, no “file no longer exists” banner)
        const grouped = this.groupByFile(findings);

        // Log the grouping result for debugging.
        tl.debug(`Grouped findings by file: ${JSON.stringify(grouped)}`);

        // Header thread
        await this.safeAddThread(
          this.toTextThread(`🧠 DevOps AI Code Reviewer found **${findings.length}** issue(s) across **${grouped.size}** file(s).`)
        );

        // Then one thread per file with aggregated content (avoids line-mapping fragility and banner)
        for (const [filePath, fileFindings] of grouped) {
          // Normalize filePath for ADO display and matching with changeTrackingId
          const content = this.buildFileThreadMarkdown(filePath, fileFindings, { includeConfidence, maxPerFile });
          // Note: filePath may start with "/" (ADO uses "/Src/...") or not, but normalize it for matching.
          await this.safeAddThread(this.toFileLevelThread(filePath, fileFindings, content));
        }
        return;
      }

      case 'inline':
      default: {
        // Header thread
        await this.safeAddThread(
          this.toTextThread(`🧠 DevOps AI Code Reviewer found **${findings.length}** issue(s). Posting inline details...`)
        );

        // One thread per finding, anchored to the line if possible (most fragile, but some users prefer it)
        for (const finding of findings) {
          // Note: line-level anchoring is inherently fragile due to ADO diff mapping and AI line references, but we attempt it for better context when it works. We anchor to the first line of the finding if available, otherwise fallback to a file-level thread.
          const thread = this.toInlineThread(finding);
          tl.debug(`Publishing inline thread for: ${finding.content.substring(0, 100)}...`);
          await this.safeAddThread(thread);
        }
        return;
      }
    }
  }

  // ----------------------------
  // Thread builders
  // ----------------------------

  /**
   * Creates a plain PR-level text thread (not tied to any file).
   */
  private toTextThread(message: string) {
    return {
      comments: [{ content: message, commentType: CommentType.Text }],
      status: 1,
    };
  }

  /**
  * Creates a file-scoped thread (one thread per file) while avoiding fragile range mapping.
  *
  * Important:
  * - ADO only considers a thread "file-attached" if `threadContext.filePath` is present.
  * - `pullRequestThreadContext.changeTrackingId` helps ADO bind the comment to the PR change entry.
  * - We still provide a single right-side anchor line, because some ADO views won't "attach"
  *   without a location. Using ONE line is less error-prone than ranges.
  *
  * Strategy:
  * - Anchor at the first available finding lineStart (min), otherwise 1.
  * - Keep RIGHT-side only (avoid leftFileStart/leftFileEnd which can trigger 400s).
  */
  private toFileLevelThread(filePathRaw: string, fileFindings: Finding[], markdown: string) {
    // Normalize file path for ADO and matching with changeTrackingId
    const filePath = this.normalizeAdoPath(filePathRaw);
    const changeTrackingId = this.changeIdByPath.get(filePath);

    // Log the file path and associated change tracking ID for debugging.
    tl.debug(`Creating file-level thread for path: "${filePath}" with changeTrackingId: ${changeTrackingId}`);

    // Pick a stable anchor line for the file thread (min lineStart in this file, fallback 1)
    const candidateLines = fileFindings
      .map(f => f.lineStart)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);

    // Log candidate lines for debugging.
    tl.debug(`Candidate anchor lines for file "${filePath}": ${candidateLines.join(', ')}`);

    // Use the minimum lineStart as the anchor line, or 1 if none are valid.
    const anchorLine = 1; // We intentionally avoid using the candidateLines to determine the anchor line, as it can lead to fragile mappings and 400 errors in ADO. Instead, we will use line 1 for file-level threads to ensure they are attached to the file without relying on specific line numbers.
    // TODO: In the future, we could consider more advanced heuristics for choosing an anchor line that is less likely to cause issues, such as always using line 1 or allowing configuration of a fixed line number for file-level threads.
    // const anchorLine = candidateLines.length ? Math.min(...candidateLines) : 1;
    // Log the chosen anchor line for debugging.
    tl.debug(`Chosen anchor line for file "${filePath}": ${anchorLine}`);

    const thread: any = {
      comments: [{ content: markdown, commentType: CommentType.Text }],
      status: 1,

      // This is what makes ADO attach the thread to the FILE
      threadContext: {
        filePath,
        rightFileStart: null, // { line: anchorLine, offset: 0 },
        rightFileEnd: null // { line: anchorLine, offset: 0 },
      },
    };

    // Optional but recommended: binds to the PR change entry (more stable for renames/adds)
    if (typeof changeTrackingId === 'number') {
      thread.pullRequestThreadContext = { changeTrackingId };
    }

    return thread;
  }

  /**
   * Creates an inline thread for a single finding.
   * Attempts to anchor to one right-side line only.
   *
   * Note:
   * - Inline mode is inherently fragile because AI findings often reference “visual” line ranges,
   *   and ADO’s diff/line mapping for PR iterations can differ from file content line numbers.
   */
  private toInlineThread(finding: Finding) {
    // Normalize file path for ADO and matching with changeTrackingId
    const filePath = this.normalizeAdoPath(finding.filePath);
    if (!filePath) {
      return this.toTextThread(this.decorateFindingContent(finding, true));
    }

    // Anchor at the first line of the finding if available, otherwise fallback to line 1. Using a single right-side line is more stable for ADO's diff mapping.
    const anchorLine = Math.max(1, finding.lineStart ?? 1);

    // Create the thread with right-side anchoring. We intentionally avoid leftFileStart/leftFileEnd which can trigger 400s, and we use a single line for anchoring to reduce fragility.
    const threadContext: any = {
      filePath,
      rightFileStart: { line: anchorLine, offset: 1 },
      rightFileEnd: { line: anchorLine, offset: 1 },
    };

    // Optional but recommended: binds to the PR change entry (more stable for renames/adds)
    const changeTrackingId = this.changeIdByPath.get(filePath);

    // Create the thread payload with the finding content and the thread context for file attachment. We use commentType Text for inline threads to allow for better formatting, but this can be adjusted if needed.
    const thread: any = {
      comments: [{ content: this.decorateFindingContent(finding, true), commentType: CommentType.CodeChange }],
      status: 1,
      threadContext,
    };

    // If we have a valid changeTrackingId, include it in the pullRequestThreadContext to help ADO bind this thread to the specific change entry, which can improve stability for file attachments especially in cases of renames or additions.
    if (typeof changeTrackingId === 'number') {
      thread.pullRequestThreadContext = { changeTrackingId };
    }

    return thread;
  }

  // ----------------------------
  // Markdown builders
  // ----------------------------

  /**
   * Builds a single PR summary comment that includes actual issue text.
   * Uses markdown details blocks so it stays readable even for large PRs.
   */
  private buildPrSummaryMarkdown(
    findings: Finding[],
    opts: { includeConfidence: boolean; maxPerFile: number }
  ): string {
    // Group findings by file for the summary section and details sections. This allows us to provide a high-level overview of how many issues are in each file, and then detailed lists of issues per file in collapsible sections.
    const grouped = this.groupByFile(findings);

    // Build the markdown content for the PR summary thread. We start with a header that shows the total number of issues and files, then a summary list of files with issue counts, and then detailed sections for each file with the individual findings. We use the applyLimit function to control how many findings are shown per file based on the maxFindingsPerFile option.
    const lines: string[] = [];
    lines.push(`🧠 DevOps AI Code Reviewer found **${findings.length}** issue(s).`);
    lines.push('');
    lines.push(`Summary by file (**${grouped.size}** file(s))`);
    lines.push('');

    // Short index first (counts)
    for (const [file, fileFindings] of grouped) {
      lines.push(`- \`${file}\`: **${fileFindings.length}** issue(s)`);
    }

    // Then details sections with collapsible markdown blocks for each file. This allows users to expand only the files they are interested in, keeping the overall comment more manageable.
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Details');
    lines.push('');

    // Then actual details grouped by file, collapsed
    for (const [file, fileFindings] of grouped) {
      const shown = this.applyLimit(fileFindings, opts.maxPerFile);
      const remaining = fileFindings.length - shown.length;

      lines.push(`<details>`);
      lines.push(`<summary><b>${file}</b> — ${fileFindings.length} issue(s)</summary>`);
      lines.push('');
      lines.push(this.renderFindingsList(shown, opts.includeConfidence));
      if (remaining > 0) {
        lines.push('');
        lines.push(`_(${remaining} more issue(s) omitted — increase maxFindingsPerFile to show all.)_`);
      }
      lines.push('');
      lines.push(`</details>`);
      lines.push('');
    }

    lines.push('');
    lines.push('Tip: set `comment_mode=file` for one thread per file, or `comment_mode=inline` for per-line threads.');
    return lines.join('\n');
  }

  /**
   * Builds the content of a single file-level thread (aggregated issues).
   */
  private buildFileThreadMarkdown(
    filePath: string,
    findings: Finding[],
    opts: { includeConfidence: boolean; maxPerFile: number }
  ): string {
    // Apply the max findings per file limit if specified, and calculate how many findings are remaining. This allows us to show a manageable number of issues in the thread while indicating that there are more issues that are not shown due to the limit.
    const shown = this.applyLimit(findings, opts.maxPerFile);
    // Calculate how many findings are not shown due to the maxPerFile limit, so we can indicate this in the thread content if there are more issues than shown.
    const remaining = findings.length - shown.length;

    // Build the markdown content for the file-level thread. We include a header with the file name and issue count, then a numbered list of findings with optional confidence scores. If there are more findings than shown, we add a note at the end indicating that some issues are omitted due to the limit.
    const lines: string[] = [];
    // We intentionally keep the file name in the thread content for better context, even though the thread is also attached to the file via threadContext. This is because some ADO views may not clearly show the attachment, and having the file name in the content helps ensure users understand which file the issues pertain to.
    lines.push(`🧠 **DevOps AI Code Reviewer — File Review**`);
    lines.push(`**File:** \`${filePath}\``);
    lines.push(`**Issues:** ${findings.length}`);
    lines.push('');
    lines.push(this.renderFindingsList(shown, opts.includeConfidence));

    if (remaining > 0) {
      lines.push('');
      lines.push(`_(${remaining} more issue(s) omitted — increase maxFindingsPerFile to show all.)_`);
    }

    return lines.join('\n');
  }

  /**
   * Renders a compact numbered list of findings.
   */
  private renderFindingsList(findings: Finding[], includeConfidence: boolean): string {
    // We render a numbered list of findings with optional confidence scores. Each finding includes a one-line title (truncated for readability) and the content indented below it. If confidence is included, it's shown in italics below the content. We also indicate line numbers if available.
    const lines: string[] = [];
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];

      const loc =
        f.filePath
          ? ` (line ${f.lineStart ?? 1}${f.lineEnd && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ''})`
          : '';

      lines.push(`${i + 1}. **${this.safeOneLineTitle(f.content)}**${loc}`);
      lines.push('');
      lines.push(`   ${this.indentMarkdown(this.stripLeadingMarkdownBullets(f.content), 3)}`);

      if (includeConfidence && typeof f.confidence === 'number') {
        lines.push('');
        lines.push(`   _Confidence: ${(f.confidence * 100).toFixed(0)}%_`);
      }

      lines.push('');
    }
    return lines.join('\n').trim();
  }

  // ----------------------------
  // Helpers
  // ----------------------------

  /**
   * Normalizes ADO path format:
   * - ensures leading "/"
   * - returns "" if missing
   */
  private normalizeAdoPath(path?: string): string {
    const raw = (path ?? '').trim();
    if (!raw) return '';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  /**
   * Groups findings by filePath (falls back to "PR" bucket for missing filePath).
   */
  private groupByFile(findings: Finding[]): Map<string, Finding[]> {
    const map = new Map<string, Finding[]>();
    for (const f of findings) {
      const key = this.normalizeAdoPath(f.filePath) || '(PR-level / no file)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }

  /**
   * Applies the max findings per file limit if specified, returning the limited list of findings. If maxPerFile is 0 or negative, it returns all findings without applying any limit.
   * @param findings Findings to potentially limit.
   * @param maxPerFile Maximum number of findings to include per file. 0 or negative means no limit.
   * @returns Findings limited to the specified max per file, or all findings if no limit is set.
   */
  private applyLimit(findings: Finding[], maxPerFile: number): Finding[] {
    if (!maxPerFile || maxPerFile <= 0) return findings;
    return findings.slice(0, maxPerFile);
  }

  /**
   * Applies a simple one-line title extraction and truncation for better readability in summary lists. This helps ensure that the summary view of findings remains concise and doesn't get overwhelmed by long content. We also replace multiple whitespace characters with a single space and trim the result to keep it clean.
     * If the resulting title is longer than 110 characters, we truncate it and add an ellipsis to indicate that it's been shortened.
   *
   * @param text Original finding content.
   * @returns A one-line title suitable for summary display, truncated if necessary.
   */
  private safeOneLineTitle(text: string): string {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 110 ? t.slice(0, 107) + '...' : t;
  }

  /**
   * Strips leading markdown bullets from the content to avoid nested lists in the thread display, which can be hard to read. This is a simple regex that removes common bullet characters at the start of lines, while preserving the rest of the content formatting.
   *
   * @param text Original finding content.
   * @returns Content with leading markdown bullets removed.
   */
  private stripLeadingMarkdownBullets(text: string): string {
    return (text ?? '').replace(/^\s*[-*]\s+/gm, '');
  }

  /**
   * Indents multiline markdown content by a specified number of spaces. This is used to format the finding content within the thread so that it appears indented under the finding title, improving readability. We only add indentation to non-empty lines to avoid adding unnecessary whitespace.
   * @param text The markdown text to indent.
   * @param spaces Spaces to indent each line.
   * @returns Same text with each line indented by the specified number of spaces.
   */
  private indentMarkdown(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return (text ?? '').split('\n').map((l) => (l.trim().length ? pad + l : l)).join('\n');
  }

  /**
   * Decorates the finding content with additional information such as confidence score if available and requested. This is used for inline threads where we want to include more context directly in the comment content. We format the confidence as a percentage and include it in italics below the main content if the option is enabled and the confidence value is present.
   * @param finding Finding whose content is being decorated.
   * @param includeConfidence Indicates whether to include the confidence score in the output if it's available.
   * @returns String content of the finding decorated with additional information like confidence score if requested.
   */
  private decorateFindingContent(finding: Finding, includeConfidence: boolean): string {
    const confidence =
      includeConfidence && finding.confidence != null
        ? `\n\n**Confidence:** ${(finding.confidence * 100).toFixed(0)}%`
        : '';
    return `${finding.content}${confidence}`;
  }

  /**
   * Safely adds a thread to the PR, catching and logging any errors that occur during the API call. This ensures that if there are issues with the thread payload or ADO API, we can log the error for debugging without crashing the entire task. We also sanitize the thread payload before sending it to avoid common issues that can cause ADO to reject the request with a 400 error.
   * @param thread The thread payload to add to the PR.
   * @returns A promise that resolves when the thread has been added, or rejects if there was an error.
   */
  private async safeAddThread(thread: any): Promise<void> {
    try {
      const sanitized = this.sanitizeThreadForAdo(thread);
      tl.debug(`Posting thread payload: ${JSON.stringify(sanitized)}`);
      await this.pr.addThread(sanitized);
    } catch (e: any) {
      tl.error(`Failed to publish PR thread: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * Removes fields that commonly cause ADO 400s and normalizes payload shape.
   */
  private sanitizeThreadForAdo(thread: any) {
    // We perform a deep clone of the thread object to avoid mutating the original thread payload that we may want to log or inspect. This also allows us to safely modify the structure of the thread without affecting other parts of the code that may reference the original object.
    const t: any = JSON.parse(JSON.stringify(thread ?? {})); // deep clone

    if (!Array.isArray(t.comments)) t.comments = [];

    // Strip iterationContext if it exists anywhere (0 caused 400s)
    if (t.pullRequestThreadContext?.iterationContext) {
      delete t.pullRequestThreadContext.iterationContext;
    }
    if (t.threadContext?.pullRequestThreadContext?.iterationContext) {
      delete t.threadContext.pullRequestThreadContext.iterationContext;
    }

    // Keep threadContext clean (right-side only)
    if (t.threadContext) {
      if (typeof t.threadContext.filePath === 'string') {
        const p = t.threadContext.filePath.trim();
        t.threadContext.filePath = p.startsWith('/') ? p : `/${p}`;
      }
      delete t.threadContext.leftFileStart;
      delete t.threadContext.leftFileEnd;

      if (t.threadContext.rightFileStart?.line) {
        const line = Math.max(1, Number(t.threadContext.rightFileStart.line) || 1);
        t.threadContext.rightFileStart = { line, offset: 1 };
        t.threadContext.rightFileEnd = { line, offset: 1 };
      }
    }

    // If pullRequestThreadContext exists but no changeTrackingId, remove it
    if (t.pullRequestThreadContext && typeof t.pullRequestThreadContext.changeTrackingId !== 'number') {
      delete t.pullRequestThreadContext;
    }

    return t;
  }
}
