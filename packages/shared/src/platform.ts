import { z } from 'zod';
import { companyCodeSchema, newPasswordSchema, usernameSchema } from './auth';

// مدخلات دخول مدير المنصة (خطوتان: كلمة المرور ثم رمز TOTP، أو ربط TOTP عند أول دخول).
// Platform admin sign-in inputs (two steps: password, then TOTP code; or TOTP enrollment on first sign-in).

const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');
const stepTokenSchema = z.string().min(20).max(2048);

export const platformLoginSchema = z
  .object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) })
  .strict();

export const platformVerifySchema = z
  .object({ mfaToken: stepTokenSchema, code: totpCodeSchema })
  .strict();

export const platformEnrollSchema = z
  .object({
    enrollToken: stepTokenSchema,
    code: totpCodeSchema,
    newPassword: newPasswordSchema.optional(),
  })
  .strict();

export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;
export type PlatformVerifyInput = z.infer<typeof platformVerifySchema>;
export type PlatformEnrollInput = z.infer<typeof platformEnrollSchema>;

// إنشاء شركة مع أدمنها الأول. كلمة المرور لا يرسلها العميل: يولّدها الخادم وتُعرض مرة واحدة.
// Creating a company with its first admin. The client never sends the password: the server generates it and shows it once.
export const createCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    code: companyCodeSchema,
    admin: z
      .object({
        username: usernameSchema,
        displayName: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
  })
  .strict();
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
