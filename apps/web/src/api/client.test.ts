import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, getAccessToken, setAccessToken, setSessionLostHandler } from './client';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });
const errBody = (code: string) => ({
  error: { code, message: code, status: 0, details: null, requestId: 'r1' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setSessionLostHandler(null);
});

describe('api client', () => {
  it('sends the bearer token and unwraps the envelope', async () => {
    setAccessToken('tok');
    const fn = vi.fn(async () => json(200, { data: { x: 1 }, meta: { total: 3 } }));
    vi.stubGlobal('fetch', fn);
    const res = await api.get<{ x: number }>('/things');
    expect(res).toEqual({ data: { x: 1 }, meta: { total: 3 } });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/things');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(init.credentials).toBe('include');
  });

  it('postText sends the raw text with its content type (never JSON-encoded)', async () => {
    const fn = vi.fn(async () => json(200, { data: null, meta: {} }));
    vi.stubGlobal('fetch', fn);
    await api.postText('/items/import?mode=preview', 'barcode,name\n1,"x"\n');
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('barcode,name\n1,"x"\n');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/csv');
  });

  it('turns server errors into ApiError with code, details and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(409, errBody('VERSION_CONFLICT'))),
    );
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', requestId: 'r1' });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await expect(api.get('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('on 401 refreshes once and retries the original request with the new token', async () => {
    setAccessToken('old');
    const seen: string[] = [];
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh'))
        return json(200, { data: { accessToken: 'new' }, meta: {} });
      const auth = (init.headers as Record<string, string>)['authorization'] ?? '';
      seen.push(auth);
      return auth === 'Bearer new'
        ? json(200, { data: 'ok', meta: {} })
        : json(401, errBody('UNAUTHENTICATED'));
    });
    vi.stubGlobal('fetch', fn);
    expect((await api.get('/me')).data).toBe('ok');
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    expect(getAccessToken()).toBe('new');
  });

  it('concurrent 401s share ONE refresh (a rotating token cannot be used twice)', async () => {
    setAccessToken('old');
    let refreshes = 0;
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { data: { accessToken: 'new' }, meta: {} });
      }
      const auth = (init.headers as Record<string, string>)['authorization'];
      return auth === 'Bearer new'
        ? json(200, { data: 1, meta: {} })
        : json(401, errBody('UNAUTHENTICATED'));
    });
    vi.stubGlobal('fetch', fn);
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(refreshes).toBe(1);
  });

  it('when refresh fails it clears the token, notifies, and surfaces the 401', async () => {
    setAccessToken('old');
    const lost = vi.fn();
    setSessionLostHandler(lost);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/refresh')
          ? json(401, errBody('INVALID_REFRESH'))
          : json(401, errBody('UNAUTHENTICATED')),
      ),
    );
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('auth:false requests (sign-in) never trigger a refresh', async () => {
    const fn = vi.fn(async () => json(401, errBody('INVALID_CREDENTIALS')));
    vi.stubGlobal('fetch', fn);
    await expect(api.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
