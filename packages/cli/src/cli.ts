#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { OpenAI } from 'openai';
import simpleGit from 'simple-git';
import {
  reviewCode,
  ReviewInput,
  ReviewPolicy,
  OpenAiLlmClient,
  AzureOpenAiLlmClient,
  filterFilesForReview,
  FileDiff,
  LlmClient,
} from '@devops-ai-reviewer/core';

type OutputFormat = 'markdown' | 'json';
type Severity = 'low' | 'medium' | 'high' | 'critical';

/**
 * CLI arguments supported by the reviewer.
 *
 * Notes:
 * - You can run the CLI in 2 ways:
 *   1) Git mode: --base <sha> --head <sha> (collect diffs from git)
 *   2) Input mode: --input <payload.json> (replay exact ReviewInput used by API/Postman)
 */
interface CliArgs {
  /** Base commit SHA for Git mode. */
  base?: string;

  /** Head commit SHA for Git mode. */
  head?: string;

  /** Input file path for Input mode. */
  input?: string;

  /** Output format for printing the report. */
  format: OutputFormat;

  /** Exit with code 1 if any finding meets or exceeds this severity. */
  failOn: Severity;

  /** Optional: enable confidence filtering and set minimum confidence (0..1). */
  confidenceMin?: number;

  /** Optional: enable dedupe across files and set threshold (0..1). */
  dedupeThreshold?: number;

  /** Optional: include glob-like patterns (pass-through to filterFilesForReview if supported). */
  include?: string[];

  /** Optional: exclude glob-like patterns. */
  exclude?: string[];

  /** Optional: only include these extensions (e.g. ".ts,.cs"). */
  ext?: string[];

  /** Optional: maximum diff size per file in characters (guardrail). */
  maxDiffChars: number;
}

/**
 * Parses CLI arguments using a simple loop.
 *
 * Why this exists:
 * - Keeps the dependency footprint low (no yargs/commander required).
 * - Adequate for a small CLI surface.
 *
 * Improvement idea:
 * - Swap to a real parser later (commander) if you add many flags.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    format: 'markdown',
    failOn: 'high',
    maxDiffChars: 60_000, // reasonable default: avoids huge prompts/costs
  };

  // Simple loop to parse args.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Parse known flags.
    if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--format') args.format = (argv[++i] as OutputFormat) ?? 'markdown';
    else if (a === '--fail-on') args.failOn = (argv[++i] as Severity) ?? 'high';
    else if (a === '--confidence-min') args.confidenceMin = Number(argv[++i]);
    else if (a === '--dedupe-threshold') args.dedupeThreshold = Number(argv[++i]);
    else if (a === '--include') args.include = String(argv[++i]).split(',').filter(Boolean);
    else if (a === '--exclude') args.exclude = String(argv[++i]).split(',').filter(Boolean);
    else if (a === '--ext') args.ext = String(argv[++i]).split(',').filter(Boolean);
    else if (a === '--max-diff-chars') args.maxDiffChars = Number(argv[++i]);
  }

  // Validate format
  if (!['markdown', 'json'].includes(args.format)) {
    throw new Error(`Invalid --format "${args.format}". Use "markdown" or "json".`);
  }

  // Validate severity threshold
  if (!['low', 'medium', 'high', 'critical'].includes(args.failOn)) {
    throw new Error(`Invalid --fail-on "${args.failOn}". Use low|medium|high|critical.`);
  }

  // Validate confidenceMin if provided
  if (args.confidenceMin !== undefined && (Number.isNaN(args.confidenceMin) || args.confidenceMin < 0 || args.confidenceMin > 1)) {
    throw new Error(`Invalid --confidence-min "${args.confidenceMin}". Must be between 0 and 1.`);
  }

  // Validate dedupeThreshold if provided
  if (args.dedupeThreshold !== undefined && (Number.isNaN(args.dedupeThreshold) || args.dedupeThreshold < 0 || args.dedupeThreshold > 1)) {
    throw new Error(`Invalid --dedupe-threshold "${args.dedupeThreshold}". Must be between 0 and 1.`);
  }

  // Validate maxDiffChars
  if (Number.isNaN(args.maxDiffChars) || args.maxDiffChars < 1_000) {
    throw new Error(`Invalid --max-diff-chars "${args.maxDiffChars}". Must be >= 1000.`);
  }

  // Validate mode: either Input mode OR Git mode
  const usingInputMode = !!args.input;
  const usingGitMode = !!args.base && !!args.head;

  if (!usingInputMode && !usingGitMode) {
    throw new Error(
      [
        'Usage:',
        '  review-cli --base <sha> --head <sha> [options]',
        '  review-cli --input <reviewInput.json> [options]',
        '',
        'Options:',
        '  --format markdown|json',
        '  --fail-on low|medium|high|critical',
        '  --confidence-min 0..1',
        '  --dedupe-threshold 0..1',
        '  --include pattern1,pattern2',
        '  --exclude pattern1,pattern2',
        '  --ext .ts,.js,.cs',
        '  --max-diff-chars 60000',
      ].join('\n')
    );
  }

  if (usingInputMode && usingGitMode) {
    throw new Error('Choose either --input OR (--base and --head), not both.');
  }

  return args;
}

/**
 * Creates the correct LLM client based on environment variables.
 *
 * Supports:
 * - OpenAI (OPENAI_API_KEY)
 * - Azure OpenAI (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_DEPLOYMENT + AZURE_OPENAI_KEY)
 *
 * Note:
 * - This matches your API server behavior so CLI tests are comparable.
 */
function createLlmClient(): LlmClient {
  const apiKey = process.env.OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

  // Azure OpenAI path
  if (azureEndpoint && azureDeployment) {
    const client = new OpenAI({
      apiKey: apiKey ?? process.env.AZURE_OPENAI_KEY,
      baseURL: `${azureEndpoint}/openai/deployments/${azureDeployment}`,
      defaultQuery: { 'api-version': azureApiVersion ?? '2024-10-21' },
      defaultHeaders: { 'api-key': apiKey ?? process.env.AZURE_OPENAI_KEY ?? '' },
    });

    return new AzureOpenAiLlmClient(client, { model });
  }

  // OpenAI path
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required (or Azure env vars for Azure OpenAI).');
  }

  return new OpenAiLlmClient(new OpenAI({ apiKey }), { model });
}

/**
 * Collects per-file unified diffs between the given commits.
 *
 * Implementation notes:
 * - Uses `git diff base..head -- file` for reliability.
 * - Returns file paths AND file diffs.
 *
 * @param base Base commit SHA
 * @param head Head commit SHA
 */
async function collectDiffs(base: string, head: string): Promise<{ files: FileDiff[]; paths: string[] }> {
  const git = simpleGit();

  // List changed files between the commits.
  const paths = (await git.diff(['--name-only', `${base}..${head}`]))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const diffs: FileDiff[] = [];

  // Collect a per-file diff. (This is slower than one big diff, but easier to map to threads.)
  for (const p of paths) {
    const diff = await git.diff([`${base}..${head}`, '--', p]);
    diffs.push({ path: p, diff, changeType: 'edit' });
  }

  return { files: diffs, paths };
}

/**
 * Builds a default review policy for CLI runs.
 *
 * Why:
 * - Keeps CLI behavior stable and predictable.
 * - Lets flags override specific pieces (confidence, dedupe, etc.).
 *
 * @param args CLI args (used to optionally enable confidence/dedupe)
 */
function buildPolicy(args: CliArgs): ReviewPolicy {
  const confidenceEnabled = args.confidenceMin !== undefined;
  const dedupeEnabled = args.dedupeThreshold !== undefined;

  return {
    checks: { bugs: true, performance: true, bestPractices: true },
    modifiedLinesOnly: true,
    confidence: { enabled: confidenceEnabled, minimum: args.confidenceMin ?? 0 },
    dedupeAcrossFiles: { enabled: dedupeEnabled, threshold: args.dedupeThreshold ?? 0.85 },
    prompts: { additional: [] },
  };
}

/**
 * Formats a report to a compact markdown block suitable for terminals or CI logs.
 *
 * Tip:
 * - You can later improve this to group by file and category, or output a summary table.
 *
 * @param report ReviewReport-like output from core
 */
function formatMarkdown(report: any): string {
  const lines: string[] = [`## AI Review`, report.summaryMarkdown, ''];

  for (const finding of report.findings ?? []) {
    const sev = String(finding.severity ?? '').toUpperCase();
    const loc = `${finding.filePath}:${finding.lineStart ?? 0}`;
    lines.push(`- [${sev}] ${loc} — ${finding.content}`);
  }

  return lines.join('\n');
}

/**
 * Returns true if a finding severity meets or exceeds the requested threshold.
 *
 * @param severity Finding severity (low|medium|high|critical)
 * @param threshold CLI threshold (low|medium|high|critical)
 */
function severityMeetsThreshold(severity: string, threshold: string): boolean {
  const order: Severity[] = ['low', 'medium', 'high', 'critical'];
  const sevIndex = order.indexOf((severity ?? '').toLowerCase() as Severity);
  const thresholdIndex = order.indexOf((threshold ?? '').toLowerCase() as Severity);

  // If severity is unknown, treat it as non-blocking.
  if (sevIndex === -1 || thresholdIndex === -1) return false;

  return sevIndex >= thresholdIndex;
}

/**
 * Loads a ReviewInput from a JSON file (Input mode).
 *
 * Why this matters:
 * - Lets you replay the exact same payload used in Postman/API.
 * - Perfect for validating that CLI and API behave consistently.
 *
 * @param inputPath Path to a JSON file containing ReviewInput
 */
function loadReviewInputFromFile(inputPath: string): ReviewInput {
  const resolved = path.resolve(process.cwd(), inputPath);
  const raw = fs.readFileSync(resolved, 'utf-8');
  const parsed = JSON.parse(raw);

  return parsed as ReviewInput;
}

/**
 * Applies file filtering and diff-size guardrails.
 *
 * Why:
 * - Prevents very large diffs from blowing up prompt size/cost.
 * - Ensures CLI aligns with extension filtering behavior.
 *
 * @param allDiffs All collected diffs
 * @param args CLI args for filtering and max diff size
 */
function filterAndClampDiffs(allDiffs: FileDiff[], args: CliArgs): FileDiff[] {
  // Apply file filter (extensions/include/exclude if you wire them in later).
  const allPaths = allDiffs.map((d) => d.path);

  const filteredPaths = filterFilesForReview({
    files: allPaths,
    // These fields exist in your older repo’s filter; include if your core supports them:
    // fileExtensions: args.ext,
    // filesToInclude: args.include,
    // filesToExclude: args.exclude,
  });

  const allowed = new Set(filteredPaths);

  // Filter diffs and clamp size.
  const filtered = allDiffs
    .filter((d) => allowed.has(d.path))
    .map((d) => {
      if (d.diff.length <= args.maxDiffChars) return d;

      // Clamp extremely large diffs to avoid runaway prompt sizes.
      // Note: This may reduce review quality for massive files, but keeps CLI usable.
      const truncated = d.diff.slice(0, args.maxDiffChars) + `\n... [diff truncated to ${args.maxDiffChars} chars]\n`;
      return { ...d, diff: truncated };
    });

  return filtered;
}

/**
 * CLI entry point:
 * - Parse args
 * - Create LLM client
 * - Build ReviewInput (from git OR from input JSON)
 * - Call core reviewCode
 * - Print output
 * - Set exit code based on --fail-on
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const llmClient = createLlmClient();
  const policy = buildPolicy(args);

  let reviewInput: ReviewInput;

  // Mode A: Input mode (replay exact payloads from API tests)
  if (args.input) {
    reviewInput = loadReviewInputFromFile(args.input);

    // Optionally override policy from flags to keep CLI consistent with your runs.
    // (Only override if the user provided flags.)
    if (args.confidenceMin !== undefined) {
      reviewInput.policy.confidence.enabled = true;
      reviewInput.policy.confidence.minimum = args.confidenceMin;
    }
    if (args.dedupeThreshold !== undefined) {
      reviewInput.policy.dedupeAcrossFiles.enabled = true;
      reviewInput.policy.dedupeAcrossFiles.threshold = args.dedupeThreshold;
    }
  } else {
    // Mode B: Git mode (collect diffs from local repo)
    const { files } = await collectDiffs(args.base!, args.head!);
    const filteredDiffs = filterAndClampDiffs(files, args);

    // Build ReviewInput for core.
    reviewInput = {
      target: {
        provider: 'cli',
        repository: { name: process.cwd() },
        commits: { base: args.base, head: args.head },
      },
      files: filteredDiffs,
      policy,
      previousComments: [],
    };
  }

  // Run the core review engine.
  const report = await reviewCode(reviewInput, llmClient);

  // Print in requested format.
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdown(report));
  }

  // Set exit code based on severity threshold.
  const hasBlocking = (report.findings ?? []).some((f: any) => severityMeetsThreshold(f.severity, args.failOn));
  if (hasBlocking) {
    process.exitCode = 1;
  }
}

/**
 * Run the CLI main function and handle uncaught errors.
 */
main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
