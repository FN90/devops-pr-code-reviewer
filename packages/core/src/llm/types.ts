import { ReviewComment, ThreadContext } from '../types';

/** Thread returned by an LLM call. Mirrors the JSON contract in prompts. */
export interface ReviewThread {
  comments: ReviewComment[];
  status: number;
  threadContext: ThreadContext;
}

/**
 * Request to perform a code review via LLM, including file diff and options.
 */
export interface LlmReviewRequest {
  filePath: string;
  diff: string;
  existingComments: string[];
  options: {
    checks: {
      bugs: boolean;
      performance: boolean;
      bestPractices: boolean;
    };
    modifiedLinesOnly: boolean;
    additionalPrompts: string[];
    confidenceMode: boolean;
    systemPrompt?: string;
  };
}

/**
 * Response from an LLM review call, containing one or more review threads.
 */
export interface LlmReviewResponse {
  threads: ReviewThread[];
}

/** Adapter-facing interface so core can work with any chat provider. */
export interface LlmClient {
  reviewCode(request: LlmReviewRequest): Promise<LlmReviewResponse>;
}

/** Configuration for initializing an LLM model/client. */
export interface LlmModelConfig {
  model: string;
  maxInputTokens?: number;
  systemPrompt?: string;
}
