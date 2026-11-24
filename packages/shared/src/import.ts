import { parseCsv, CsvError } from './csv';
import { barcodeSchema, nameSchema, percentSchema, priceSchema, shortText } from './items';
import { normalizeSearch } from './search';

// حدود الاستيراد: تحمي الذاكرة والمعاملة. Import limits: they protect memory and the transaction.
export const IMPORT_MAX_ROWS = 20_000;
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_ERRORS_CAP = 200;

export type ImportField =
  | 'barcode'
  | 'name'
  | 'sku'
  | 'price'
  | 'supplier'
  | 'category'
  | 'accountNo'
  | 'baseUnit'
  | 'tolerancePct';

// أسماء الأعمدة المقبولة (بعد التطبيع: حروف صغيرة، بلا فراغات أو _ أو -، وأشكال الألف واحدة).
// Accepted column names (normalised: lowercase, no spaces/_/-, one alef form).
const ALIASES: Record<ImportField, string[]> = {
  barcode: ['barcode', 'الباركود', 'باركود'],
  name: ['name', 'itemname', 'الاسم', 'اسمالصنف', 'اسم'],
  sku: ['sku', 'code', 'itemcode', 'الرمز', 'رمزالصنف', 'رقمالصنف'],
  price: ['price', 'السعر', 'سعر'],
  supplier: ['supplier', 'vendor', 'المورد', 'مورد'],
  category: ['category', 'group', 'الفئة', 'فئة', 'المجموعة'],
  accountNo: ['accountno', 'account', 'رقمالحساب', 'الحساب'],
  baseUnit: ['unit', 'baseunit', 'الوحدة', 'وحدة', 'الوحدهالاساسيه', 'الوحدةالاساسية'],
  tolerancePct: ['tolerancepct', 'tolerance', 'نسبةالتفاوت', 'التفاوت'],
};

const headerKey = (h: string): string => normalizeSearch(h).replace(/[\s_\-.]/g, '');
const ALIAS_INDEX: ReadonlyMap<string, ImportField> = new Map(
  (Object.entries(ALIASES) as [ImportField, string[]][]).flatMap(([field, names]) =>
    names.map((n) => [headerKey(n), field] as const),
  ),
);

export interface ImportRow {
  line: number;
  barcode: string;
  name: string;
  sku?: string;
  price?: string;
  supplier?: string;
  category?: string;
  accountNo?: string;
  baseUnit?: string;
  tolerancePct?: string;
}

export interface ImportRowError {
  line: number;
  field: ImportField | null;
  code: string;
  message: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: ImportRowError[];
  // أعمدة لم يُعرف اسمها فتجاهلناها. Columns we did not recognise and ignored.
  ignoredColumns: string[];
  totalRows: number;
}

export class ImportFileError extends Error {
  constructor(
    public readonly code:
      'EMPTY_FILE' | 'MISSING_COLUMNS' | 'TOO_MANY_ROWS' | 'BAD_CSV' | 'DUPLICATE_COLUMNS',
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// الأرقام العربية-الهندية والفاصلة العربية تُحوَّل لتقبل الأرقام من أي لوحة مفاتيح.
// Arabic-Indic digits and the Arabic decimal mark are converted so any keyboard works.
export const normalizeNumberText = (v: string): string =>
  v
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.')
    .replace(/[٬\s]/g, '');

const FIELD_SCHEMAS = {
  barcode: barcodeSchema,
  name: nameSchema,
  sku: shortText,
  price: priceSchema,
  supplier: shortText,
  category: shortText,
  accountNo: shortText,
  baseUnit: shortText,
  tolerancePct: percentSchema,
} as const;
const NUMERIC: ReadonlySet<ImportField> = new Set<ImportField>(['price', 'tolerancePct']);
const REQUIRED: readonly ImportField[] = ['barcode', 'name'];

export const parseItemsCsv = (text: string): ParsedImport => {
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

  const columnOf = new Map<ImportField, number>();
  const ignoredColumns: string[] = [];
  const duplicated: string[] = [];
  header.cells.forEach((h, i) => {
    const field = ALIAS_INDEX.get(headerKey(h));
    if (!field) {
      if (h !== '') ignoredColumns.push(h);
    } else if (columnOf.has(field)) duplicated.push(h);
    else columnOf.set(field, i);
  });
  if (duplicated.length > 0)
    throw new ImportFileError('DUPLICATE_COLUMNS', 'A column appears twice', {
      columns: duplicated,
    });
  const missing = REQUIRED.filter((f) => !columnOf.has(f));
  if (missing.length > 0)
    throw new ImportFileError('MISSING_COLUMNS', 'Required columns are missing', { missing });

  const rows: ImportRow[] = [];
  const errors: ImportRowError[] = [];
  const seenBarcode = new Map<string, number>();
  const seenSku = new Map<string, number>();

  for (const r of body) {
    const out: Record<string, string> = {};
    const rowErrors: ImportRowError[] = [];
    for (const [field, idx] of columnOf) {
      const raw = r.cells[idx] ?? '';
      if (raw === '') continue; // الخلية الفارغة = اترك القيمة كما هي. Blank = leave the value as it is.
      const value = NUMERIC.has(field) ? normalizeNumberText(raw) : raw;
      const parsed = FIELD_SCHEMAS[field].safeParse(value);
      if (parsed.success) out[field] = parsed.data;
      else
        rowErrors.push({
          line: r.line,
          field,
          code: 'INVALID_VALUE',
          message: parsed.error.issues[0]?.message ?? 'Invalid value',
        });
    }
    for (const f of REQUIRED)
      if (!out[f] && !rowErrors.some((e) => e.field === f))
        rowErrors.push({ line: r.line, field: f, code: 'REQUIRED', message: 'Required' });

    if (out['barcode']) {
      const first = seenBarcode.get(out['barcode']);
      if (first !== undefined)
        rowErrors.push({
          line: r.line,
          field: 'barcode',
          code: 'DUPLICATE_IN_FILE',
          message: `Barcode already appears on line ${first}`,
        });
      else seenBarcode.set(out['barcode'], r.line);
    }
    if (out['sku']) {
      const key = out['sku'].toLowerCase();
      const first = seenSku.get(key);
      if (first !== undefined)
        rowErrors.push({
          line: r.line,
          field: 'sku',
          code: 'DUPLICATE_IN_FILE',
          message: `Code already appears on line ${first}`,
        });
      else seenSku.set(key, r.line);
    }

    if (rowErrors.length > 0) errors.push(...rowErrors);
    else rows.push({ line: r.line, ...(out as Omit<ImportRow, 'line'>) });
  }
  return { rows, errors, ignoredColumns, totalRows: body.length };
};

// قالب جاهز للتنزيل: BOM كي يفتحه Excel بالعربية صحيحاً. A downloadable template; BOM so Excel opens Arabic correctly.
export const ITEMS_IMPORT_TEMPLATE =
  '﻿barcode,name,sku,price,category,supplier,unit,tolerance_pct,account_no\r\n' +
  '6281000000011,"مثال: عصير برتقال 1 لتر",SKU-001,1.25,مشروبات,مورد المثال,قطعة,2,\r\n';
