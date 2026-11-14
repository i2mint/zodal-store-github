# @zodal/store-github

A read-only zodal `DataProvider` over the files of a GitHub repository folder (the contents API), for browser apps reading a private repository with the user's token (i2mint/zodal#120; starter: thorwhalen/ghtraffic `dashboard/src/sources.ts`).

## Invariants
- The token only in `Authorization`; never in a URL, a log or an error. Requests `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`.
- Every answered failure is a `GitHubError` with `status`; a network failure has none (so `createTieredProvider`'s `fallbackOn` is right).
- Writes refused, `writeRefusal` in the capabilities. Peers on `@zodal/store ^0.2.0`: newer fields are declared structurally.

## Key skill
`zodal/.claude/skills/zodal-store-adapter/SKILL.md`

## Testing
`pnpm test` (a fake contents API in `tests/provider.test.ts`; nothing hits the network).
