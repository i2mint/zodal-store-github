/**
 * GitHub contents provider: the files of a (private) GitHub repository folder, read in the
 * browser with the user's token, as a read-only zodal `DataProvider` (i2mint/zodal#120).
 *
 * Items are the files under `path` (one level, or the whole tree with `recursive`), keyed by
 * their path relative to `path`. An item carries its metadata (`name`, `path`, `size`, `sha`);
 * its bytes come through `getContent(id, 'content')` (text by default) without a second listing.
 *
 * - The token goes only in the `Authorization` header: never in a URL, a log or an error.
 * - Requests omit cookies and the referrer (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`).
 * - Failures are a `GitHubError` with a `code` a person can act on (`unauthorized`, `forbidden`,
 *   `not-found`, `rate-limited`, `network`, `config`) and the HTTP `status` when there was one, so
 *   `createTieredProvider`'s default `fallbackOn` treats a 4xx as an answer and a network failure
 *   as "offline".
 * - Writes are refused, and the capabilities say so (`writeRefusal`).
 */

import type { DataProvider, GetListParams, GetListResult, ProviderCapabilities } from '@zodal/store';
import { filterToFunction } from '@zodal/store';

/** `fetch`, injectable (tests, retries, a proxy). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One file of the folder, as an item. */
export interface GitHubFile {
  /** The path relative to the provider's `path` (the item id). */
  id: string;
  /** The file name. */
  name: string;
  /** The path from the repository root. */
  path: string;
  /** Bytes. */
  size: number;
  /** The git blob sha (changes when the file does). */
  sha: string;
}

export type GitHubErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'network' | 'config' | 'failed';

/** Why a read failed, in a sentence a person can act on. Never contains the token. */
export class GitHubError extends Error {
  override name = 'GitHubError';
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    /** The HTTP status GitHub answered, when there was an answer. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface GitHubProviderOptions {
  /** `owner/name`. */
  repo: string;
  /** Branch, tag or commit. Default: `'main'`. */
  ref?: string;
  /** The folder whose files are the items. Default: the repository root. */
  path?: string;
  /** A token with "Contents: read" on the repository; omit for a public repository. */
  token?: string;
  /** Include files in sub-folders (ids are then relative paths with `/`). Default: false. */
  recursive?: boolean;
  /** Which files are items. Default: every file. */
  include?: (file: GitHubFile) => boolean;
  /** `fetch`. Default: `globalThis.fetch`. */
  fetch?: FetchLike;
  /** API origin (GitHub Enterprise). Default: `'https://api.github.com'`. */
  apiBase?: string;
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const READ_ONLY_REASON = 'This collection is read from a GitHub repository; it cannot be changed here.';

function encodePath(p: string): string {
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * A read-only `DataProvider` over the files of a GitHub repository folder.
 *
 * @example
 * ```ts
 * const reports = createGitHubProvider({ repo: 'me/traffic-data', path: 'reports', token });
 * const { data } = await reports.getList({ sort: [{ id: 'name', desc: true }] });
 * const text = await reports.getContent!(data[0].id, 'content'); // the file's text
 * ```
 */
export function createGitHubProvider(options: GitHubProviderOptions): DataProvider<GitHubFile> & {
  getContent(id: string, field?: string): Promise<string>;
  getBytes(id: string): Promise<Uint8Array>;
  getUrl(id: string, field: string): Promise<string | null>;
} {
  const { repo, ref = 'main', token, recursive = false, include = () => true, apiBase = 'https://api.github.com' } = options;
  const root = (options.path ?? '').replace(/^\/+|\/+$/g, '');
  if (!REPO_RE.test(repo)) throw new GitHubError('config', `"${repo}" is not a GitHub repository name (expected owner/name).`);
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const where = `${repo}@${ref}${root ? `:${root}` : ''}`;

  async function request(apiPath: string, accept: string, what: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${apiBase}${apiPath}${apiPath.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' });
    } catch (e) {
      throw new GitHubError('network', `Could not reach ${new URL(apiBase).host} (${(e as Error)?.message ?? 'network error'}).`);
    }
    if (res.ok) return res;
    throw failure(res, what);
  }

  function failure(res: Response, what: string): GitHubError {
    const s = res.status;
    if ((s === 403 || s === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? ` Try again after ${new Date(reset * 1000).toISOString()}.` : '';
      return new GitHubError('rate-limited', `GitHub's API rate limit is used up.${when}`, s);
    }
    if (s === 401) {
      return new GitHubError(
        'unauthorized',
        token ? 'GitHub rejected the token (401): it is wrong, expired or revoked.' : `${where} needs a token (401).`,
        s,
      );
    }
    if (s === 403) return new GitHubError('forbidden', `The token cannot read ${where} (403): give it "Contents: read" on that repository.`, s);
    if (s === 404) return new GitHubError('not-found', `${what} was not found in ${where} (404): check the owner/name, ref and folder, and that the token can see the repository.`, s);
    return new GitHubError('failed', `GitHub answered ${s} for ${what} in ${where}.`, s);
  }

  interface Entry { type: string; name: string; path: string; size: number; sha: string }

  async function listDir(dir: string): Promise<GitHubFile[]> {
    const res = await request(`/repos/${repo}/contents/${encodePath(dir)}`, 'application/vnd.github+json', dir || 'the root folder');
    const body = (await res.json()) as Entry[] | Entry;
    if (!Array.isArray(body)) throw new GitHubError('config', `${dir || 'the root'} in ${where} is a file, not a folder.`);
    const files: GitHubFile[] = [];
    for (const e of body) {
      if (e.type === 'file') {
        const id = root ? e.path.slice(root.length + 1) : e.path;
        files.push({ id, name: e.name, path: e.path, size: e.size, sha: e.sha });
      } else if (e.type === 'dir' && recursive) {
        files.push(...(await listDir(e.path)));
      }
    }
    return files;
  }

  const fullPath = (id: string) => (root ? `${root}/${id}` : id);

  async function raw(id: string): Promise<Response> {
    if (!id || id.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new GitHubError('config', `"${id}" is not a file path in ${where}.`);
    }
    return request(`/repos/${repo}/contents/${encodePath(fullPath(id))}`, 'application/vnd.github.raw+json', id);
  }

  const refuse = () => Promise.reject(new Error(READ_ONLY_REASON));

  return {
    async getList(params: GetListParams): Promise<GetListResult<GitHubFile>> {
      let items = (await listDir(root)).filter(include);
      if (params.filter) items = items.filter(filterToFunction<GitHubFile>(params.filter));
      if (params.search) {
        const needle = params.search.toLowerCase();
        items = items.filter((f) => f.path.toLowerCase().includes(needle));
      }
      const total = items.length;
      if (params.sort?.length) {
        items = [...items].sort((a, b) => {
          for (const s of params.sort!) {
            const x = (a as unknown as Record<string, unknown>)[s.id];
            const y = (b as unknown as Record<string, unknown>)[s.id];
            const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''));
            if (c !== 0) return s.desc ? -c : c;
          }
          return 0;
        });
      }
      if (params.pagination) {
        const { page, pageSize } = params.pagination;
        items = items.slice((page - 1) * pageSize, page * pageSize);
      }
      return { data: items, total };
    },

    async getOne(id: string): Promise<GitHubFile> {
      const res = await request(`/repos/${repo}/contents/${encodePath(fullPath(id))}`, 'application/vnd.github+json', id);
      const e = (await res.json()) as Entry;
      if (Array.isArray(e) || e.type !== 'file') throw new GitHubError('not-found', `${id} in ${where} is not a file.`, 404);
      return { id, name: e.name, path: e.path, size: e.size, sha: e.sha };
    },

    /** The file's text (UTF-8). `field` is `'content'`, the only content field. */
    async getContent(id: string, field = 'content'): Promise<string> {
      if (field !== 'content') throw new Error(`'${field}' is not a content field (the only one is 'content')`);
      return (await raw(id)).text();
    },

    /** The file's bytes. */
    async getBytes(id: string): Promise<Uint8Array> {
      return new Uint8Array(await (await raw(id)).arrayBuffer());
    },

    /**
     * A URL for the bytes: `null` with a token (a private file has no URL a browser can fetch
     * without the token; read it with `getContent`), else the public raw URL.
     */
    async getUrl(id: string, field: string): Promise<string | null> {
      if (field !== 'content') throw new Error(`'${field}' is not a content field (the only one is 'content')`);
      if (token) return null;
      return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodePath(fullPath(id))}`;
    },

    create: refuse,
    update: refuse,
    updateMany: refuse,
    delete: refuse,
    deleteMany: refuse,

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canBulkUpdate: false,
        canBulkDelete: false,
        canUpsert: false,
        serverSort: false,
        serverFilter: false,
        serverSearch: false,
        serverPagination: false,
        // Declared structurally: the @zodal/store on npm predates the field.
        ...({ writeRefusal: READ_ONLY_REASON } as Partial<ProviderCapabilities>),
      };
    },
  };
}
