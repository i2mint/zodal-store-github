import { describe, it, expect } from 'vitest';
import { createGitHubProvider, GitHubError } from '../src/index.js';

/** A fake api.github.com contents API over an in-memory tree. */
function fakeGitHub(files: Record<string, string>, opts: { status?: number; rateLimited?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string>; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, headers, init });
    if (opts.rateLimited) return new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } });
    if (opts.status) return new Response('no', { status: opts.status });
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\/?/, ''));
    if (headers.accept === 'application/vnd.github.raw+json') {
      return p in files ? new Response(files[p], { status: 200 }) : new Response('nf', { status: 404 });
    }
    if (p in files) return Response.json({ type: 'file', name: p.split('/').pop(), path: p, size: files[p]!.length, sha: `sha-${p}` });
    const prefix = p ? `${p}/` : '';
    const children = new Map<string, any>();
    for (const [fp, text] of Object.entries(files)) {
      if (!fp.startsWith(prefix)) continue;
      const rest = fp.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      children.set(head, tail.length ? { type: 'dir', name: head, path: prefix + head, size: 0, sha: 'd' } : { type: 'file', name: head, path: fp, size: text.length, sha: `sha-${fp}` });
    }
    return children.size ? Response.json([...children.values()]) : new Response('nf', { status: 404 });
  };
  return { fetch, calls };
}

const files = { 'reports/2026-11.json': '{"views":3}', 'reports/2026-10.json': '{"views":1}', 'reports/old/2025.json': '{}', 'README.md': '# hi' };

describe('createGitHubProvider (zodal#120)', () => {
  it('lists the folder as items, sorts and pages them, and reads content', async () => {
    const gh = fakeGitHub(files);
    const p = createGitHubProvider({ repo: 'me/data', path: 'reports', token: 't0k3n', fetch: gh.fetch });
    const r = await p.getList({ sort: [{ id: 'name', desc: true }], pagination: { page: 1, pageSize: 1 } });
    expect(r.total).toBe(2);
    expect(r.data.map((f) => f.id)).toEqual(['2026-11.json']);
    expect(await p.getContent('2026-10.json')).toBe('{"views":1}');
    expect((await p.getOne('2026-11.json')).sha).toBe('sha-reports/2026-11.json');
    const rec = createGitHubProvider({ repo: 'me/data', path: 'reports', recursive: true, fetch: gh.fetch });
    expect((await rec.getList({})).data.map((f) => f.id).sort()).toEqual(['2026-10.json', '2026-11.json', 'old/2025.json']);
  });
  it('sends the token only in Authorization, with no cookies or referrer', async () => {
    const gh = fakeGitHub(files);
    const p = createGitHubProvider({ repo: 'me/data', token: 'secret-token', ref: 'dev', fetch: gh.fetch });
    await p.getContent('README.md');
    const c = gh.calls[0]!;
    expect(c.headers.authorization).toBe('Bearer secret-token');
    expect(c.url).not.toContain('secret-token');
    expect(c.url).toContain('ref=dev');
    expect(c.init.credentials).toBe('omit');
    expect(c.init.referrerPolicy).toBe('no-referrer');
  });
  it('turns failures into actionable, token-free errors with a status', async () => {
    const cases: [any, string][] = [[{ status: 401 }, 'unauthorized'], [{ status: 403 }, 'forbidden'], [{ status: 404 }, 'not-found'], [{ rateLimited: true }, 'rate-limited']];
    for (const [opts, code] of cases) {
      const p = createGitHubProvider({ repo: 'me/data', token: 'secret-token', fetch: fakeGitHub(files, opts).fetch });
      const err = await p.getList({}).catch((e) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect(err.code).toBe(code);
      expect(typeof err.status).toBe('number');
      expect(err.message).not.toContain('secret-token');
    }
    const offline = createGitHubProvider({ repo: 'me/data', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const err = await offline.getList({}).catch((e) => e);
    expect([err.code, err.status]).toEqual(['network', undefined]);
    expect(() => createGitHubProvider({ repo: 'not a repo' })).toThrow(/owner\/name/);
  });
  it('is read-only, and says why', async () => {
    const p = createGitHubProvider({ repo: 'me/data', fetch: fakeGitHub(files).fetch });
    const caps = p.getCapabilities!() as any;
    expect([caps.canCreate, caps.canUpdate, caps.canDelete]).toEqual([false, false, false]);
    expect(caps.writeRefusal).toMatch(/GitHub/);
    await expect(p.create({})).rejects.toThrow(/cannot be changed/);
    expect(await p.getUrl('README.md', 'content')).toBe('https://raw.githubusercontent.com/me/data/main/README.md');
    const priv = createGitHubProvider({ repo: 'me/data', token: 't', fetch: fakeGitHub(files).fetch });
    expect(await priv.getUrl('README.md', 'content')).toBeNull();
    await expect(priv.getContent('../x')).rejects.toThrow(/not a file path/);
  });
});
