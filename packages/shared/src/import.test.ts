import type { ImportFileError } from './import';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_MAX_ROWS,
  ITEMS_IMPORT_TEMPLATE,
  normalizeNumberText,
  parseItemsCsv,
} from './import';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ImportFileError).code;
  }
  return undefined;
};

describe('parseItemsCsv', () => {
  it('يقبل أسماء أعمدة إنجليزية وعربية بأي ترتيب', () => {
    const r = parseItemsCsv('الاسم,الباركود,السعر,الفئة\nشاي,111,2.5,مشروبات');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, name: 'شاي', barcode: '111', price: '2.5', category: 'مشروبات' },
    ]);
  });

  it('الخلية الفارغة تُترك غير معرّفة (تُبقي القيمة الحالية)', () => {
    const r = parseItemsCsv('barcode,name,price\n111,A,');
    expect(r.rows[0]).toEqual({ line: 2, barcode: '111', name: 'A' });
  });

  it('يحوّل الأرقام العربية والفاصلة العربية', () => {
    expect(normalizeNumberText('١٢٫٥٠')).toBe('12.50');
    expect(normalizeNumberText('1,5')).toBe('1.5');
    const r = parseItemsCsv('barcode,name,price,tolerance_pct\n1,A,١٢٫٥,٢');
    expect(r.rows[0]).toMatchObject({ price: '12.5', tolerancePct: '2' });
  });

  it('أخطاء الصفوف بأرقام الأسطر والحقول ولا توقف بقية الصفوف', () => {
    const r = parseItemsCsv('barcode,name,price,tolerance_pct\n1,A,x,\n2,,1,\n3,C,1,101\n4,D,1,5');
    expect(r.rows.map((x) => x.barcode)).toEqual(['4']);
    expect(r.errors.map((e) => [e.line, e.field, e.code])).toEqual([
      [2, 'price', 'INVALID_VALUE'],
      [3, 'name', 'REQUIRED'],
      [4, 'tolerancePct', 'INVALID_VALUE'],
    ]);
    expect(r.totalRows).toBe(4);
  });

  it('يرصد تكرار الباركود والرمز داخل الملف على السطر الثاني', () => {
    const r = parseItemsCsv('barcode,name,sku\n1,A,S1\n1,B,S2\n2,C,s1');
    expect(r.rows.map((x) => x.barcode)).toEqual(['1']);
    expect(r.errors.map((e) => [e.line, e.field, e.code])).toEqual([
      [3, 'barcode', 'DUPLICATE_IN_FILE'],
      [4, 'sku', 'DUPLICATE_IN_FILE'],
    ]);
  });

  it('أخطاء الملف: فارغ، أعمدة ناقصة، مكرر، كثير الصفوف، اقتباس مفتوح', () => {
    expect(code(() => parseItemsCsv(''))).toBe('EMPTY_FILE');
    expect(code(() => parseItemsCsv('barcode,name'))).toBe('EMPTY_FILE');
    expect(code(() => parseItemsCsv('barcode,price\n1,2'))).toBe('MISSING_COLUMNS');
    expect(code(() => parseItemsCsv('barcode,الباركود,name\n1,2,3'))).toBe('DUPLICATE_COLUMNS');
    expect(code(() => parseItemsCsv('barcode,name\n"1,2'))).toBe('BAD_CSV');
    const big =
      'barcode,name\n' + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `${i},n`).join('\n');
    expect(code(() => parseItemsCsv(big))).toBe('TOO_MANY_ROWS');
  });

  it('الأعمدة المجهولة تُتجاهل وتُذكر', () => {
    const r = parseItemsCsv('barcode,name,color\n1,A,red');
    expect(r.ignoredColumns).toEqual(['color']);
    expect(r.rows[0]).toEqual({ line: 2, barcode: '1', name: 'A' });
  });

  it('القالب نفسه يُقرأ بلا أخطاء', () => {
    const r = parseItemsCsv(ITEMS_IMPORT_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
  });
});
