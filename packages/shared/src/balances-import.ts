import { CsvError, parseCsv } from './csv';
import { IMPORT_MAX_ROWS, ImportFileError, normalizeNumberText } from './import';
import type { ImportRowError } from './import';
import { normalizeSearch } from './search';

// لقطة الرصيد النظري: عمودان إلزاميان فقط (الباركود والكمية بالوحدة الأساسية).
// The theoretical-balance snapshot: just two required columns (barcode and quantity in the base unit).
export type BalanceField = 'barcode' | 'quantity';

const ALIASES: Record<BalanceField, string[]> = {
  barcode: ['barcode', 'الباركود', 'باركود'],
  quantity: ['quantity', 'qty', 'balance', 'stock', 'الكمية', 'كمية', 'الرصيد', 'رصيد'],
};
const headerKey = (h: string): string => normalizeSearch(h).replace(/[\s_\-.]/g, '');
const INDEX: ReadonlyMap<string, BalanceField> = new Map(
  (Object.entries(ALIASES) as [BalanceField, string[]][]).flatMap(([f, names]) =>
    names.map((n) => [headerKey(n), f] as const),
  ),
);

// نص عشري غير سالب بحد أقصى 3 منازل (يطابق numeric(18,3)). A non-negative decimal with at most 3 places (matches numeric(18,3)).
export const BALANCE_PATTERN = /^\d{1,15}(\.\d{1,3})?$/;
const BARCODE_PATTERN = /^[^\s\p{Cc}]{1,64}$/u;

export interface BalanceRow {
  line: number;
  barcode: string;
  quantity: string;
}
export interface ParsedBalances {
  rows: BalanceRow[];
  errors: ImportRowError[];
  ignoredColumns: string[];
  totalRows: number;
}

export const parseBalancesCsv = (text: string): ParsedBalances => {
  let table;
  try {
    table = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) throw new ImportFileError('BAD_CSV', e.message);
    throw e;
  }
  const header = table[0];
  if (!header) throw new ImportFileError('EMPTY_FILE', 'The file is empty');
  const body = table.slice(1);
  if (body.length === 0) throw new ImportFileError('EMPTY_FILE', 'The file has no data rows');
  if (body.length > IMPORT_MAX_ROWS)
    throw new ImportFileError('TOO_MANY_ROWS', `At most ${IMPORT_MAX_ROWS} rows per import`, {
      max: IMPORT_MAX_ROWS,
      got: body.length,
    });

  const column = new Map<BalanceField, number>();
  const ignoredColumns: string[] = [];
  const duplicated: string[] = [];
  header.cells.forEach((h, i) => {
    const f = INDEX.get(headerKey(h));
    if (!f) {
      if (h !== '') ignoredColumns.push(h);
    } else if (column.has(f)) duplicated.push(h);
    else column.set(f, i);
  });
  if (duplicated.length > 0)
    throw new ImportFileError('DUPLICATE_COLUMNS', 'A column appears twice', {
      columns: duplicated,
    });
  const missing = (['barcode', 'quantity'] as const).filter((f) => !column.has(f));
  if (missing.length > 0)
    throw new ImportFileError('MISSING_COLUMNS', 'Required columns are missing', { missing });

  const rows: BalanceRow[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Map<string, number>();
  for (const r of body) {
    const barcode = r.cells[column.get('barcode')!] ?? '';
    const rawQty = r.cells[column.get('quantity')!] ?? '';
    const before = errors.length;
    if (barcode === '')
      errors.push({ line: r.line, field: null, code: 'REQUIRED', message: 'Barcode is required' });
    else if (!BARCODE_PATTERN.test(barcode))
      errors.push({ line: r.line, field: null, code: 'INVALID_VALUE', message: 'Invalid barcode' });
    // الكمية الفارغة خطأ هنا (بعكس الأصناف): الرصيد الغائب ليس صفراً. A blank quantity is an error here: a missing balance is not zero.
    const quantity = normalizeNumberText(rawQty);
    if (rawQty === '')
      errors.push({ line: r.line, field: null, code: 'REQUIRED', message: 'Quantity is required' });
    else if (!BALANCE_PATTERN.test(quantity))
      errors.push({
        line: r.line,
        field: null,
        code: 'INVALID_VALUE',
        message: 'Quantity must be a non-negative number with at most 3 decimals',
      });
    if (barcode !== '' && BARCODE_PATTERN.test(barcode)) {
      const first = seen.get(barcode);
      if (first !== undefined)
        errors.push({
          line: r.line,
          field: null,
          code: 'DUPLICATE_IN_FILE',
          message: `Barcode already appears on line ${first}`,
        });
      else seen.set(barcode, r.line);
    }
    if (errors.length === before) rows.push({ line: r.line, barcode, quantity });
  }
  return { rows, errors, ignoredColumns, totalRows: body.length };
};

export const BALANCES_IMPORT_TEMPLATE =
  '﻿barcode,quantity\r\n9900000000011,120\r\n9900000000028,36.5\r\n';
