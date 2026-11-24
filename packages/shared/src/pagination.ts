import { z } from 'zod';

// ترقيم الصفحات من الخادم: page من 1، وpageSize الافتراضي 25 والأقصى 100.
// Server-side pagination: page from 1, pageSize defaults to 25, max 100.
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// معاملات الاستعلام نصوص؛ نحوّلها بصرامة (رقم صحيح فقط، لا "1e3" ولا "").
// Query parameters are strings; convert strictly (a plain integer only, no "1e3" and no "").
const intFromQuery = z
  .string()
  .regex(/^\d{1,9}$/, 'Must be a positive integer')
  .transform(Number);

export const paginationSchema = z.object({
  page: intFromQuery.pipe(z.number().int().min(1)).default(1),
  pageSize: intFromQuery
    .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
    .default(DEFAULT_PAGE_SIZE),
});

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const pageMeta = (page: number, pageSize: number, total: number): PageMeta => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

export const offsetOf = (page: number, pageSize: number): number => (page - 1) * pageSize;
