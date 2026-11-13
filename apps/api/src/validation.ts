import type { z } from 'zod';
import { AppError } from './errors';

// كل مدخل يمر عبر مخطط Zod؛ الخطأ يعيد المسار والرسالة فقط، لا القيمة المُدخلة (قد تكون كلمة مرور).
// Every input goes through a Zod schema; an error returns the path and message only, never the
// submitted value (it may be a password).
export const parseInput = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(
    'VALIDATION_ERROR',
    400,
    'Request validation failed',
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
};
