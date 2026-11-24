import { z } from 'zod';
import { paginationSchema } from './pagination';
import { DECIMAL_PATTERN } from './units';

// الباركود: بلا فراغات، حتى 64 حرفاً (يشمل EAN/UPC/Code128 وأكواد داخلية).
// Barcode: no whitespace, up to 64 chars (EAN/UPC/Code128 and internal codes).
export const BARCODE_PATTERN = /^[^\s\p{Cc}]{1,64}$/u;
const barcodeSchema = z.string().trim().regex(BARCODE_PATTERN, 'Invalid barcode');
const nameSchema = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(120);

// مبلغ بأربع خانات عشرية كحد أقصى؛ نص لا رقم. An amount with at most 4 decimals; a string, never a number.
const priceSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Invalid amount');
// نسبة مئوية 0–100 بأربع خانات. A percentage 0–100 with up to 4 decimals.
const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Invalid percentage')
  .refine((v) => Number(v) <= 100, { message: 'Must be at most 100' });
// معامل الوحدة: أكبر من 1 (الأساسية ضمنية بمعامل 1). A unit factor: greater than 1 (the base unit is implicit, factor 1).
const factorSchema = z
  .string()
  .trim()
  .regex(DECIMAL_PATTERN, 'Invalid factor')
  .refine((v) => Number(v) > 1, { message: 'Factor must be greater than 1' });

export const itemUnitSchema = z.object({ name: shortText, factor: factorSchema }).strict();

const unitsSchema = z
  .array(itemUnitSchema)
  .max(10)
  .refine((u) => new Set(u.map((x) => x.name.toLowerCase())).size === u.length, {
    message: 'Duplicate unit names',
  });

export const createItemSchema = z
  .object({
    barcode: barcodeSchema,
    sku: shortText.optional(),
    name: nameSchema,
    price: priceSchema.optional(),
    supplier: shortText.optional(),
    category: shortText.optional(),
    accountNo: shortText.optional(),
    baseUnit: shortText.default('قطعة'),
    tolerancePct: percentSchema.optional(),
    units: unitsSchema.default([]),
  })
  .strict()
  .refine((v) => !v.units.some((u) => u.name.toLowerCase() === v.baseUnit.toLowerCase()), {
    message: 'A unit cannot repeat the base unit name',
    path: ['units'],
  });

// null يمسح الحقل الاختياري. null clears an optional field. الباركود قابل للتعديل (يُطبع الملصق من جديد).
// The barcode may change (labels get reprinted).
export const updateItemSchema = z
  .object({
    version: z.number().int().positive(),
    barcode: barcodeSchema.optional(),
    sku: shortText.nullable().optional(),
    name: nameSchema.optional(),
    price: priceSchema.nullable().optional(),
    supplier: shortText.nullable().optional(),
    category: shortText.nullable().optional(),
    accountNo: shortText.nullable().optional(),
    baseUnit: shortText.optional(),
    tolerancePct: percentSchema.nullable().optional(),
    units: unitsSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'Nothing to update' });

export const ITEM_SORTS = ['name', 'barcode', 'createdAt', 'price'] as const;
export const itemListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(120).optional(),
  supplier: z.string().trim().max(120).optional(),
  active: z.enum(['true', 'false']).optional(),
  sort: z.enum(ITEM_SORTS).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ItemListQuery = z.infer<typeof itemListQuerySchema>;
export type ItemUnitInput = z.infer<typeof itemUnitSchema>;
