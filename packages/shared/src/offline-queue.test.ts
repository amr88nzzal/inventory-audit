import { describe, expect, it } from 'vitest';
import {
  QUEUE_BACKOFF_CAP_MS,
  QUEUE_MAX_ATTEMPTS,
  backoffMs,
  createScanFilter,
  enqueue,
  isRetryableStatus,
  markFailed,
  markSent,
  nextDue,
  queueStats,
  retryFailed,
} from './offline-queue';
import type { OfflineQueue } from './offline-queue';

const op = (id: string) => ({ id, kind: 'scan', payload: { barcode: id } });

describe('offline queue', () => {
  it('does not add the same id twice', () => {
    const q = enqueue(enqueue([], op('a'), 1), op('a'), 2);
    expect(q).toHaveLength(1);
    expect(q[0]!.createdAt).toBe(1);
  });

  it('serves the oldest due operation first and none before its time', () => {
    let q: OfflineQueue = enqueue(enqueue([], op('b'), 20), op('a'), 10);
    expect(nextDue(q, 5)).toBeUndefined();
    expect(nextDue(q, 30)!.id).toBe('a');
    q = markFailed(q, 'a', { status: null, message: 'offline' }, 30);
    // a مؤجلة فتخدم b. a is delayed, so b is served.
    expect(nextDue(q, 30)!.id).toBe('b');
  });

  it('removes a sent operation', () => {
    const q = markSent(enqueue(enqueue([], op('a'), 1), op('b'), 2), 'a');
    expect(q.map((x) => x.id)).toEqual(['b']);
  });

  it('retryable failures back off exponentially, capped', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(30)).toBe(QUEUE_BACKOFF_CAP_MS);
    const q = markFailed(enqueue([], op('a'), 0), 'a', { status: 503, message: 'x' }, 100);
    expect(q[0]).toMatchObject({ attempts: 1, status: 'pending', nextAttemptAt: 100 + 2000 });
  });

  it('client errors fail at once and never retry on their own', () => {
    for (const status of [400, 403, 404, 409, 422]) {
      const q = markFailed(enqueue([], op('a'), 0), 'a', { status, message: 'no' }, 0);
      expect(q[0]!.status).toBe('failed');
      expect(nextDue(q, 1e12)).toBeUndefined();
    }
    expect([null, 408, 429, 500, 502].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409, 422].some(isRetryableStatus)).toBe(false);
  });

  it('gives up after the maximum attempts, then a manual retry restarts it', () => {
    let q: OfflineQueue = enqueue([], op('a'), 0);
    for (let i = 0; i < QUEUE_MAX_ATTEMPTS; i += 1)
      q = markFailed(q, 'a', { status: 500, message: 'x' }, i);
    expect(q[0]!.status).toBe('failed');
    expect(queueStats(q)).toEqual({ pending: 0, failed: 1 });
    q = retryFailed(q, 999);
    expect(q[0]).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: 999 });
  });

  it('never mutates its input', () => {
    const q: OfflineQueue = Object.freeze([...enqueue([], op('a'), 0)]);
    expect(() => markFailed(q, 'a', { status: 500, message: 'x' }, 1)).not.toThrow();
    expect(q[0]!.attempts).toBe(0);
  });
});

describe('scan filter', () => {
  const opts = { requiredReads: 2, maxGapMs: 800, releaseMs: 1200 };

  it('needs two consecutive close reads; a single or spaced read is not enough', () => {
    const f = createScanFilter(opts);
    expect(f('111', 0)).toBe(false);
    expect(f('111', 100)).toBe(true);
    const g = createScanFilter(opts);
    expect(g('111', 0)).toBe(false);
    // الفاصل أكبر من 800ms: يبدأ العدّ من جديد. A gap over 800ms restarts the count.
    expect(g('111', 2000)).toBe(false);
    expect(g('111', 2100)).toBe(true);
  });

  it('drops a fleeting partial read between two good reads', () => {
    const f = createScanFilter(opts);
    expect(f('9900000000011', 0)).toBe(false);
    expect(f('990000', 50)).toBe(false);
    expect(f('9900000000011', 100)).toBe(false);
    expect(f('9900000000011', 150)).toBe(true);
  });

  it('does not accept the same barcode again while the camera stays on it', () => {
    const f = createScanFilter(opts);
    f('111', 0);
    expect(f('111', 50)).toBe(true);
    for (let t = 100; t < 5000; t += 100) expect(f('111', t)).toBe(false);
  });

  it('accepts it again after the camera has left it', () => {
    const f = createScanFilter(opts);
    f('111', 0);
    expect(f('111', 50)).toBe(true);
    f('111', 100);
    // غابت الكاميرا 2 ثانية ثم عادت. The camera left for 2s and came back.
    expect(f('111', 2100)).toBe(false);
    expect(f('111', 2150)).toBe(true);
  });

  it('a glitch read of another value does not unlock the held barcode', () => {
    const f = createScanFilter(opts);
    f('111', 0);
    expect(f('111', 50)).toBe(true);
    expect(f('999', 100)).toBe(false);
    expect(f('111', 150)).toBe(false);
    expect(f('111', 200)).toBe(false);
  });

  it('accepts a different barcode right after two reads of it', () => {
    const f = createScanFilter(opts);
    f('111', 0);
    expect(f('111', 50)).toBe(true);
    expect(f('222', 100)).toBe(false);
    expect(f('222', 150)).toBe(true);
    // والعودة للأول بعد قراءتين تُحسب مسحاً جديداً. Going back to the first, after two reads, is a new scan.
    expect(f('111', 200)).toBe(false);
    expect(f('111', 250)).toBe(true);
  });
});
