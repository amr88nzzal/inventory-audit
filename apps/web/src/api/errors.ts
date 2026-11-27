import { ApiError } from './client';

// يحوّل خطأ الـ API إلى مفتاح ترجمة؛ لا نعرض نص الخادم الإنجليزي للمستخدم.
// Maps an API error to a translation key; the server's English text is never shown to the user.
export const errorKey = (err: unknown, map: Record<string, string> = {}): string => {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'common.networkError';
    const mapped = map[err.code];
    if (mapped) return mapped;
  }
  return 'common.genericError';
};
