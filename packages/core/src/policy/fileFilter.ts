import binaryExtensions from './binaryExtensions.json';
import micromatch from 'micromatch';

export interface FileFilterOptions {
  fileExtensions?: string;
  fileExtensionExcludes?: string;
  filesToInclude?: string;
  filesToExclude?: string;
  files: string[];
}

/**
 * Shared file filter used by all adapters. Excludes binaries, then applies include/exclude
 * lists and glob patterns to narrow the review surface.
 */
export function filterFilesForReview(options: FileFilterOptions): string[] {
  const { fileExtensions, fileExtensionExcludes, filesToInclude, filesToExclude, files } = options;

  let filesToReview = files.filter((file) => !binaryExtensions.includes(getFileExtension(file).replace(/^\./, '')));

  if (fileExtensions || filesToInclude) {
    const fileExtensionsToInclude = parseInputToArray(fileExtensions);
    const fileToIncludeGlob = parseInputToArray(filesToInclude);

    filesToReview = filesToReview.filter((file) => {
      const fileExtension = getFileExtension(file);
      return (
        fileExtensionsToInclude.includes(fileExtension) ||
        micromatch.isMatch(file, fileToIncludeGlob, { nocase: true })
      );
    });
  }

  if (fileExtensionExcludes || filesToExclude) {
    const fileExtensionsToExclude = parseInputToArray(fileExtensionExcludes);
    const filesToExcludeGlob = parseInputToArray(filesToExclude);

    filesToReview = filesToReview.filter((file) => {
      const fileExtension = getFileExtension(file);
      return (
        !fileExtensionsToExclude.includes(fileExtension) &&
        !micromatch.isMatch(file, filesToExcludeGlob, { nocase: true })
      );
    });
  }

  return filesToReview;
}

export function parseInputToArray(input?: string): string[] {
  return input?.trim().split(/\s*,\s*/) ?? [];
}

/**
 * Returns the file extension including the dot (e.g. ".ts").
 * If the file has no extension, returns an empty string.
 */
export function getFileExtension(fileName: string): string {
  // Find the last dot in the file name.
  const idx = fileName.lastIndexOf('.');
  // If found, return the substring from the dot to the end.
  return idx >= 0 ? fileName.substring(idx) : '';
}