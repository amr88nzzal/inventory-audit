import { describe, expect, it } from 'vitest';
import { createItemSchema, itemListQuerySchema, updateItemSchema } from './items';
import { toBaseQuantity } from './units';

describe('toBaseQuantity', () => {
  it('multiplies by the factor exactly (no float error)', () => {
    expect(toBaseQuantity('3', '12')).toBe('36');
    expect(toBaseQuantity('0.1', '3')).toBe('0.3'); // 0.1*3 = 0.30000000000000004 in floats
    expect(toBaseQuantity('2.5', '24')).toBe('60');
    expect(toBaseQuantity('0', '12')).toBe('0');
    expect(toBaseQuantity('7', '1')).toBe('7');
  });
  it('rejects negative quantities and non-positive or malformed factors', () => {
    expect(() => toBaseQuantity('-1', '2')).toThrow(RangeError);
    expect(() => toBaseQuantity('1', '0')).toThrow(RangeError);
    expect(() => toBaseQuantity('1', '-2')).toThrow(RangeError);
    expect(() => toBaseQuantity('x', '2')).toThrow();
  });
});

const base = { barcode: '6281000123456', name: 'عصير برتقال' };

describe('createItemSchema', () => {
  it('accepts a minimal item and defaults the base unit and units', () => {
    const r = createItemSchema.parse(base);
    expect(r.baseUnit).toBe('قطعة');
    expect(r.units).toEqual([]);
  });
  it('accepts full data with units', () => {
    const r = createItemSchema.parse({
      ...base,
      price: '12.5',
      tolerancePct: '2.5',
      units: [
        { name: 'كرتونة', factor: '12' },
        { name: 'باليت', factor: '240.5' },
      ],
    });
    expect(r.units).toHaveLength(2);
  });
  it.each([
    ['barcode with space', { ...base, barcode: '12 34' }],
    ['empty barcode', { ...base, barcode: '' }],
    ['barcode too long', { ...base, barcode: '1'.repeat(65) }],
    ['price as number', { ...base, price: 12.5 }],
    ['negative price', { ...base, price: '-1' }],
    ['price 5 decimals', { ...base, price: '1.00001' }],
    ['tolerance over 100', { ...base, tolerancePct: '100.01' }],
    ['factor 1', { ...base, units: [{ name: 'x', factor: '1' }] }],
    ['factor 0.5', { ...base, units: [{ name: 'x', factor: '0.5' }] }],
    ['factor as number', { ...base, units: [{ name: 'x', factor: 12 }] }],
    [
      'duplicate units',
      {
        ...base,
        units: [
          { name: 'A', factor: '2' },
          { name: 'a', factor: '3' },
        ],
      },
    ],
    ['unit repeats base', { ...base, baseUnit: 'قطعة', units: [{ name: 'قطعة', factor: '2' }] }],
    [
      '11 units',
      { ...base, units: Array.from({ length: 11 }, (_, i) => ({ name: `u${i}`, factor: '2' })) },
    ],
    ['companyId (mass assignment)', { ...base, companyId: '00000000-0000-7000-8000-000000000001' }],
  ])('rejects %s', (_n, input) => {
    expect(createItemSchema.safeParse(input).success).toBe(false);
  });
});

describe('updateItemSchema / list query', () => {
  it('needs a version and at least one change; null clears optionals', () => {
    expect(updateItemSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateItemSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(updateItemSchema.parse({ version: 1, price: null }).price).toBeNull();
  });
  it('whitelists sort columns', () => {
    expect(itemListQuerySchema.safeParse({ sort: 'password_hash' }).success).toBe(false);
    expect(itemListQuerySchema.parse({}).sort).toBe('name');
  });
});
