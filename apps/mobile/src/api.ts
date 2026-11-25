import { isRetryableStatus } from '@inventory/shared';

// عميل API للموبايل: يرسل X-Client: mobile فيحصل على توكن التحديث في الجسم ويحفظه في التخزين الآمن.
// عند 401 يجدّد التوكن مرة واحدة ثم يعيد الطلب. التوكن يدور (القديم يُلغى)، فيُحفظ الجديد قبل أي استعمال.
// The mobile API client: X-Client: mobile returns the refresh token in the body, kept in secure storage.
// On 401 it refreshes once and replays. The token rotates (the old one is revoked), so the new one is saved first.
export interface Session {
  accessToken: string;
  refreshToken: string;
}
export interface SessionStore {
  load: () => Promise<Session | null>;
  save: (s: Session | null) => Promise<void>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export class ApiError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export const createApiClient = (deps: {
  baseUrl: string;
  fetch: FetchLike;
  store: SessionStore;
}) => {
  let session: Session | null = null;
  // تجديد واحد في وقت واحد، كي لا يُستعمل توكن تحديث مرتين فيُلغى الفرع كله.
  // One refresh at a time, so a refresh token is never used twice (which would revoke the family).
  let refreshing: Promise<boolean> | null = null;

  const raw = async (
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Envelope }> => {
    const headers: Record<string, string> = {
      'X-Client': 'mobile',
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    };
    if (opts.auth && session) headers['Authorization'] = `Bearer ${session.accessToken}`;
    let res;
    try {
      res = await deps.fetch(`${deps.baseUrl}/api/v1${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch {
      throw new ApiError(null, 'NETWORK', 'Network request failed');
    }
    let body: Envelope = {};
    try {
      body = (await res.json()) as Envelope;
    } catch {
      /* جسم غير JSON. A non-JSON body. */
    }
    return { status: res.status, body };
  };

  const adopt = async (data: Record<string, unknown> | undefined): Promise<void> => {
    const accessToken = data?.['accessToken'];
    const refreshToken = data?.['refreshToken'];
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string')
      throw new ApiError(null, 'BAD_RESPONSE', 'Unexpected sign-in response');
    session = { accessToken, refreshToken };
    await deps.store.save(session);
  };

  const refresh = (): Promise<boolean> => {
    refreshing ??= (async () => {
      try {
        if (!session) return false;
        const r = await raw('POST', '/auth/refresh', {
          body: { refreshToken: session.refreshToken },
        });
        if (r.status !== 200) {
          // رفض صريح (لا خطأ شبكة) = انتهت الجلسة. An explicit rejection (not a network error) = session over.
          if (r.status === 401 || r.status === 403) {
            session = null;
            await deps.store.save(null);
          }
          return false;
        }
        await adopt(r.body.data);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const request = async <T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> => {
    session ??= await deps.store.load();
    let r = await raw(method, path, { ...opts, auth: true });
    if (r.status === 401 && session && (await refresh()))
      r = await raw(method, path, { ...opts, auth: true });
    if (r.status >= 200 && r.status < 300) return r.body.data as T;
    throw new ApiError(
      r.status,
      r.body.error?.code ?? 'HTTP_ERROR',
      r.body.error?.message ?? `HTTP ${r.status}`,
    );
  };

  return {
    login: async (input: { companyCode: string; username: string; password: string }) => {
      const r = await raw('POST', '/auth/login', { body: input });
      if (r.status !== 200)
        throw new ApiError(
          r.status,
          r.body.error?.code ?? 'HTTP_ERROR',
          r.body.error?.message ?? 'Sign-in failed',
        );
      await adopt(r.body.data);
    },
    logout: async () => {
      session ??= await deps.store.load();
      if (session)
        await raw('POST', '/auth/logout', { body: { refreshToken: session.refreshToken } }).catch(
          () => undefined,
        );
      session = null;
      await deps.store.save(null);
    },
    isSignedIn: async () => (session ??= await deps.store.load()) !== null,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
      request<T>('POST', path, { body, ...(headers ? { headers } : {}) }),
  };
};
export type ApiClient = ReturnType<typeof createApiClient>;
