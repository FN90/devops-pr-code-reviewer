import { encode } from 'gpt-tokenizer';
import { OpenAI } from 'openai';
import { LlmClient, LlmModelConfig, LlmReviewRequest, LlmReviewResponse, ReviewThread } from './types';
import { ReviewComment, ThreadContext } from '../types';

/** Concrete LLM client for OpenAI/Azure OpenAI endpoints. */
export class OpenAiLlmClient implements LlmClient {
  /**
   * Initializes a new instance of the OpenAiLlmClient class.
   * @param client OpenAI client instance.
   * @param config Configuration for the LLM model.
   */
  constructor(private client: OpenAI, private config: LlmModelConfig) { }

  /**
   * Evaluates whether the given message exceeds the configured token limit.
   * @param message The message to check for token limit.
   * @returns Whether the message exceeds the configured token limit.
   */
  private exceedsTokenLimit(message: string): boolean {
    // If no maxTokens is set, it cannot exceed the limit.
    if (!this.config.maxInputTokens) return false;
    // Encode the message and count tokens.
    const tokenCount = encode(message).length;
    // Return whether the token count exceeds the limit.
    return tokenCount > this.config.maxInputTokens;
  }

  /**
   * Reviews code changes using OpenAI chat completions.
   * @param request Request to review code changes.
   * @returns Response with review threads.
   */
  public async reviewCode(request: LlmReviewRequest): Promise<LlmReviewResponse> {
    // Build prompts.
    const systemPrompt = buildSystemPrompt(request);
    // Build user prompt.
    const userPrompt = buildUserPrompt(request);
    // Combine for token limit check.
    const fullPrompt = `${systemPrompt}\n${userPrompt}`;

    // Check token limit.
    if (this.exceedsTokenLimit(fullPrompt)) {
      // Return empty response if over token limit.
      return { threads: [] };
    }

    // Call OpenAI chat completions.
    const response = await this.client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      model: this.config.model,
      temperature: 0,
      max_completion_tokens: this.config.maxInputTokens ?? 5000, // cap output
    });

    // Parse and return response.
    const choice = response.choices?.[0]?.message?.content ?? '';
    // Try to extract JSON object from the response.
    const extractedJson = tryExtractJsonObject(choice);
    // If no JSON found, return diagnostic thread.
    if (!extractedJson) {
      // Return diagnostic thread indicating no JSON found.
      const snippet = choice.slice(0, 800);
      return diagnosticThread(
        request.filePath,
        "BUG",
        `LLM_OUTPUT_PARSE_ERROR: No JSON object found in output. Output snippet:\n${snippet}`
      );
    }

    // Attempt to parse JSON response.
    try {
      // Parse the response content as JSON.
      const parsed = JSON.parse(extractedJson);
      // Validate the parsed response shape.
      if (!isValidResponse(parsed)) {
        // Return diagnostic thread indicating invalid shape.
        return diagnosticThread(request.filePath, "BUG", "LLM_OUTPUT_INVALID_SHAPE: missing threads[]");
      }

      // Normalize confidence scores in each thread.
      for (const thread of parsed.threads ?? []) {
        for (const comment of thread.comments ?? []) {
          comment.confidenceScore = normalizeConfidence(comment.confidenceScore);
        }
      }

      // Return the parsed threads or an empty array if not present.
      return { threads: parsed.threads ?? [] };
    } catch (error) {
      // Logging could be added here for debugging.
      console.warn('Failed to parse LLM response:', error);
      // Return a diagnostic thread indicating parse error. Parse only first 800 chars.
      const snippet = choice.slice(0, 800);
      // Return diagnostic thread response.
      return diagnosticThread(
        request.filePath,
        "BUG",
        `LLM_OUTPUT_PARSE_ERROR: Failed to parse JSON. Output snippet:\n${snippet}`
      );
    }
  }
}



/**
 * Builds a strict system prompt that forces the model to output ONLY valid JSON,
 * matching our core types (ReviewThread, ThreadContext, Position, ReviewComment).
 *
 * Why this matters:
 * - Azure DevOps integration breaks easily if threadContext isn't consistent.
 * - Strict JSON avoids "markdown fences" and extra text that causes parse errors.
 * - Ensures threadContext uses Position objects, not raw numbers.
 * 
 * @param request The review request details.
 * @returns The system prompt as a string.
 */
function buildSystemPrompt(request: LlmReviewRequest): string {
  // Build the system prompt based on request options.
  const { options } = request;
  // Extract checks from options.
  const checks = options.checks;

  const additional = options.additionalPrompts.length
    ? `\nAdditional rules:\n- ${options.additionalPrompts.join('\n- ')}\n`
    : '';

  return `You are a precise code reviewer.
- Input: JSON with fileName, diff (unified diff), and existingComments.
- Do not repeat issues similar to existingComments.
- Only raise meaningful issues (avoid nits).
${options.modifiedLinesOnly ? '- Only comment on modified lines.\n' : ''}
${options.confidenceMode ? '- Include confidenceScore between 0.0 and 1.0.\n' : ''}
${options.checks.bugs ? '- Report bugs.\n' : '- Do not report bugs.\n'}
${options.checks.performance ? '- Report major performance issues.\n' : ''}
${options.checks.bestPractices ? '- Report missed best-practices.\n' : '- Skip best-practices.\n'}
${options.additionalPrompts.length ? options.additionalPrompts.map((p) => `- ${p}`).join('\n') + '\n' : ''}

OUTPUT (STRICT):
Return ONLY a single JSON object and nothing else (no markdown, no backticks).
The JSON MUST match:

{
  "threads": [
    {
      "status": 1,
      "threadContext": {
        "filePath": "<same as fileName>",
        "leftFileStart": { "line": <int>, "offset": <int> },
        "leftFileEnd":   { "line": <int>, "offset": <int> },
        "rightFileStart":{ "line": <int>, "offset": <int> },
        "rightFileEnd":  { "line": <int>, "offset": <int> }
      },
      "comments": [
        {
          "content": "<explanation>",
          "commentType": 0,
          "issueType": "SECURITY" | "BUG" | "PERFORMANCE" | "BEST_PRACTICE",
          "confidenceScore": <number 0.0-1.0>,
          "confidenceScoreJustification": "<1 sentence>",
          "fixSuggestion": "<optional concrete fix>"
        }
      ]
    }
  ]
}

Rules:
- Use rightFileStart/rightFileEnd for the new code side whenever possible.
- If exact locations are uncertain, set all positions to { "line": 1, "offset": 1 }.
- commentType must be a number (0).
- If there are multiple distinct issues in the same region, return multiple comments entries in the same thread rather than merging them into one paragraph.`;

}

/** 
 * User payload that provides file path, diff, and existing comments. 
 * @param request The review request details.
 * @returns The user prompt as a JSON string.
 */
function buildUserPrompt(request: LlmReviewRequest): string {
  // Shape the user prompt payload.
  const payload = {
    fileName: request.filePath,
    diff: request.diff,
    existingComments: request.existingComments,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Attempts to extract the outermost JSON object from a model response.
 *
 * Why this matters:
 * - Even "strict" prompts sometimes produce extra leading/trailing text.
 * - This helper lets us recover and still parse JSON safely.
 *
 * @param text Raw model output
 * @returns JSON substring that starts with '{' and ends with '}', or null if not found
 */
function tryExtractJsonObject(text: string): string | null {
  // Find the first '{' and last '}' to extract JSON object.
  const start = text.indexOf("{");
  // Find the last closing brace.
  const end = text.lastIndexOf("}");
  // If not found or invalid, return null.
  if (start === -1 || end === -1 || end <= start) return null;
  // Return the extracted JSON object substring.
  return text.slice(start, end + 1);
}

/**
 * Helpers create a diagnostic thread response.
 * It can be used when the LLM request cannot be processed.
 * It contains a single thread with one comment.
 * @param filePath File path for the diagnostic thread.
 * @param issueType The type of issue (e.g., "SECURITY", "BUG").
 * @param content The diagnostic message content.
 * @returns A LlmReviewResponse with a diagnostic thread.
 */
function diagnosticThread(filePath: string, issueType: string, content: string): LlmReviewResponse {
  // Define a placeholder position.
  const P1 = { line: 1, offset: 1 };
  // Define the thread context.
  const threadContext: ThreadContext = {
    filePath,
    leftFileStart: P1,
    leftFileEnd: P1,
    rightFileStart: P1,
    rightFileEnd: P1,
  };

  // Create the review comment.
  const comment: ReviewComment = {
    content: content,
    commentType: 0,
    issueType: issueType,
    confidenceScore: 1,
    confidenceScoreJustification: "Diagnostic message produced by the tool.",
    fixSuggestion: "Inspect the raw LLM output and adjust the prompt/schema.",
  };
  // Build and return the diagnostic thread response.
  return {
    threads: [
      {
        status: 1,
        threadContext: threadContext,
        comments: [comment]
      }
    ]
  };
}

/**
 * Validates that the given value is a ReviewThread.
 * @param value The object to validate
 * @returns Whether the value is a valid ReviewThread.
 */
function isValidReviewThread(value: any): value is ReviewThread {
  // Check that value has status, threadContext with filePath, and comments array.
  return value
    && typeof value.status === "number"
    && value.threadContext?.filePath
    && Array.isArray(value.comments);
}

/**
 * Validates that the given response is a valid LlmReviewResponse.
 * @param response The response to validate.
 * @returns Whether the response is a valid LlmReviewResponse.
 */
function isValidResponse(response: any): response is { threads: ReviewThread[] } {
  // Check that response has threads array and each thread is valid.
  return response && Array.isArray(response.threads) && response.threads.every(isValidReviewThread);
}

/**
 * Normalizes a confidence score to the range [0.0, 1.0].
 * @param score The confidence score to normalize.
 * @returns The normalized confidence score, or undefined if the input is invalid.
 */
function normalizeConfidence(score?: number): number | undefined {
  // If score is undefined or null, return undefined.
  if (score === undefined || score === null) return undefined;
  // If score is greater than 1, assume it's out of 10 and scale down.
  if (score > 1) return Math.max(0, Math.min(1, score / 10));
  // Otherwise, clamp score to [0, 1].
  return Math.max(0, Math.min(1, score));
}


// AzureOpenAiLlmClient uses same wire protocol; kept for clarity/DI symmetry.
export class AzureOpenAiLlmClient extends OpenAiLlmClient { }
