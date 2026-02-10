import * as tl from 'azure-pipelines-task-lib/task';
import { reviewCode, ReviewInput, ReviewPolicy, filterFilesForReview, OpenAiLlmClient, AzureOpenAiLlmClient } from '@devops-ai-reviewer/core';
import { OpenAI } from 'openai';
import { readInputs } from './inputs';
import { AdoRepository } from './adoRepository';
import { AdoPullRequest } from './adoPullRequest';
import { Publisher } from './publisher';
import { log } from 'console';

/**
 * Ensures that the task is running in a valid context with required permissions.
 * @returns Whether prerequisites are met.
 */
function ensurePrerequisites(): boolean {
  // Check if running in a Pull Request build.
  if (tl.getVariable('Build.Reason') !== 'PullRequest') {
    // Not a PR build; skip the task.
    tl.setResult(tl.TaskResult.Skipped, 'This task must only run for Pull Request builds.');
    // Exit early.
    return false;
  }
  // Check if OAuth token access is enabled.
  if (!tl.getVariable('System.AccessToken')) {
    // OAuth token not available; likely not enabled.
    tl.setResult(
      // Exit with failure.
      tl.TaskResult.Failed,
      "'Allow Scripts to Access OAuth Token' must be enabled for this task to run."
    );
    return false;
  }
  return true;
}

/**
 * Builds the review policy from task inputs.
 * @param inputs Inputs read from task.
 * @returns The built review policy.
 */
function buildPolicy(inputs: ReturnType<typeof readInputs>): ReviewPolicy {
  return {
    checks: { bugs: inputs.bugs, performance: inputs.performance, bestPractices: inputs.bestPractices },
    modifiedLinesOnly: inputs.modifiedLinesOnly,
    confidence: { enabled: inputs.confidenceMode, minimum: inputs.confidenceMinimum },
    dedupeAcrossFiles: { enabled: inputs.dedupeAcrossFiles, threshold: inputs.dedupeAcrossFilesThreshold },
    prompts: { additional: inputs.additionalPrompts },
  };
}

/**
 * Creates an LLM client using either:
 * - OpenAI public API (api_endpoint not set)
 * - Azure OpenAI (api_endpoint set; uses deployment)
 */
function createLlmClient(inputs: ReturnType<typeof readInputs>) {
  // Azure OpenAI mode
  if (inputs.azureApiEndpoint) {
    // Ensure deployment name is provided
    if (!inputs.azureDeployment) {
      // For prototype: reuse ai_model as deployment
      throw new Error('Azure OpenAI mode requires a deployment name (ai_model used as deployment in prototype).');
    }

    // Create OpenAI client configured for Azure OpenAI.
    const client = new OpenAI({
      apiKey: inputs.apiKey,
      baseURL: `${inputs.azureApiEndpoint}/openai/deployments/${inputs.azureDeployment}`,
      defaultQuery: { 'api-version': inputs.azureApiVersion ?? '2024-10-21' },
      defaultHeaders: { 'api-key': inputs.apiKey },
    });

    // In Azure mode, `model` often still needs to be set to the deployment name for the SDK call.
    return new AzureOpenAiLlmClient(client, { model: inputs.model });
  }

  // OpenAI public API mode
  const client = new OpenAI({ apiKey: inputs.apiKey });
  // Create and return OpenAiLlmClient.
  return new OpenAiLlmClient(client, { model: inputs.model });
}

/**
 * Utility to log debug message if verbose logging is enabled.
 * @param verbose Verbose flag.
 * @param message Message to log.
 */
function logIfVerbose(verbose: boolean, message: string) {
  if (verbose) tl.debug(message);
}

/**
 * Runs the main task logic.
 * @returns Result promise.
 */
async function run(): Promise<void> {
  try {
    // Log the start of the task.
    tl.debug('Starting DevOps AI Code Reviewer task...');
    // Ensure prerequisites are met.
    if (!ensurePrerequisites()) {
      // Prerequisites not met; task result already set. Exit early. 
      tl.debug('Prerequisites not met; exiting task.');
      return;
    }

    // Read inputs and build policy.
    tl.debug('Reading task inputs...');
    const inputs = readInputs();
    tl.debug('Building review policy from inputs...');
    const policy = buildPolicy(inputs);

    // Log configuration if verbose logging is enabled.
    logIfVerbose(inputs.verboseLogging, `Build.Reason=${tl.getVariable('Build.Reason')}`);
    logIfVerbose(inputs.verboseLogging, `Has System.AccessToken=${Boolean(tl.getVariable('System.AccessToken'))}`);
    logIfVerbose(inputs.verboseLogging, `Model=${inputs.model} AzureEndpoint=${inputs.azureApiEndpoint ?? 'none'}`);
    logIfVerbose(inputs.verboseLogging, `Checks=${JSON.stringify(policy.checks)}`);
    logIfVerbose(inputs.verboseLogging, `Filters includes="${inputs.filesToInclude ?? ''}" excludes="${inputs.filesToExclude ?? ''}"`);
    logIfVerbose(inputs.verboseLogging, `modifiedLinesOnly=${policy.modifiedLinesOnly} allowRequeue=${inputs.allowRequeue}`);
    logIfVerbose(inputs.verboseLogging, `confidence=${JSON.stringify(policy.confidence)} dedupe=${JSON.stringify(policy.dedupeAcrossFiles)}`);

    // Initialize repository helper.
    tl.debug('Initializing repository helper...');
    const repo = new AdoRepository();
    await repo.init();

    // Initialize PR helper.
    const pr = new AdoPullRequest();
    const { reviewRange, isRequeued } = await pr.computeReviewRange();
    // Log review range and requeue status.
    logIfVerbose(inputs.verboseLogging, `ReviewRange=${JSON.stringify(reviewRange)} isRequeued=${isRequeued}`);
    // If this is a requeue with no new iterations to review, exit early.
    if (isRequeued && !inputs.allowRequeue) {
      tl.warning('No new iterations to review and requeue not allowed; exiting task.');
      tl.setResult(tl.TaskResult.Succeeded, 'No new changes detected; skipping review.');
      return;
    }

    // Get changed files in the iteration range.
    const iterationChanges = await pr.getIterationFiles(reviewRange);
    // Log the number of changed files in the iteration range.
    logIfVerbose(inputs.verboseLogging, `Iteration changes retrieved: ${iterationChanges.length} files`);
    // Log the changed files in detail if verbose logging is enabled.
    logIfVerbose(inputs.verboseLogging, `Iteration changes details: ${iterationChanges.map(c => `${c.path} (changeId=${c.changeTrackingId})`).join(', ')}`);

    const iterationFiles = iterationChanges.map(x => x.path);
    // Log the iteration files retrieved.
    logIfVerbose(inputs.verboseLogging, `Iteration files retrieved: ${iterationFiles.length} files`);
    // Log the iteration files in detail if verbose logging is enabled.
    logIfVerbose(inputs.verboseLogging, `Iteration files details: ${iterationFiles.join(', ')}`);

    // Keep a lookup for publishing:
    const changeIdByPath = new Map(iterationChanges.map(x => [x.path, x.changeTrackingId]));

    // Filter files based on inputs.
    const filesToReview = filterFilesForReview({
      fileExtensions: inputs.fileExtensions,
      fileExtensionExcludes: inputs.fileExtensionExcludes,
      filesToInclude: inputs.filesToInclude,
      filesToExclude: inputs.filesToExclude,
      files: iterationFiles,
    });

    // Log file counts.
    logIfVerbose(inputs.verboseLogging, `Iteration files=${iterationFiles.length}`);
    // Log the number of files selected for review.
    logIfVerbose(inputs.verboseLogging, `Files to review=${filesToReview.length}`);
    // If no files to review, log a warning but continue to create an empty review (could be useful for policy checks or comments not tied to specific files).
    if (filesToReview.length === 0) {
      tl.warning("No files selected for review (filters excluded everything or PR has no changed files in range).");
    }

    // If no files to review, exit early.
    const diffs = await repo.getDiffs(filesToReview);
    // Log the number of diffs found for the files to review.
    logIfVerbose(inputs.verboseLogging, `Diffs=${diffs.length}`);
    // Log diffes
    logIfVerbose(inputs.verboseLogging, `Diffs details: ${diffs.map(d => `${d.path} (${d.diff.length} chars)`).join(', ')}`);
    // Log diffs in JSON format for easier parsing.
    logIfVerbose(inputs.verboseLogging, `Diffs JSON: ${JSON.stringify(diffs.map(d => ({ path: d.path, diffLength: d.diff.length })))}`);
    // If no diffs, log a warning but continue to create an empty review (could be useful for policy checks or comments not tied to specific files).
    if (diffs.length === 0) {
      tl.warning("No diffs found for selected files (nothing to review).");
    }

    // Get previous comments for the files to review, to provide context and avoid duplicates.
    const previousComments = await pr.getCommentsForFiles(filesToReview);
    // Log the number of previous comments found for the files to review.
    logIfVerbose(inputs.verboseLogging, `Calling reviewCode() with files=${diffs.length}, previousComments=${previousComments.length}`);

    // Build review input.
    const reviewInput: ReviewInput = {
      target: {
        provider: 'azure-devops',
        repository: { name: pr.getRepositoryName() },
        pullRequest: {
          id: pr.getPullRequestId(),
          iteration: reviewRange,
          targetBranch: tl.getVariable('System.PullRequest.TargetBranch'),
          sourceBranch: tl.getVariable('System.PullRequest.SourceBranch'),
        },
      },
      files: diffs.map((d) => ({ path: d.path, diff: d.diff })),
      policy,
      previousComments,
    };
    // Log the constructed review input for debugging (excluding diffs and comments for brevity).
    logIfVerbose(inputs.verboseLogging, `Constructed review input: target=${JSON.stringify(reviewInput.target)} policy=${JSON.stringify(reviewInput.policy)} previousComments=${reviewInput.previousComments?.length}`);

    // Create LLM client.
    const llmClient = createLlmClient(inputs);
    // Perform code review.
    const report = await reviewCode(reviewInput, llmClient);
    // Log the keys of the generated report for debugging.
    logIfVerbose(inputs.verboseLogging, `reviewCode() returned report keys: ${Object.keys(report ?? {}).join(', ')}`);


    // If report is empty, still leave a breadcrumb.
    const reportIsEmpty =
      !report ||
      (Array.isArray((report as any).comments) && (report as any).comments.length === 0) &&
      (Array.isArray((report as any).findings) && (report as any).findings.length === 0);
    // Log if the report appears empty.
    if (reportIsEmpty) {
      tl.warning("Review completed but report appears empty (no findings).");
    }

    // Publish review report to PR.
    const publisher = new Publisher(pr, changeIdByPath, inputs.commentMode, {
      maxFindingsPerFile: inputs.maxFindingsPerFile,
      includeConfidence: true,
    });
    // Publish the report.
    await publisher.publish(report);

    // Save last reviewed iteration.
    await pr.saveLastReviewedIteration(reviewRange);
    // Set task result.
    tl.setResult(tl.TaskResult.Succeeded, 'Pull Request reviewed.');
  } catch (error: any) {
    tl.setResult(tl.TaskResult.Failed, error?.message ?? 'Unexpected error');
  }
}

// Start the task.
run();
