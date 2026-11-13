import { describe, expect, it } from 'vitest';
import { createTtlCache } from './cache';

describe('TtlCache', () => {
  it('returns a value before the TTL and drops it after', () => {
    const c = createTtlCache<number>(1000);
    c.set('a', 1, 0);
    expect(c.get('a', 999)).toBe(1);
    expect(c.get('a', 1000)).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it('invalidates by prefix only', () => {
    const c = createTtlCache<number>(1000);
    c.set('co1:u1', 1, 0);
    c.set('co1:u2', 2, 0);
    c.set('co2:u1', 3, 0);
    c.invalidatePrefix('co1:');
    expect(c.get('co1:u1', 1)).toBeUndefined();
    expect(c.get('co1:u2', 1)).toBeUndefined();
    expect(c.get('co2:u1', 1)).toBe(3);
  });

  it('evicts the oldest entry at the size cap', () => {
    const c = createTtlCache<number>(1000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    c.set('c', 3, 0);
    expect(c.get('a', 1)).toBeUndefined();
    expect(c.get('b', 1)).toBe(2);
    expect(c.get('c', 1)).toBe(3);
  });
});
