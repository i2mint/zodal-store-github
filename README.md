# @zodal/store-github

The files of a GitHub repository folder as a read-only [zodal](https://github.com/i2mint/zodal) `DataProvider`, read in the browser with the user's own token.

```bash
npm install @zodal/store-github @zodal/core @zodal/store
```

```ts
import { createGitHubProvider } from '@zodal/store-github';

const reports = createGitHubProvider({ repo: 'me/traffic-data', path: 'reports', token });
const { data } = await reports.getList({ sort: [{ id: 'name', desc: true }] }); // GitHubFile[]: id, name, path, size, sha
const json = JSON.parse(await reports.getContent(data[0].id));                 // the file's text
```

Items are the files under `path` (`recursive: true` for the whole tree), keyed by their path relative to it. `getContent(id)` returns the text, `getBytes(id)` the bytes, `getUrl(id, 'content')` the public raw URL (or `null` with a token: a private file has no URL a browser can fetch without it).

## Safe with a user's token

- The token goes only in the `Authorization` header: never in a URL, a log or an error message.
- Requests send no cookies and no referrer.
- Ask for a fine-grained token with **Contents: read** on the one repository.

## Errors a person can act on

Every failure is a `GitHubError` with a `code` and, when GitHub answered, the HTTP `status`:

| code | when |
|---|---|
| `unauthorized` | 401: the token is wrong, expired or revoked (or the repository needs one) |
| `forbidden` | 403: the token cannot read this repository |
| `not-found` | 404: owner/name, ref or folder is wrong, or the token cannot see the repository |
| `rate-limited` | the API rate limit is used up (the message says when it resets) |
| `network` | GitHub could not be reached (no `status`) |
| `config` | the options are wrong (not `owner/name`, a path that is not a file) |

With a `status` on every answered failure, `createTieredProvider` from `@zodal/store` falls back to its cache only when GitHub was unreachable, never on a 401 or 404.

## Capabilities

| | |
|---|---|
| create / update / delete | refused (`capabilities.writeRefusal` says why) |
| filter, search (path), sort, pagination | client-side, over the folder listing |
| content | `getContent` (text), `getBytes`, `getUrl` (public repositories) |

Options: `repo`, `ref` (default `main`), `path`, `token`, `recursive`, `include(file)`, `fetch`, `apiBase` (GitHub Enterprise).

Part of the [zodal ecosystem](https://github.com/i2mint/zodal). MIT.
