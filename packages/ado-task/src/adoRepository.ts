import * as tl from 'azure-pipelines-task-lib/task';
import { SimpleGit, simpleGit, SimpleGitOptions } from 'simple-git';

/**
 * Git helper used inside an Azure Pipelines PR build.
 *
 * Responsibilities:
 * - Ensure enough history exists to compute merge-base (3-dot diff)
 * - Ensure the PR target branch ref exists locally (origin/<target>)
 * - Produce unified diffs per file
 *
 * Key ADO gotcha:
 * - Pipelines checkout is often shallow (fetchDepth=1). That breaks merge-base.
 *   You should set `checkout: self fetchDepth: 0` in YAML.
 *   This class also tries to recover by unshallowing / deepening.
 */
export class AdoRepository {
  /** Git instance */
  private readonly git: SimpleGit;

  constructor() {
    // Initialize simple-git with the pipeline's default working directory.
    const gitOptions: Partial<SimpleGitOptions> = {
      baseDir: `${tl.getVariable('System.DefaultWorkingDirectory')}`,
      binary: 'git',
    };
    // Create the simple-git instance with the specified options.
    this.git = simpleGit(gitOptions);

    // Avoid paging and escape sequences that make parsing harder.
    this.git.addConfig('core.pager', 'cat');
    this.git.addConfig('core.quotepath', 'false');
  }

  /**
     * Ensures the target branch remote ref exists locally.
     *
     * Why:
     * - In PR validation, Azure Pipelines often checks out a PR ref with shallow history.
     * - `origin/<target>` may NOT exist locally, causing:
     *   "fatal: bad revision 'origin/dev...HEAD'"
     */
  async init(): Promise<void> {
    // Ensure we have enough history to compute merge-base for the PR diff.
    const targetShort = this.getTargetBranchShortName(); // "dev"
    // The remote-tracking ref we want to ensure exists, e.g. "refs/remotes/origin/dev".
    const remoteRef = `refs/remotes/origin/${targetShort}`;

    // Fetch only the target branch we need, and force-update the remote-tracking ref.
    // This guarantees origin/<target> exists for `origin/<target>...HEAD`.
    await this.git.fetch('origin', `+refs/heads/${targetShort}:${remoteRef}`);

    // Optional: also fetch tags if you ever rely on them
    // await this.git.fetch(['--tags']);
  }

  /**
   * Gets PR target branch short name (e.g. "dev").
   */
  private getTargetBranchShortName(): string {
    // First try the short name variable (e.g. "dev" or "main").
    let target = tl.getVariable('System.PullRequest.TargetBranchName');

    // Fallback to the full ref if short name is not available, and extract the branch name.
    if (!target) {
      target = tl.getVariable('System.PullRequest.TargetBranch')?.replace('refs/heads/', '');
    }
    // If still not found, throw an error. This is critical for the task to function, so we want to fail fast with a clear message.
    if (!target) {
      throw new Error('Could not determine target branch');
    }

    return target;
  }


  /**
   * Returns a unified diff for a file, scoped to PR changes.
   *
   * Preferred strategy:
   * - Use a three-dot diff (`origin/target...HEAD`) so git uses merge-base
   *   and returns only changes introduced by the PR branch/merge.
   *
   * Fallback:
   * - If merge-base still cannot be computed, fall back to two-dot diff
   *   (`origin/target..HEAD`) which compares tips directly.
   *
   * @param filePath Path that may start with "/" (ADO uses "/Src/...").
   */
  async getDiff(filePath: string): Promise<string> {
    // Normalize file path by removing leading slash if present, since git diff expects relative paths.
    const normalized = filePath.replace(/^\//, '');
    // Get the target branch ref (e.g. "origin/dev") to use in the diff command.
    const targetRef = this.getTargetBranch();

    // Try merge-base diff first (best for PR reviews)
    try {
      return await this.git.diff([`${targetRef}...HEAD`, '--', normalized]);
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      // Typical: "no merge base" => shallow or missing history
      if (msg.includes('no merge base')) {
        tl.warning(`No merge-base for ${targetRef}...HEAD. Falling back to ${targetRef}..HEAD for ${normalized}`);
        return await this.git.diff([`${targetRef}..HEAD`, '--', normalized]);
      }

      throw e;
    }
  }

  /**
   * Collects diffs for multiple files. Sequential by default (safe for rate limits).
   */
  async getDiffs(filePaths: string[]): Promise<{ path: string; diff: string }[]> {
    // Collect diffs sequentially to avoid overwhelming the system or hitting rate limits. For large PRs, consider parallelizing with a concurrency limit.
    const results: { path: string; diff: string }[] = [];
    // Iterate over each file path, get its diff, and store the result in an array. This allows us to return all diffs together.
    for (const file of filePaths) {
      const diff = await this.getDiff(file);
      results.push({ path: file, diff });
    }
    return results;
  }

  /**
   * Tries to ensure Git has enough history to compute merge-base.
   *
   * Strategy:
   * - If the repo is shallow, try `--unshallow`
   * - If that fails (some setups), deepen history as a fallback
   */
  private async ensureHistoryIsSufficient(): Promise<void> {
    // Check if the repository is shallow. If not, we can skip the fetch.
    const isShallow = await this.isRepoShallow();
    // If the repo is not shallow, we should have enough history to compute merge-base, so we can return early.
    if (!isShallow) return;

    tl.debug('Repository is shallow. Attempting to unshallow/deepen history...');

    // Try unshallow
    try {
      await this.git.fetch(['--unshallow', '--prune', '--no-tags']);
      return;
    } catch (e: any) {
      tl.warning(`--unshallow failed; will deepen history instead. ${e?.message ?? e}`);
    }

    // Fallback: deepen (adjust depth if your PRs are large/old)
    await this.git.fetch(['--depth=200', '--prune', '--no-tags']);
  }

  /**
   * Detects whether the checked-out repo is shallow.
   */
  private async isRepoShallow(): Promise<boolean> {
    try {
      const out = await this.git.raw(['rev-parse', '--is-shallow-repository']);
      return out.trim() === 'true';
    } catch {
      // Older git versions may not support it; assume not shallow.
      return false;
    }
  }

  /**
   * Determines the PR target branch short name from pipeline variables,
   * and returns "origin/<branch>".
   */
  private getTargetBranch(): string {
    // "dev" or "main"
    let target = tl.getVariable('System.PullRequest.TargetBranchName');

    // "refs/heads/dev" -> "dev"
    if (!target) {
      target = tl.getVariable('System.PullRequest.TargetBranch')?.replace('refs/heads/', '');
    }

    if (!target) {
      throw new Error('Could not determine target branch');
    }

    return `origin/${target}`;
  }
}
