import * as tl from 'azure-pipelines-task-lib/task';
import { AzureDevOpsClient } from './azureDevOpsClient';
import { PreviousComment } from '@devops-ai-reviewer/core';

/**
 * Range of PR iterations to compare:
 * - start: previously reviewed iteration id
 * - end: latest iteration id to review now
 */
export interface IterationRange {
  start: number;
  end: number;
}

/**
 * Represents a file changed in a specific PR iteration.
 */
export interface IterationFileChange {
  /** Server-side path, typically starts with "/". Example: "/Src/Web/..." */
  path: string;
  /** ADO-internal id used to bind comments to PR changes. */
  changeTrackingId?: number;
}

/**
 * Thin wrapper around Azure DevOps Pull Request REST APIs.
 *
 * Responsibilities:
 * - Determine current PR context from pipeline variables
 * - Read PR iterations / changed files in a range
 * - Read and store custom PR properties (last reviewed iteration)
 * - Read existing file comments for dedupe
 * - Publish review threads
 *
 * Notes:
 * - This class assumes it runs in an Azure Pipelines PR validation build.
 * - Requires `System.AccessToken` (enable: "Allow scripts to access OAuth token").
 */
export class AdoPullRequest {
  /** Base org collection URI, e.g. https://dev.azure.com/myorg/ */
  private readonly collectionUri = tl.getVariable('System.TeamFoundationCollectionUri')!;

  /** Project ID (GUID). Used in REST URLs. */
  private readonly teamProjectId = tl.getVariable('System.TeamProjectId')!;

  /** Repository name ("ProjectName/RepoName" or "RepoName" depending on pipeline). */
  private readonly repositoryName = tl.getVariable('Build.Repository.Name')!;

  /** Pull request ID as string. */
  private readonly pullRequestId = tl.getVariable('System.PullRequest.PullRequestId')!;

  /** HTTP client that injects OAuth token and headers. */
  private readonly ado = new AzureDevOpsClient();

  /** Simple in-memory cache to avoid re-fetching PR metadata. */
  private pullRequestCache: any;

  /** Custom PR property key to store last reviewed iteration range. */
  private static readonly LAST_REVIEWED_KEY = 'Pria.LastReviewedIteration';

  /** Returns current repo name from pipeline context. */
  public getRepositoryName(): string {
    return this.repositoryName;
  }

  /** Returns current pull request id from pipeline context. */
  public getPullRequestId(): string {
    return this.pullRequestId;
  }

  /**
   * Fetches PR metadata once and caches it (useful for debugging or later extensions).
   */
  public async getPullRequest(): Promise<any> {
    if (this.pullRequestCache) return this.pullRequestCache;
    const endpoint = `${this.getPullRequestBaseUri()}/?api-version=7.0`;
    this.pullRequestCache = await this.ado.get(endpoint);
    return this.pullRequestCache;
  }

  /**
   * Returns the latest PR iteration id.
   *
   * Iterations increase with each push/update to the PR.
   */
  public async getLatestIterationId(): Promise<number> {
    const endpoint = `${this.getPullRequestBaseUri()}/iterations?api-version=7.0`;
    const iterations = await this.ado.get<{ value: { id: number }[] }>(endpoint);

    // Defensive: if no iterations, default to 0
    const ids = iterations.value?.map((i) => i.id) ?? [];
    return ids.length ? Math.max(...ids) : 0;
  }

  /**
   * Gets the list of files changed in the specified iteration range.
   * @param range Range of iterations to compare.
   * @returns Promise resolving to array of changed files in the range.
   */
  public async getIterationFiles(range: IterationRange): Promise<IterationFileChange[]> {
    const endpoint =
      `${this.getPullRequestBaseUri()}/iterations/${range.end}/changes` +
      `?api-version=7.0&$compareTo=${range.start}`;
    // Note: ADO API returns all changes in the "end" iteration, but we can use $compareTo to get the diff since "start".
    // For more complex scenarios (e.g. multiple iterations with different files), you may need to fetch each iteration's changes and compute the union.
    // For prototype, we assume linear iteration history and use $compareTo for simplicity.
    // In practice, you may want to handle pagination if there are many changes, but for typical PRs this should be manageable in one call.
    // Also, the API returns a lot of metadata; we only extract the file path and changeTrackingId for comment binding.
    // For debugging, log the raw API response to understand its structure and ensure we are accessing the right properties.
    // Example response structure:
    // {
    //   "changeEntries": [
    //     {
    //       "changeTrackingId": 12345,
    //       "item": {
    //         "path": "/Src/Web/Controllers/HomeController.cs"
    //       }
    //     },
    //     ...
    //   ]
    // } 

    const result = await this.ado.get<{
      changeEntries: Array<{
        changeTrackingId?: number;
        item?: { path?: string | null };
      }>;
    }>(endpoint);

    // Log the raw API response for debugging purposes.
    tl.debug(`getIterationFiles API response: ${JSON.stringify(result)}`);

    // Map the API response to our IterationFileChange format, filtering out entries without valid paths.
    return (result.changeEntries ?? [])
      .map((c) => ({
        path: (c.item?.path ?? '').trim(),
        changeTrackingId: c.changeTrackingId,
      }))
      .filter((x) => x.path.length > 0);
  }

  /**
   * Reads the last reviewed iteration range stored in PR properties.
   * If missing, returns { start: 0, end: 0 } (meaning "nothing reviewed yet").
   */
  public async getLastReviewedIteration(): Promise<IterationRange> {
    // Init PR properties endpoint
    const endpoint = `${this.getPullRequestBaseUri()}/properties?api-version=7.0`;
    // Fetch all properties and look for our specific key
    const properties = await this.ado.get<{ value: Record<string, { $value: string }> }>(endpoint);
    // If the property is missing or empty, default to { start: 0, end: 0 }
    const value = properties.value?.[AdoPullRequest.LAST_REVIEWED_KEY]?.$value;
    if (!value) return { start: 0, end: 0 };

    try {
      // Parse the JSON string back to IterationRange
      return JSON.parse(value) as IterationRange;
    } catch {
      // If the property got corrupted, fall back safely.
      return { start: 0, end: 0 };
    }
  }

  /**
   * Saves the last reviewed iteration range in PR properties.
   * This enables incremental reviews (only new changes since last run).
   */
  public async saveLastReviewedIteration(range: IterationRange): Promise<void> {
    // Endpoint to update PR properties
    const endpoint = `${this.getPullRequestBaseUri()}/properties?api-version=7.0`;

    // JSON Patch format required by ADO for PR properties.
    const body = [
      {
        op: 'replace',
        path: `/${AdoPullRequest.LAST_REVIEWED_KEY}`,
        value: JSON.stringify(range),
      },
    ];
    // Send the PATCH request to update the property. ADO will create it if it doesn't exist.
    await this.ado.patch(endpoint, body);
  }

  /**
   * Returns existing PR comments for a specific file to aid dedupe.
   *
   * Important: This is potentially expensive because it:
   * - fetches all threads
   * - then fetches comments for matching threads
   *
   * Prototype OK, but for scale you’ll want:
   * - fetch comments in fewer calls, or
   * - only read "your bot" comments, or
   * - cache thread comments.
   */
  public async getCommentsForFile(fileName: string): Promise<PreviousComment[]> {
    // Normalize file path to ensure it starts with "/"
    const normalized = fileName.startsWith('/') ? fileName : `/${fileName}`;
    // Fetch all threads and filter those that are related to the specified file.
    const threads = await this.getThreads();
    // For each matching thread, fetch its comments and extract relevant info for deduplication.
    const comments: PreviousComment[] = [];
    // Iterate through threads to find those that are associated with the target file path. The threadContext.filePath is used to determine this association.
    for (const thread of threads) {
      if (thread.threadContext?.filePath === normalized) {
        const threadComments = await this.getComments(thread);
        for (const comment of (threadComments.value as any[]) ?? []) {
          comments.push({
            content: comment.content,
            filePath: normalized,
            id: String(comment.id),
          });
        }
      }
    }

    return comments;
  }

  /**
   * Returns existing comments across multiple files for dedupe.
   * Prototype implementation uses sequential calls; can be parallelized later.
   */
  public async getCommentsForFiles(files: string[]): Promise<PreviousComment[]> {
    // Sequentially fetch comments for each file and aggregate results. For better performance, consider parallelizing these calls with Promise.all, but be mindful of API rate limits.
    const results: PreviousComment[] = [];
    // Iterate through the list of files and fetch comments for each file, accumulating them into a single array.
    for (const file of files) {
      const comments = await this.getCommentsForFile(file);
      results.push(...comments);
    }
    return results;
  }

  /**
   * Adds a new comment thread to the PR.
   *
   * The thread object must follow ADO's expected format, including:
   * - threadContext with filePath and optional changeTrackingId for binding to specific changes.
   * - comments array with at least one comment containing content and commentType.
   * @param thread Thread object to post, following ADO's API schema. Example:
   * @returns Promise resolving to true if the thread was added successfully, or throws an error if the API call failed.
   */
  public async addThread(thread: any): Promise<boolean> {
    const endpoint = `${this.getPullRequestBaseUri()}/threads?api-version=7.0`;

    // Helpful debug: show minimal info about the thread (not the full content)
    tl.debug(
      `addThread(): filePath=${thread?.threadContext?.filePath ?? 'none'} ` +
      `commentType=${thread?.comments?.[0]?.commentType ?? 'unknown'}`
    );

    // Post the thread to ADO
    const response = await this.ado.post(endpoint, thread);

    // If failed, read body once for diagnostics
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      // Log a warning with status and body for troubleshooting. This can help identify issues like permission errors or payload problems.
      tl.warning(
        `ADO request failed: POST ${endpoint} -> ${response.status} ${response.statusText}\n${bodyText}`
      );

      // Handle common permission-related errors with specific messages to guide the user in troubleshooting access issues.
      if (response.status === 401) {
        tl.setResult(
          tl.TaskResult.Failed,
          "The Build Service must have 'Contribute to pull requests' access to the repository."
        );
      }

      // 403 can indicate missing permissions or that the OAuth token is not properly configured. Provide guidance on what to check.
      if (response.status === 403) {
        tl.setResult(
          tl.TaskResult.Failed,
          "403 Forbidden when posting PR threads. Ensure Build Service has 'Contribute' + 'Contribute to pull requests' permissions and OAuth token access is enabled."
        );
      }

      // IMPORTANT: fail the task by throwing so it doesn't show Succeeded
      throw new Error(`Failed to publish PR thread (${response.status} ${response.statusText}).`);
    }

    return true;
  }


  /**
   * Computes the iteration window to review and detects requeue scenarios.
   *
   * Requeue happens when the build is rerun without new commits:
   * - lastReviewed.end === latest
   */
  public async computeReviewRange(): Promise<{ reviewRange: IterationRange; isRequeued: boolean }> {
    // Fetch the last reviewed iteration range and the latest iteration id to determine what changes to review.
    const lastReviewed = await this.getLastReviewedIteration();
    // If the PR has no iterations yet, both lastReviewed and latest will be 0, resulting in an empty review range, which is the expected behavior for a new PR.
    const latest = await this.getLatestIterationId();

    // Default behavior: only review changes since last reviewed end.
    let reviewRange: IterationRange = { start: lastReviewed.end, end: latest };
    // Detect requeue scenario: if the build is rerun without new commits, the latest iteration will be the same as last reviewed end. In this case, we want to review the same range again to allow retrying the review process (e.g. if it failed mid-way).
    const isRequeued = lastReviewed.end === latest;

    // If requeued, review the same range again (useful if previous run failed mid-way).
    if (isRequeued) {
      reviewRange = { ...lastReviewed };
    }
    // Return both the computed review range and whether this is a requeue scenario, so the caller can decide how to handle it (e.g. log a message about requeue).
    return { reviewRange, isRequeued };
  }

  /** Fetches all PR threads that are file-scoped (threadContext != null). */
  private async getThreads(): Promise<any[]> {
    const endpoint = `${this.getPullRequestBaseUri()}/threads?api-version=7.0`;
    const threads = await this.ado.get<{ value: any[] }>(endpoint);
    return (threads.value ?? []).filter((t) => t.threadContext !== null);
  }

  /** Fetches thread comments for a given thread id. */
  private async getComments(thread: any): Promise<any> {
    const endpoint = `${this.getPullRequestBaseUri()}/threads/${thread.id}/comments?api-version=7.0`;
    return this.ado.get(endpoint);
  }

  /**
   * Builds the base PR REST API URL used by all methods in this class.
   *
   * Example:
   * https://dev.azure.com/org/{projectId}/_apis/git/repositories/{repo}/pullRequests/{prId}
   */
  private getPullRequestBaseUri(): string {
    return `${this.collectionUri}${this.teamProjectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}`;
  }
}