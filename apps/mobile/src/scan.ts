import { ApiError } from './api';

export type LookupFeedback =
  | { kind: 'found'; name: string }
  | { kind: 'unknown' }
  // لا اتصال أو خطأ مؤقت: يُحفظ المسح في الطابور دون حكم عليه. Offline or a transient error: queued, no verdict.
  | { kind: 'offline' };

// نتيجة البحث الفوري عن الباركود لتغذية المستخدم (اهتزاز ورسالة)؛ لا تمنع الحفظ في الطابور في أي حال.
// The instant lookup result that gives the user feedback (haptic + message); it never blocks queueing.
export const lookupFeedback = async (
  lookup: () => Promise<{ name: string }>,
): Promise<LookupFeedback> => {
  try {
    return { kind: 'found', name: (await lookup()).name };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { kind: 'unknown' };
    return { kind: 'offline' };
  }
};
