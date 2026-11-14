/**
 * @zodal/store-github: the files of a GitHub repository folder as a read-only zodal DataProvider,
 * read in the browser with the user's token (i2mint/zodal#120).
 */
export { createGitHubProvider, GitHubError } from './provider.js';
export type { GitHubFile, GitHubProviderOptions, GitHubErrorCode, FetchLike } from './provider.js';
