import { describe, expect, it } from 'vitest';
import { computeVariance } from './variance';

const base = { defaultTolerancePct: '10' };

describe('computeVariance', () => {
  it('computes a negative variance (shortage) with signed percent', () => {
    const r = computeVariance({ ...base, systemQty: '100', countedQty: '87.5' });
    expect(r.varianceQty).toBe('-12.5');
    expect(r.variancePct).toBe('-12.5');
    expect(r.flaggedForRecount).toBe(true);
  });

  it('computes a positive variance (surplus)', () => {
    const r = computeVariance({ ...base, systemQty: '200', countedQty: '210' });
    expect(r.varianceQty).toBe('10');
    expect(r.variancePct).toBe('5');
    expect(r.flaggedForRecount).toBe(false);
  });

  it('does not flag when exactly at the tolerance', () => {
    const r = computeVariance({ ...base, systemQty: '100', countedQty: '110' });
    expect(r.variancePct).toBe('10');
    expect(r.flaggedForRecount).toBe(false);
  });

  it('flags just above the tolerance', () => {
    const r = computeVariance({ ...base, systemQty: '1000', countedQty: '1101' });
    expect(r.variancePct).toBe('10.1');
    expect(r.flaggedForRecount).toBe(true);
  });

  it('prefers item tolerance over task tolerance over default', () => {
    const input = { systemQty: '100', countedQty: '96', defaultTolerancePct: '10' };
    expect(computeVariance({ ...input, taskTolerancePct: '3' }).appliedTolerancePct).toBe('3');
    expect(computeVariance({ ...input, taskTolerancePct: '3' }).flaggedForRecount).toBe(true);
    const withItem = computeVariance({ ...input, taskTolerancePct: '3', itemTolerancePct: '5' });
    expect(withItem.appliedTolerancePct).toBe('5');
    expect(withItem.flaggedForRecount).toBe(false);
    expect(computeVariance(input).appliedTolerancePct).toBe('10');
  });

  it('treats an item tolerance of 0 as zero tolerance, not as missing', () => {
    const r = computeVariance({
      ...base,
      systemQty: '100',
      countedQty: '99',
      itemTolerancePct: '0',
    });
    expect(r.appliedTolerancePct).toBe('0');
    expect(r.flaggedForRecount).toBe(true);
  });

  it('falls through null tolerances to the next level', () => {
    const r = computeVariance({
      ...base,
      systemQty: '100',
      countedQty: '100',
      itemTolerancePct: null,
      taskTolerancePct: null,
    });
    expect(r.appliedTolerancePct).toBe('10');
  });

  it('is exact with decimals that break floating point', () => {
    const r = computeVariance({ ...base, systemQty: '0.3', countedQty: '0.1' });
    expect(r.varianceQty).toBe('-0.2');
    expect(r.variancePct).toBe('-66.67');
  });

  it('rounds the percent half-up to 2 decimals', () => {
    const r = computeVariance({ ...base, systemQty: '8', countedQty: '8.01' });
    expect(r.variancePct).toBe('0.13');
  });

  it('handles zero system qty: counted 0 is clean', () => {
    const r = computeVariance({ ...base, systemQty: '0', countedQty: '0' });
    expect(r.variancePct).toBe('0');
    expect(r.flaggedForRecount).toBe(false);
  });

  it('handles zero system qty: any counted quantity is flagged with null percent', () => {
    const r = computeVariance({ ...base, systemQty: '0', countedQty: '3' });
    expect(r.variancePct).toBeNull();
    expect(r.varianceQty).toBe('3');
    expect(r.flaggedForRecount).toBe(true);
  });

  it('handles counted 0 against a positive system qty as -100%', () => {
    const r = computeVariance({ ...base, systemQty: '40', countedQty: '0' });
    expect(r.variancePct).toBe('-100');
    expect(r.flaggedForRecount).toBe(true);
  });

  it.each([
    ['abc', '1'],
    ['1', 'abc'],
    ['', '1'],
    ['-1', '1'],
    ['1', '-5'],
    ['Infinity', '1'],
    ['1', 'NaN'],
  ])('rejects invalid quantities (%s, %s)', (systemQty, countedQty) => {
    expect(() => computeVariance({ ...base, systemQty, countedQty })).toThrow(RangeError);
  });

  it('rejects an invalid tolerance', () => {
    expect(() =>
      computeVariance({ systemQty: '1', countedQty: '1', defaultTolerancePct: 'x' }),
    ).toThrow(RangeError);
  });
});
