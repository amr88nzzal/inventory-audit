import { z } from 'zod';

// مخططات مدخلات المصادقة: مصدر واحد للخادم والواجهة.
// Auth input schemas: a single source of truth for the server and the UI.

export const COMPANY_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const companyCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(COMPANY_CODE_PATTERN, 'Company code must be 3-32 characters: a-z, 0-9 and dashes');

export const usernameSchema = z.string().trim().min(1).max(64);

// الحد الأقصى يمنع إرهاق الخادم بكلمات مرور ضخمة قبل التجزئة.
// The upper bound stops huge passwords from exhausting the server before hashing.
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const loginSchema = z
  .object({
    companyCode: companyCodeSchema,
    username: usernameSchema,
    // عند الدخول لا نفرض سياسة الطول، فقد تكون كلمة المرور المؤقتة أقصر مستقبلاً.
    // At login we do not enforce the length policy; a temporary password may differ in future.
    password: z.string().min(1).max(256),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: newPasswordSchema,
  })
  .strict()
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'New password must differ from the current one',
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
