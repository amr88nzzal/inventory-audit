// عميل الـ API: التوكن في الذاكرة فقط، والتحديث بكوكي httpOnly يرسله المتصفح وحده.
// API client: the access token lives in memory only; refresh uses an httpOnly cookie the browser sends by itself.
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;
// يُنادى حين يفشل التحديث (انتهت الجلسة)، فتعيد الواجهة المستخدم لشاشة الدخول.
// Called when refresh fails (the session ended), so the UI sends the user back to sign-in.
export const setSessionLostHandler = (fn: (() => void) | null): void => {
  onSessionLost = fn;
};

export interface Envelope<T> {
  data: T;
  meta: Record<string, unknown>;
}

const parse = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const toError = (status: number, body: unknown): ApiError => {
  const e = (body as { error?: Record<string, unknown> } | null)?.error;
  return new ApiError(
    status,
    typeof e?.['code'] === 'string' ? e['code'] : 'HTTP_ERROR',
    typeof e?.['message'] === 'string' ? e['message'] : `HTTP ${status}`,
    e?.['details'],
    typeof e?.['requestId'] === 'string' ? e['requestId'] : undefined,
  );
};

// تحديث واحد في الطيران مهما تزاحمت الطلبات (التوكن الدوّار لا يحتمل استعمالين).
// One refresh in flight no matter how many requests race (a rotating token cannot be used twice).
let refreshing: Promise<boolean> | null = null;
export const refreshSession = (): Promise<boolean> => {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return false;
      const body = (await parse(res)) as Envelope<{ accessToken: string }> | null;
      if (!body?.data.accessToken) return false;
      accessToken = body.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
};

export interface RequestOptions {
  method?: string;
  body?: unknown;
  // جسم نصي خام (مثل CSV) بدل JSON. A raw text body (e.g. CSV) instead of JSON.
  text?: { content: string; type: string };
  headers?: Record<string, string>;
  // لا محاولة تحديث عند 401 (مسارات الدخول نفسها). No refresh attempt on 401 (the sign-in routes themselves).
  auth?: boolean;
}

export const request = async <T>(
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<Envelope<T>> => {
  const { method = 'GET', body, text, headers = {}, auth = true } = options;
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (text) h['content-type'] = text.type;
  if (auth && accessToken) h['authorization'] = `Bearer ${accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: h,
      ...(text ? { body: text.content } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (res.status === 401 && auth && !retried) {
    if (await refreshSession()) return request<T>(path, options, true);
    setAccessToken(null);
    onSessionLost?.();
  }
  const parsed = await parse(res);
  if (!res.ok) throw toError(res.status, parsed);
  return (parsed ?? { data: null, meta: {} }) as Envelope<T>;
};

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
    request<T>(path, { ...options, method: 'POST', body: body ?? {} }),
  postText: <T>(path: string, content: string, type = 'text/csv') =>
    request<T>(path, { method: 'POST', text: { content, type } }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
