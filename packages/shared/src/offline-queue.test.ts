import { describe, expect, it } from 'vitest';
import {
  QUEUE_BACKOFF_CAP_MS,
  QUEUE_MAX_ATTEMPTS,
  backoffMs,
  createScanGate,
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

describe('scan gate', () => {
  it('drops the same barcode inside the window and accepts it after', () => {
    const gate = createScanGate(1500);
    expect(gate('111', 0)).toBe(true);
    expect(gate('111', 100)).toBe(false);
    expect(gate('111', 1499)).toBe(false);
    expect(gate('111', 1500)).toBe(true);
  });

  it('accepts a different barcode immediately, and the first again afterwards', () => {
    const gate = createScanGate(1500);
    expect(gate('111', 0)).toBe(true);
    expect(gate('222', 10)).toBe(true);
    expect(gate('111', 20)).toBe(true);
  });
});
