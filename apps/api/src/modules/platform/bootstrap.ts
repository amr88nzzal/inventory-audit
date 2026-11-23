import { withPlatform } from '../../db';
import { AppError } from '../../errors';
import { createPlatformAdmin } from './service';
import type { PlatformDeps } from './service';

export type BootstrapResult = 'created' | 'skipped_exists' | 'skipped_not_configured';

/**
 * ينشئ أول مدير منصة من متغيرات البيئة عند الإقلاع إن لم يوجد أي مدير. لا يلمس مديراً موجوداً أبداً
 * (تغيير كلمة المرور في البيئة لا يعيد تهيئة أحد)؛ إعادة التهيئة بأمر CLI صريح فقط.
 * Creates the first platform admin from environment variables at boot when none exists. It never
 * touches an existing admin (changing the password in the environment resets nobody); resetting is an explicit CLI command only.
 */
export const bootstrapPlatformAdmin = async (
  deps: Pick<PlatformDeps, 'db' | 'config'>,
  log: (entry: Record<string, unknown>) => void,
): Promise<BootstrapResult> => {
  const boot = deps.config.platform.bootstrap;
  if (!boot) return 'skipped_not_configured';

  const anyAdmin = await withPlatform(deps.db, (trx) =>
    trx.selectFrom('platform_admins').select('id').limit(1).executeTakeFirst(),
  );
  if (anyAdmin) {
    log({
      level: 'warn',
      msg: 'platform admin already exists; remove PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD from the environment',
    });
    return 'skipped_exists';
  }

  try {
    await createPlatformAdmin(deps, { username: boot.username, password: boot.password });
  } catch (err) {
    // نسختان تقلعان معاً: الثانية تخسر السباق على الاسم الفريد وهذا سليم.
    // Two instances booting together: the second loses the race on the unique username, which is fine.
    if (err instanceof AppError && err.code === 'USERNAME_TAKEN') return 'skipped_exists';
    throw err;
  }
  // لا نسجّل كلمة المرور ولا أي سر. We never log the password or any secret.
  log({
    level: 'warn',
    msg: 'platform admin created from the environment; sign in to enroll TOTP and then remove PLATFORM_ADMIN_PASSWORD from the environment',
    username: boot.username,
  });
  return 'created';
};
