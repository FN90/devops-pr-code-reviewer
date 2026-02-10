import { applyConfidenceFilterToFindings, filterCommentsByConfidence, getCommentContentForExclusion } from './dedupeUtils';
import { ReviewComment, ReviewPolicy, Finding } from '../types';

describe('dedupeUtils', () => {
  const baseComments: ReviewComment[] = [
    { content: 'A', confidenceScore: 0.9, commentType: 0 },
    { content: 'B', confidenceScore: 0.5, commentType: 0 },
    { content: 'C', confidenceScore: 0.2, commentType: 0 },
    { content: 'D', commentType: 0 },
  ];

  const basePolicy: ReviewPolicy = {
    checks: { bugs: true, performance: true, bestPractices: true },
    modifiedLinesOnly: true,
    confidence: { enabled: true, minimum: 0.6 },
    dedupeAcrossFiles: { enabled: true, threshold: 1 },
    prompts: { additional: [] },
  };

  it('filters comments below threshold', () => {
    const { filteredOut, remaining } = filterCommentsByConfidence(baseComments, 0.6);
    expect(filteredOut.map((c) => c.content)).toEqual(['B', 'C']);
    expect(remaining.map((c) => c.content)).toEqual(['A', 'D']);
  });

  it('filters comment findings by confidence policy', () => {
    const findings: Finding[] = [
      { id: '1', filePath: '/a', title: 'x', content: 'x', severity: 'medium', confidence: 0.2 },
      { id: '2', filePath: '/a', title: 'y', content: 'y', severity: 'medium', confidence: 0.9 },
    ];
    const { remaining, filteredOut } = applyConfidenceFilterToFindings(findings, basePolicy);
    expect(remaining.length).toBe(1);
    expect(filteredOut.length).toBe(1);
  });

  it('computes exclusion content based on dedupe thresholds', () => {
    const fileComments: ReviewComment[] = [
      { content: 'A', confidenceScore: 0.9, commentType: 0 },
      { content: 'B', confidenceScore: 0.5, commentType: 0 },
    ];
    const runComments: ReviewComment[] = [
      { content: 'C', confidenceScore: 0.7, commentType: 0 },
      { content: 'D', confidenceScore: 0.3, commentType: 0 },
    ];

    const [excluded, dedupeMet] = getCommentContentForExclusion(fileComments, runComments, basePolicy, false);
    expect(excluded).toEqual(['A', 'B']);
    expect(dedupeMet).toBe(false);

    const passingRunComments: ReviewComment[] = [
      { content: 'C', confidenceScore: 0.7, commentType: 0 },
      { content: 'D', confidenceScore: 0.8, commentType: 0 },
    ];
    const [excludedAfter, dedupeMetAfter] = getCommentContentForExclusion(
      fileComments,
      passingRunComments,
      basePolicy,
      false
    );
    expect(excludedAfter).toEqual(['A', 'B', 'C', 'D']);
    expect(dedupeMetAfter).toBe(true);
  });
});
