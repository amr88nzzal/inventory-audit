import { describe, expect, it } from 'vitest';
import { CsvError, detectDelimiter, parseCsv } from './csv';

describe('parseCsv', () => {
  it('يقرأ الأساس ويتجاهل BOM وCRLF والأسطر الفارغة', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n');
    expect(rows.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it('يدعم الاقتباس والفاصلة وسطراً جديداً داخل الحقل و"" هروباً', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi""\nbye"\nz,w');
    expect(rows[1]!.cells).toEqual(['x, y', 'he said "hi"\nbye']);
    // السطر التالي يُحسب بعد السطر الجديد داخل الاقتباس. The next row's line counts the newline inside the quote.
    expect(rows[2]!.line).toBe(4);
  });

  it('يقتطع الفراغات خارج الاقتباس فقط', () => {
    expect(parseCsv('a,b\n  x  ,"  y  "')[1]!.cells).toEqual(['x', '  y  ']);
  });

  it('يكتشف الفاصل', () => {
    expect(detectDelimiter('a;b;c\n1,2,3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a,b;c')).toBe(',');
    expect(detectDelimiter('"a;b;c",d')).toBe(',');
    expect(parseCsv('a;b\n1;2')[1]!.cells).toEqual(['1', '2']);
  });

  it('آخر سطر بلا فاصل أسطر، وخلية أخيرة فارغة', () => {
    expect(parseCsv('a,b\n1,')[1]!.cells).toEqual(['1', '']);
    expect(parseCsv('')).toEqual([]);
  });

  it('اقتباس غير مغلق خطأ صريح', () => {
    expect(() => parseCsv('a,b\n"x,2')).toThrow(CsvError);
  });
});
