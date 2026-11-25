import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './api';
import type { FetchLike, Session } from './api';

const reply = (status: number, body: unknown) => ({ status, json: async () => body });
const setup = (
  handler: (url: string, init: Parameters<FetchLike>[1]) => ReturnType<FetchLike>,
  initial: Session | null = null,
) => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  let saved: Session | null = initial;
  const api = createApiClient({
    baseUrl: 'https://x.test',
    fetch: (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    store: { load: async () => saved, save: async (s) => void (saved = s) },
  });
  return { api, calls, saved: () => saved };
};
const session = (n: number) => ({ data: { accessToken: `a${n}`, refreshToken: `r${n}` } });

describe('api client', () => {
  it('login sends X-Client: mobile and stores both tokens', async () => {
    const t = setup(async () => reply(200, session(1)));
    await t.api.login({ companyCode: 'demo', username: 'u', password: 'p' });
    expect(t.calls[0]!.init.headers['X-Client']).toBe('mobile');
    expect(t.saved()).toEqual({ accessToken: 'a1', refreshToken: 'r1' });
  });

  it('refreshes once on 401, saves the rotated token and replays the request', async () => {
    const t = setup(
      async (url, init) => {
        if (url.endsWith('/auth/refresh')) return reply(200, session(2));
        return init.headers['Authorization'] === 'Bearer a2'
          ? reply(200, { data: { ok: true } })
          : reply(401, {});
      },
      { accessToken: 'a1', refreshToken: 'r1' },
    );
    await expect(t.api.get('/items')).resolves.toEqual({ ok: true });
    expect(t.saved()).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(t.calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('concurrent 401s share one refresh (the token must not be used twice)', async () => {
    const t = setup(
      async (url, init) => {
        if (url.endsWith('/auth/refresh')) return reply(200, session(2));
        return init.headers['Authorization'] === 'Bearer a2'
          ? reply(200, { data: {} })
          : reply(401, {});
      },
      { accessToken: 'a1', refreshToken: 'r1' },
    );
    await Promise.all([t.api.get('/a'), t.api.get('/b'), t.api.get('/c')]);
    expect(t.calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('a rejected refresh ends the session; a network failure during refresh keeps it', async () => {
    const rejected = setup(
      async (url) => (url.endsWith('/auth/refresh') ? reply(401, {}) : reply(401, {})),
      { accessToken: 'a', refreshToken: 'r' },
    );
    await expect(rejected.api.get('/x')).rejects.toMatchObject({ status: 401 });
    expect(rejected.saved()).toBeNull();

    const offline = setup(
      async (url) => {
        if (url.endsWith('/auth/refresh')) throw new Error('offline');
        return reply(401, {});
      },
      { accessToken: 'a', refreshToken: 'r' },
    );
    await expect(offline.api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(offline.saved()).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('maps a network failure to a retryable ApiError and errors to their code', async () => {
    const down = setup(async () => {
      throw new Error('x');
    });
    const e = await down.api.get('/x').catch((x) => x as ApiError);
    expect(e).toMatchObject({ status: null, code: 'NETWORK', retryable: true });
    const nf = setup(
      async () => reply(404, { error: { code: 'NOT_FOUND', message: 'Item not found' } }),
      { accessToken: 'a', refreshToken: 'r' },
    );
    expect(await nf.api.get('/x').catch((x) => x as ApiError)).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      retryable: false,
    });
  });

  it('logout clears the stored session even if the server is unreachable', async () => {
    const t = setup(
      async () => {
        throw new Error('offline');
      },
      { accessToken: 'a', refreshToken: 'r' },
    );
    await t.api.logout();
    expect(t.saved()).toBeNull();
  });
});
