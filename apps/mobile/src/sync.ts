import { enqueue, markFailed, markSent, nextDue } from '@inventory/shared';
import type { OfflineQueue, QueuedOp } from '@inventory/shared';
import { ApiError } from './api';

export interface QueueStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}
const KEY = 'inventory.queue.v1';

// قراءة متسامحة: ملف تالف يعني طابوراً فارغاً لا تعطّل التطبيق. Tolerant read: a corrupt value means an empty queue, not a crash.
export const loadQueue = async (storage: QueueStorage): Promise<OfflineQueue> => {
  try {
    const parsed: unknown = JSON.parse((await storage.getItem(KEY)) ?? '[]');
    return Array.isArray(parsed) ? (parsed as QueuedOp[]) : [];
  } catch {
    return [];
  }
};
export const saveQueue = (storage: QueueStorage, queue: OfflineQueue): Promise<void> =>
  storage.setItem(KEY, JSON.stringify(queue));

// يحفظ بعد كل خطوة: انقطاع التيار أو إغلاق التطبيق وسط المزامنة لا يضيّع عملاً ولا يكرره
// (المعرّف يرافق الإرسال كـ Idempotency-Key فالخادم يتجاهل التكرار).
// Saves after every step: a crash mid-sync neither loses nor duplicates work (the id travels as the
// Idempotency-Key, so the server ignores a resend).
export const runQueue = async (deps: {
  storage: QueueStorage;
  send: (op: QueuedOp) => Promise<void>;
  now: () => number;
  maxOps?: number;
}): Promise<{ sent: number; failed: number; remaining: number }> => {
  let queue = await loadQueue(deps.storage);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < (deps.maxOps ?? 500); i += 1) {
    const op = nextDue(queue, deps.now());
    if (!op) break;
    try {
      await deps.send(op);
      queue = markSent(queue, op.id);
      sent += 1;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(null, 'NETWORK', String(e));
      queue = markFailed(queue, op.id, { status: err.status, message: err.code }, deps.now());
      failed += 1;
      // الشبكة مقطوعة: لا فائدة من تجربة الباقي الآن. Offline: no point trying the rest now.
      if (err.status === null) {
        await saveQueue(deps.storage, queue);
        break;
      }
    }
    await saveQueue(deps.storage, queue);
  }
  return { sent, failed, remaining: queue.length };
};

export const addToQueue = async (
  storage: QueueStorage,
  op: { id: string; kind: string; payload: unknown },
  now: number,
): Promise<OfflineQueue> => {
  const queue = enqueue(await loadQueue(storage), op, now);
  await saveQueue(storage, queue);
  return queue;
};
