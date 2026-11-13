import { z } from 'zod';

// كتالوج الصلاحيات: ملف واحد هو المصدر لكل شيء. الصيغة `الوحدة.المورد.الفعل`.
// الصلاحية الجديدة تحتاج منحاً يدوياً للأدوار المخصصة القائمة (دور admin يملكها ضمنياً).
// The permission catalog: one file is the source of truth. Format `module.resource.action`.
// A new permission must be granted manually to existing custom roles (the admin role holds it implicitly).

export const PERMISSIONS = [
  'identity.role.read',
  'identity.role.create',
  'identity.role.update',
  'identity.role.delete',
  'identity.user.assign_role',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export const isPermission = (value: string): value is Permission => PERMISSION_SET.has(value);

/** رمز دور النظام الذي يملك كل الصلاحيات. The system role code that holds every permission. */
export const ADMIN_ROLE_CODE = 'admin';

export const permissionSchema = z
  .string()
  .refine(isPermission, { message: 'Unknown permission' }) as unknown as z.ZodType<Permission>;

const roleNameSchema = z.string().trim().min(1).max(64);
const roleDescriptionSchema = z.string().trim().max(500);
const permissionListSchema = z
  .array(permissionSchema)
  .max(PERMISSIONS.length)
  .refine((list) => new Set(list).size === list.length, { message: 'Duplicate permissions' });

export const createRoleSchema = z
  .object({
    name: roleNameSchema,
    description: roleDescriptionSchema.optional(),
    permissions: permissionListSchema,
  })
  .strict();

// version إلزامي للقفل المتفائل: تعديل بنسخة قديمة يُرفض بـ VERSION_CONFLICT.
// version is required for optimistic locking: an edit on a stale version is rejected with VERSION_CONFLICT.
export const updateRoleSchema = z
  .object({
    version: z.number().int().positive(),
    name: roleNameSchema.optional(),
    description: roleDescriptionSchema.nullable().optional(),
    permissions: permissionListSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.permissions !== undefined,
    {
      message: 'Nothing to update',
    },
  );

export const setUserRolesSchema = z
  .object({
    roleIds: z
      .array(z.uuid())
      .max(50)
      .refine((l) => new Set(l).size === l.length, { message: 'Duplicate roles' }),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type SetUserRolesInput = z.infer<typeof setUserRolesSchema>;
