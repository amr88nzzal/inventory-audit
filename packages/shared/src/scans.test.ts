import { describe, expect, it } from 'vitest';
import { SCAN_BATCH_MAX, scanBatchSchema, scanEventSchema } from './scans';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const count = {
  id: id(1),
  kind: 'count',
  barcode: '123',
  quantity: '2',
  scannedAt: '2026-11-27T10:00:00Z',
};

describe('scanEventSchema', () => {
  it('accepts a count and a void', () => {
    expect(scanEventSchema.safeParse(count).success).toBe(true);
    expect(
      scanEventSchema.safeParse({
        id: id(2),
        kind: 'void',
        voidsId: id(1),
        scannedAt: count.scannedAt,
      }).success,
    ).toBe(true);
  });
  it('rejects zero/negative/over-precise quantities and whitespace barcodes', () => {
    for (const quantity of ['0', '0.000', '-1', '1.1234567', '1e3'])
      expect(scanEventSchema.safeParse({ ...count, quantity }).success, quantity).toBe(false);
    expect(scanEventSchema.safeParse({ ...count, barcode: 'a b' }).success).toBe(false);
    expect(scanEventSchema.safeParse({ ...count, barcode: 'x'.repeat(65) }).success).toBe(false);
  });
  it('rejects unknown keys and a void carrying a quantity', () => {
    expect(scanEventSchema.safeParse({ ...count, companyId: id(9) }).success).toBe(false);
    expect(
      scanEventSchema.safeParse({
        id: id(2),
        kind: 'void',
        voidsId: id(1),
        quantity: '1',
        scannedAt: count.scannedAt,
      }).success,
    ).toBe(false);
  });
});

describe('scanBatchSchema', () => {
  it('enforces size and unique ids', () => {
    expect(scanBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(scanBatchSchema.safeParse({ events: [count, count] }).success).toBe(false);
    const max = Array.from({ length: SCAN_BATCH_MAX }, (_, i) => ({ ...count, id: id(i + 1) }));
    expect(scanBatchSchema.safeParse({ events: max }).success).toBe(true);
    expect(scanBatchSchema.safeParse({ events: [...max, { ...count, id: id(999) }] }).success).toBe(
      false,
    );
  });
});
