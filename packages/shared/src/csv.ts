// قارئ CSV وفق RFC 4180: اقتباس مزدوج، فواصل أسطر داخل الحقل، CRLF، وBOM. يكتشف الفاصل (، ؛ tab).
// An RFC 4180 CSV reader: double quotes, newlines inside fields, CRLF and BOM. Detects the delimiter.
export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvRow {
  // رقم السطر في الملف (يبدأ من 1) لإظهاره في تقرير الأخطاء. The 1-based file line, for error reports.
  line: number;
  cells: string[];
}

export class CsvError extends Error {
  constructor(
    public readonly code: 'UNTERMINATED_QUOTE',
    message: string,
  ) {
    super(message);
  }
}

// الفاصل الأكثر تكراراً في السطر الأول خارج الاقتباس؛ الفاصلة عند التعادل.
// The most frequent delimiter in the first line outside quotes; comma on a tie.
export const detectDelimiter = (text: string): CsvDelimiter => {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as CsvDelimiter] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
};

export const parseCsv = (input: string, delimiter?: CsvDelimiter): CsvRow[] => {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;

  const endField = (): void => {
    cells.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    // السطر الفارغ كلياً يُتجاهل. A fully empty line is skipped.
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: startLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
      wasQuoted = true;
    } else if (ch === sep) endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      startLine = line;
    } else field += ch;
  }
  if (quoted) throw new CsvError('UNTERMINATED_QUOTE', 'Unterminated quoted field');
  if (field !== '' || cells.length > 0 || wasQuoted) endRow();
  return rows;
};
