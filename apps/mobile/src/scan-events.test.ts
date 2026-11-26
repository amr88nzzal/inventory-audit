import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { buildScanOp, parseQuantity, sendScanOp } from './scan-events';

const op = buildScanOp({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: 'T',
  barcode: '123',
  quantity: '2',
  now: Date.UTC(2026, 10, 27, 7, 0, 0),
});
const queued = { ...op, createdAt: 0, attempts: 0, nextAttemptAt: 0, status: 'pending' as const };

describe('parseQuantity', () => {
  it('accepts positive decimals, Arabic digits and commas', () => {
    expect(parseQuantity('3')).toBe('3');
    expect(parseQuantity(' ٢٫٥ ')).toBe('2.5');
    expect(parseQuantity('1,25')).toBe('1.25');
  });
  it('rejects zero, negatives, too many decimals and junk', () => {
    for (const t of ['', '0', '0.0', '-1', '1.2345', 'abc', '1e3', '1.'])
      expect(parseQuantity(t), t).toBeNull();
  });
});

describe('buildScanOp', () => {
  it('uses the given id and an ISO time, omitting empty optionals', () => {
    expect(op.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(op.payload).toEqual({
      taskId: 'T',
      barcode: '123',
      quantity: '2',
      scannedAt: '2026-11-27T07:00:00.000Z',
    });
  });
});

describe('sendScanOp', () => {
  const api = (status: string, code?: string) => ({
    post: async <T>(path: string, body: unknown): Promise<T> => {
      expect(path).toBe('/tasks/T/scans');
      const ev = (body as { events: { id: string; kind: string }[] }).events[0]!;
      expect(ev.kind).toBe('count');
      return [{ id: ev.id, status, ...(code ? { code } : {}) }] as T;
    },
  });
  it('treats created and duplicate as done', async () => {
    await expect(sendScanOp(api('created'), queued)).resolves.toBeUndefined();
    await expect(sendScanOp(api('duplicate'), queued)).resolves.toBeUndefined();
  });
  it('turns a rejection into a non-retryable 422 error', async () => {
    const err = await sendScanOp(api('rejected', 'INVALID_UNIT'), queued).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'INVALID_UNIT', retryable: false });
  });
  it('fails when the server omits the event result', async () => {
    const empty = { post: async <T>(): Promise<T> => [] as T };
    await expect(sendScanOp(empty, queued)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
