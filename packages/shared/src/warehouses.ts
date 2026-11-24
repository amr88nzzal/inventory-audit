import { z } from 'zod';
import { paginationSchema } from './pagination';

// رمز المستودع/الموقع: حروف لاتينية وأرقام وشرطتان، يبدأ بحرف أو رقم، حتى 32.
// Warehouse/location code: Latin letters, digits and dashes, starts alphanumeric, up to 32.
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const codeSchema = z.string().trim().regex(CODE_PATTERN, 'Invalid code');
const nameSchema = z.string().trim().min(1).max(120);
const versionSchema = z.number().int().positive();

export const createWarehouseSchema = z.object({ code: codeSchema, name: nameSchema }).strict();

// الرمز ثابت بعد الإنشاء (يُطبع على الأوراق ويُستعمل في الاستيراد). Code is immutable (printed on paper, used by imports).
export const updateWarehouseSchema = z
  .object({ version: versionSchema, name: nameSchema.optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Nothing to update' });

export const createLocationSchema = z.object({ code: codeSchema, name: nameSchema }).strict();
export const updateLocationSchema = updateWarehouseSchema;

export const WAREHOUSE_SORTS = ['code', 'name', 'createdAt'] as const;
export const warehouseListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  sort: z.enum(WAREHOUSE_SORTS).default('code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export const setUserWarehousesSchema = z
  .object({
    warehouseIds: z
      .array(z.uuid())
      .max(200)
      .refine((l) => new Set(l).size === l.length, { message: 'Duplicate warehouses' }),
  })
  .strict();

export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type WarehouseListQuery = z.infer<typeof warehouseListQuerySchema>;
export type SetUserWarehousesInput = z.infer<typeof setUserWarehousesSchema>;
