import { describe, expect, it } from 'vitest';
import { BALANCES_IMPORT_TEMPLATE, parseBalancesCsv } from './balances-import';
import type { ImportFileError } from './import';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ImportFileError).code;
  }
  return undefined;
};

describe('parseBalancesCsv', () => {
  it('reads barcode and quantity under English or Arabic headers, any order', () => {
    const r = parseBalancesCsv('الكمية;الباركود\n٣٦٫٥;111\n0;222');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, barcode: '111', quantity: '36.5' },
      { line: 3, barcode: '222', quantity: '0' },
    ]);
  });

  it('a blank quantity is an error (a missing balance is not zero)', () => {
    const r = parseBalancesCsv('barcode,quantity\n111,\n222,5');
    expect(r.rows.map((x) => x.barcode)).toEqual(['222']);
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, code: 'REQUIRED' })]);
  });

  it('rejects negatives, 4 decimals, text and a missing barcode, line by line', () => {
    const r = parseBalancesCsv(
      'barcode,quantity\n1,-5\n2,1.2345\n3,abc\n,4\n4,1e3\n5,12.345\n6,1,5',
    );
    expect(r.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'INVALID_VALUE'],
      [3, 'INVALID_VALUE'],
      [4, 'INVALID_VALUE'],
      [5, 'REQUIRED'],
      [6, 'INVALID_VALUE'],
    ]);
    expect(r.rows.map((x) => x.barcode)).toEqual(['5', '6']);
  });

  it('flags a repeated barcode on its second line', () => {
    const r = parseBalancesCsv('barcode,quantity\n1,5\n1,6');
    expect(r.errors).toEqual([expect.objectContaining({ line: 3, code: 'DUPLICATE_IN_FILE' })]);
    expect(r.rows).toHaveLength(1);
  });

  it('file-level errors', () => {
    expect(code(() => parseBalancesCsv(''))).toBe('EMPTY_FILE');
    expect(code(() => parseBalancesCsv('barcode\n1'))).toBe('MISSING_COLUMNS');
    expect(code(() => parseBalancesCsv('barcode,quantity,qty\n1,2,3'))).toBe('DUPLICATE_COLUMNS');
    expect(code(() => parseBalancesCsv('barcode,quantity\n"1,2'))).toBe('BAD_CSV');
  });

  it('the template reads back cleanly', () => {
    const r = parseBalancesCsv(BALANCES_IMPORT_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });
});
