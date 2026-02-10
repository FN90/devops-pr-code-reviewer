import { filterFilesForReview } from './fileFilter';

describe('filterFilesForReview', () => {
  test('returns all files when no filters are applied', () => {
    const files = ['file1.txt', 'file2.js', 'file3.js'];
    const result = filterFilesForReview({ files });
    expect(result).toEqual(['file1.txt', 'file2.js', 'file3.js']);
  });

  test('excludes binary files', () => {
    const files = ['file1.txt', 'file2.js', 'file3.exe', 'file4.pdf'];
    const result = filterFilesForReview({ files });
    expect(result).toEqual(['file1.txt', 'file2.js']);
  });

  test('filters by fileExtensions', () => {
    const files = ['file1.txt', 'file2.js', 'file3.cs'];
    const result = filterFilesForReview({ fileExtensions: '.txt,.js', files });
    expect(result).toEqual(['file1.txt', 'file2.js']);
  });

  test('excludes by fileExtensionExcludes', () => {
    const files = ['file1.txt', 'file2.js', 'file3.cs'];
    const result = filterFilesForReview({ fileExtensionExcludes: '.js', files });
    expect(result).toEqual(['file1.txt', 'file3.cs']);
  });

  test('includes files using glob patterns', () => {
    const files = ['file1.js', 'file2.txt', 'test/file3.js'];
    const result = filterFilesForReview({ filesToInclude: '*.js,f*2.txt', files });
    expect(result).toEqual(['file1.js', 'file2.txt']);
  });

  test('excludes files using glob patterns', () => {
    const files = ['src/file1.txt', 'src/file2.js', 'test/file3.js'];
    const result = filterFilesForReview({ filesToExclude: 'src/*', files });
    expect(result).toEqual(['test/file3.js']);
  });
});
