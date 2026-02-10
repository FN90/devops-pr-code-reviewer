import { ReviewThread } from './llm/types';

/**
 * Target host/provider for a review run. Kept narrow so adapters can map cleanly.
 */
export type Provider = 'azure-devops' | 'github' | 'gitlab' | 'cli' | 'api' | 'unknown';

/**
 * Identity of the review target plus helpful metadata (branches, commits, run id).
 */
export interface TargetMetadata {
  provider: Provider;
  repository: {
    id?: string;
    name?: string;
    url?: string;
  };
  pullRequest?: {
    id?: string | number;
    iteration?: { start: number; end: number };
    sourceBranch?: string;
    targetBranch?: string;
  };
  commits?: {
    base?: string;
    head?: string;
  };
  run?: {
    id?: string;
    attempt?: number;
  };
}

/**
 * A single file change to be reviewed. Diff uses unified format.
 */
export interface FileDiff {
  path: string;
  changeType?: 'add' | 'edit' | 'delete' | 'rename' | 'unknown';
  diff: string;
}

/**
 * Feature flags and thresholds that drive how the review engine behaves.
 */
export interface ReviewPolicy {
  checks: {
    bugs: boolean;
    performance: boolean;
    bestPractices: boolean;
  };
  modifiedLinesOnly: boolean;
  confidence: {
    enabled: boolean;
    minimum: number;
  };
  dedupeAcrossFiles: {
    enabled: boolean;
    threshold: number;
  };
  prompts: {
    additional: string[];
    systemPrompt?: string;
  };
}

/**
 * Minimal view of an existing comment, used for dedupe across reruns.
 */
export interface PreviousComment {
  id?: string;
  filePath?: string;
  content: string;
  line?: number;
}

/**
 * Provider-agnostic input contract for the core engine.
 */
export interface ReviewInput {
  target: TargetMetadata;
  files: FileDiff[];
  policy: ReviewPolicy;
  previousComments?: PreviousComment[];
}

/** Line/offset tuple within a file for thread placement. */
export interface Position {
  line: number;
  offset: number;
  snippet?: string;
}

/** Thread location across left/right sides of a diff. */
export interface ThreadContext {
  filePath: string;
  leftFileStart?: Position;
  leftFileEnd?: Position;
  rightFileStart?: Position;
  rightFileEnd?: Position;
}

/** Comment emitted by the LLM; adapters may enrich before publishing. */
export interface ReviewComment {
  content: string;
  commentType: number;
  confidenceScore?: number;
  confidenceScoreJustification?: string;
  fixSuggestion?: string;
  issueType?: string;
}

/**
 * Normalized finding emitted by core. `id` is deterministic for dedupe.
 */
export interface Finding {
  id: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category?: string;
  title: string;
  content: string;
  confidence?: number;
  suggestion?: string;
  threadContext?: ThreadContext;
  sourceThread?: ReviewThread;
}

/** Core output: markdown summary plus all findings (and any filtered ones). */
export interface ReviewReport {
  summaryMarkdown: string;
  findings: Finding[];
  filteredOut?: Finding[];
}

/** Internal summary stats that feed the markdown summary. */
export interface ReviewSummary {
  total: number;
  filtered: number;
  remaining: number;
}
