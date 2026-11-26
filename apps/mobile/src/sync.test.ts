import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { addToQueue, loadQueue, runQueue } from './sync';
import type { QueueStorage } from './sync';

const memory = (): QueueStorage & { raw: Map<string, string> } => {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: async (k) => raw.get(k) ?? null,
    setItem: async (k, v) => void raw.set(k, v),
  };
};
const op = (id: string) => ({ id, kind: 'scan', payload: { barcode: id } });

describe('runQueue', () => {
  it('sends in scan order with the op id, then empties the queue', async () => {
    const s = memory();
    await addToQueue(s, op('a'), 1);
    await addToQueue(s, op('b'), 2);
    const seen: string[] = [];
    const r = await runQueue({
      storage: s,
      now: () => 10,
      send: async (o) => void seen.push(o.id),
    });
    expect(seen).toEqual(['a', 'b']);
    expect(r).toEqual({ sent: 2, failed: 0, remaining: 0 });
    expect(await loadQueue(s)).toEqual([]);
  });

  it('stops at the first network failure and keeps everything', async () => {
    const s = memory();
    await addToQueue(s, op('a'), 1);
    await addToQueue(s, op('b'), 2);
    let calls = 0;
    const r = await runQueue({
      storage: s,
      now: () => 10,
      send: async () => {
        calls += 1;
        throw new ApiError(null, 'NETWORK', 'down');
      },
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ sent: 0, failed: 1, remaining: 2 });
    expect((await loadQueue(s)).find((q) => q.id === 'a')).toMatchObject({
      attempts: 1,
      status: 'pending',
    });
  });

  it('a rejected op (422) is parked as failed and the rest continue', async () => {
    const s = memory();
    await addToQueue(s, op('bad'), 1);
    await addToQueue(s, op('ok'), 2);
    const r = await runQueue({
      storage: s,
      now: () => 10,
      send: async (o) => {
        if (o.id === 'bad') throw new ApiError(422, 'INVALID', 'no');
      },
    });
    expect(r).toEqual({ sent: 1, failed: 1, remaining: 1 });
    expect((await loadQueue(s))[0]).toMatchObject({ id: 'bad', status: 'failed' });
  });

  it('persists after each step, so a crash mid-sync loses nothing', async () => {
    const s = memory();
    await addToQueue(s, op('a'), 1);
    await addToQueue(s, op('b'), 2);
    await expect(
      runQueue({
        storage: s,
        now: () => 10,
        send: async (o) => {
          if (o.id === 'b') throw new Error('process killed');
        },
      }),
    ).resolves.toBeDefined();
    // a أُرسلت وحُفظ حذفها قبل الانهيار. a was sent and its removal saved before the failure.
    expect((await loadQueue(s)).map((q) => q.id)).toEqual(['b']);
  });

  it('a corrupt stored value reads as an empty queue', async () => {
    const s = memory();
    s.raw.set('inventory.queue.v2', '{not json');
    expect(await loadQueue(s)).toEqual([]);
    s.raw.set('inventory.queue.v2', '{"a":1}');
    expect(await loadQueue(s)).toEqual([]);
  });

  it('adding the same scan id twice keeps one entry', async () => {
    const s = memory();
    await addToQueue(s, op('a'), 1);
    await addToQueue(s, op('a'), 2);
    expect(await loadQueue(s)).toHaveLength(1);
  });
});
