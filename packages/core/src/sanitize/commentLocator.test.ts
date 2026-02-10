import { fixThreadPositions } from './commentLocator';
import testData from './commentLocator.testData';
import { ReviewThread } from '../llm/types';

type Review = { threads: ReviewThread[] };

describe('commentLocator.fixThreadPositions', () => {
  test('should not fail when review has no threads', () => {
    const review: Review = { threads: [] };
    const result = fixThreadPositions(review.threads, '');
    expect(result.length).toEqual(0);
  });

  test('should fix single line comment', () => {
    const review: Review = testData.reviews.singleLine;

    fixThreadPositions(review.threads, testData.diffs.singleLine);

    const threadContext = review.threads[0].threadContext;
    expect(threadContext.rightFileStart!.line).toEqual(2543);
    expect(threadContext.rightFileStart!.offset).toEqual(17);
    expect(threadContext.rightFileEnd!.line).toEqual(2543);
    expect(threadContext.rightFileEnd!.offset).toEqual(91);
  });

  test('should fix multi-line comment', () => {
    const review: Review = testData.reviews.multiLine;

    fixThreadPositions(review.threads, testData.diffs.multiLine);

    const threadContext = review.threads[0].threadContext;
    expect(threadContext.rightFileStart!.line).toEqual(2543);
    expect(threadContext.rightFileStart!.offset).toEqual(17);
    expect(threadContext.rightFileEnd!.line).toEqual(2544);
    expect(threadContext.rightFileEnd!.offset).toEqual(56);
  });

  test('should fix multi-line comment w/ carriage return', () => {
    const review: Review = testData.reviews.multiLineWithCarriageReturn;

    fixThreadPositions(review.threads, testData.diffs.multiLine);

    const threadContext = review.threads[0].threadContext;
    expect(threadContext.rightFileStart!.line).toEqual(2543);
    expect(threadContext.rightFileStart!.offset).toEqual(17);
    expect(threadContext.rightFileEnd!.line).toEqual(2544);
    expect(threadContext.rightFileEnd!.offset).toEqual(56);
  });
});
