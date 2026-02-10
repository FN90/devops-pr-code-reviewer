import * as tl from 'azure-pipelines-task-lib/task';

/**
 * Comment publishing mode.
 *
 * - file:     one thread per file (aggregated)  ✅ default / best UX
 * - inline:   one thread per finding (human-like)
 * - pr_summary: a single summary thread for the whole PR (least noise)
 */
export type CommentMode = 'file' | 'inline' | 'pr_summary';

/**
 * Strongly typed view of ADO task inputs.
 *
 * IMPORTANT UNITS:
 * - confidenceMinimum: 0..1 (e.g., 0.9)
 * - dedupeAcrossFilesThreshold: 0..1 (e.g., 0.85)
 *
 * If you keep the task.json UI describing 1–10, you'll need a conversion here.
 */
export interface TaskInputs {
  /** OpenAI API key (or Azure OpenAI key). */
  apiKey: string;

  /** Optional: Azure OpenAI endpoint (if set, we assume Azure mode). */
  azureApiEndpoint?: string;

  /** Optional: Azure API version (e.g. 2024-10-21). */
  azureApiVersion?: string;

  /**
   * Azure deployment name.
   * Prototype note: if you only have ai_model in task.json, you may reuse it as deployment.
   */
  azureDeployment?: string;

  /** OpenAI model name (OpenAI mode) OR also used as deployment in prototype Azure mode. */
  model: string;

  /** File filter inputs passed to core's filterFilesForReview(). */
  fileExtensions?: string;
  fileExtensionExcludes?: string;
  filesToInclude?: string;
  filesToExclude?: string;

  /** Additional prompt lines appended to the LLM system prompt. */
  additionalPrompts: string[];

  /** Policy flags. */
  bugs: boolean;
  performance: boolean;
  bestPractices: boolean;
  modifiedLinesOnly: boolean;

  /** Prototype flag; if enabled, attempt to adjust line positions. */
  enableCommentLineCorrection: boolean;

  /** Allow re-running review even if no new iterations exist. */
  allowRequeue: boolean;

  /** Confidence filtering controls (0..1). */
  confidenceMode: boolean;
  confidenceMinimum: number;

  /** Dedupe controls (0..1). */
  dedupeAcrossFiles: boolean;
  dedupeAcrossFilesThreshold: number;

  /** Optional verbose logging switch. */
  verboseLogging: boolean;

  /** Publishing mode for PR comments. Default: "file". */
  commentMode: CommentMode;

  /** Maximum number of findings shown per file (file / pr_summary modes).
 * 0 or undefined = unlimited. */
  maxFindingsPerFile?: number;
}

/**
 * Parses a float task input safely.
 *
 * Supports:
 * - "0.9"
 * - "0,9" (EU decimal)
 * - "90%" (percentage)
 *
 * Always clamps the value into [0..1].
 *
 * @param name Task input name.
 * @param defaultValue Default value if missing or invalid.
 */
function readFloat(name: string, defaultValue: number): number {
  // Read the raw input value as a string, and trim whitespace. If it's empty or missing, return the default value.
  const raw = tl.getInput(name, false)?.trim();
  // If the raw input is empty or undefined, return the default value immediately.
  if (!raw) return defaultValue;

  // Normalize comma decimals: "0,9" -> "0.9"
  let normalized = raw.replace(',', '.');

  // Handle percentages: "90%" -> 0.9
  let isPercent = false;
  if (normalized.endsWith('%')) {
    isPercent = true;
    normalized = normalized.slice(0, -1);
  }

  // Parse the normalized string into a float. If it's not a valid number, return the default value.
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return defaultValue;
  // If it's a percentage, convert to 0..1 scale.
  const value = isPercent ? parsed / 100 : parsed;

  // Clamp into [0..1]
  return Math.min(1, Math.max(0, value));
}

/**
 * Reads a string input and restricts it to known values.
 */
function readEnum<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  // Read the raw input value as a string, and trim whitespace. If it's empty or missing, return the default value.
  const raw = (tl.getInput(name, false) ?? '').trim();
  // If the raw input is empty or undefined, return the default value immediately.
  if (!raw) return defaultValue;
  // Check if the raw input matches one of the allowed values. If so, return it; otherwise, return the default value.
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : defaultValue;
}

/**
 * Reads an integer input safely, with a default fallback.
 *
 * Returns 0 or a positive integer. If the input is invalid (e.g. negative, non-integer, or not a number), it returns the default value.
 * @param name Name of the task input to read.
 * @param defaultValue Default value to return if the input is missing or invalid. Must be a non-negative integer.
 * @returns Returns the parsed integer value from the task input, or the default value if the input is missing or invalid.
 */
function readInt(name: string, defaultValue: number): number {
  // Read the raw input value as a string, and trim whitespace. If it's empty or missing, return the default value.
  const raw = tl.getInput(name, false)?.trim();
  // If the raw input is empty or undefined, return the default value immediately.
  if (!raw) return defaultValue;

  // Parse the raw input into an integer. If it's not a valid integer or is negative, return the default value.
  const parsed = Number.parseInt(raw, 10);
  // Check if the parsed value is an integer and non-negative. If so, return it; otherwise, return the default value.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}
/**
 * Reads task inputs from task-lib.
 * Task-lib allows reading from environment variables in local/dev runs.
 */
export function readInputs(): TaskInputs {
  // Read and parse the additional prompts input as a comma-separated list, trimming whitespace and filtering out empty values.
  const additionalPrompts = (tl.getInput('additional_prompts', false) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Read the Azure API endpoint input. If it's empty, treat it as undefined (indicating OpenAI mode).
  const azureApiEndpoint = tl.getInput('api_endpoint', false) ?? undefined;

  // For prototype: keep using ai_model as BOTH:
  // - OpenAI "model" when no api_endpoint is provided
  // - Azure "deployment" when api_endpoint is provided
  const aiModelOrDeployment = tl.getInput('ai_model', true)!;

  // Construct the TaskInputs object with all the parsed and normalized inputs. This will be used by the main task logic.
  const inputs: TaskInputs = {
    apiKey: tl.getInput('api_key', true)!,
    azureApiEndpoint,
    azureApiVersion: tl.getInput('api_version', false) ?? undefined,

    // Prototype behavior: reuse ai_model as deployment in Azure mode.
    azureDeployment: azureApiEndpoint ? aiModelOrDeployment : undefined,

    // OpenAI model name (also reused for Azure deployment if desired).
    model: aiModelOrDeployment,

    fileExtensions: tl.getInput('file_extensions', false) ?? undefined,
    fileExtensionExcludes: tl.getInput('file_extension_excludes', false) ?? undefined,
    filesToInclude: tl.getInput('file_includes', false) ?? undefined,
    filesToExclude: tl.getInput('file_excludes', false) ?? undefined,

    additionalPrompts,

    bugs: tl.getBoolInput('bugs', false),
    performance: tl.getBoolInput('performance', false),
    bestPractices: tl.getBoolInput('best_practices', false),
    modifiedLinesOnly: tl.getBoolInput('modified_lines_only', false),
    enableCommentLineCorrection: tl.getBoolInput('comment_line_correction', false),
    allowRequeue: tl.getBoolInput('allow_requeue', false),

    confidenceMode: tl.getBoolInput('confidence_mode', false),

    // IMPORTANT: 0..1 scale. Prototype default = 0.9
    confidenceMinimum: readFloat('confidence_minimum', 0.9),

    dedupeAcrossFiles: tl.getBoolInput('dedupe_across_files', false),

    // IMPORTANT: 0..1 similarity threshold. Prototype default = 0.85
    dedupeAcrossFilesThreshold: readFloat('dedupe_across_files_threshold', 0.85),

    verboseLogging: tl.getBoolInput('verbose_logging', false),

    // Comment mode with a safe default. Prototype default = "file".
    commentMode: readEnum('comment_mode', ['file', 'inline', 'pr_summary'] as const, 'file'),

    /**
     * Maximum number of findings shown per file (file / pr_summary modes).
     * 0 or undefined = unlimited.
     */
    maxFindingsPerFile: readInt('max_findings_per_file', 0),
  };

  return inputs;
}
