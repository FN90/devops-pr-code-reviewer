import { reviewCode } from './reviewEngine';
import { LlmClient, LlmReviewRequest, LlmReviewResponse } from './llm/types';
import { ReviewInput } from './types';

class StubLlm implements LlmClient {
  constructor(private response: LlmReviewResponse) {}
  async reviewCode(_request: LlmReviewRequest): Promise<LlmReviewResponse> {
    return this.response;
  }
}

describe('reviewCode', () => {
  const baseInput: ReviewInput = {
    target: { provider: 'cli', repository: { name: 'repo' } },
    files: [
      {
        path: 'src/file.ts',
        diff: 'diff --git a/src/file.ts b/src/file.ts',
      },
    ],
    policy: {
      checks: { bugs: true, performance: false, bestPractices: false },
      modifiedLinesOnly: true,
      confidence: { enabled: true, minimum: 0.8 },
      dedupeAcrossFiles: { enabled: false, threshold: 10 },
      prompts: { additional: [] },
    },
  };

  it('filters low-confidence findings and dedupes against previous comments', async () => {
    const llm = new StubLlm({
      threads: [
        {
          comments: [
            { content: 'Old issue', commentType: 2, confidenceScore: 0.9 },
            { content: 'Low confidence', commentType: 2, confidenceScore: 0.1 },
          ],
          status: 1,
          threadContext: {
            filePath: '/src/file.ts',
            rightFileStart: { line: 1, offset: 1 },
            rightFileEnd: { line: 1, offset: 10 },
          },
        },
      ],
    });

    const input: ReviewInput = {
      ...baseInput,
      previousComments: [{ content: 'Old issue', filePath: '/src/file.ts' }],
    };

    const report = await reviewCode(input, llm);

    expect(report.findings.length).toBe(0); // deduped and low confidence removed
    expect(report.filteredOut?.length).toBeGreaterThanOrEqual(1);
  });

  it('returns findings when confidence passes', async () => {
    const llm = new StubLlm({
      threads: [
        {
          comments: [{ content: 'Important bug', commentType: 2, confidenceScore: 0.95, issueType: 'bug' }],
          status: 1,
          threadContext: {
            filePath: '/src/file.ts',
            rightFileStart: { line: 10, offset: 1 },
            rightFileEnd: { line: 12, offset: 5 },
          },
        },
      ],
    });

    const report = await reviewCode(baseInput, llm);

    expect(report.findings.length).toBe(1);
    expect(report.findings[0].severity).toBe('high');
  });
});
