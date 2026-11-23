import { newPasswordSchema } from '@inventory/shared';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { AppConfig } from '../../config';
import type { FieldCrypto } from '../../crypto/encryption';
import { newId, withPlatform } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth';
import { generateTotpSecret, otpauthUri, stepAt, verifyTotp } from './totp';
import type { PlatformTokenService } from './tokens';

export interface PlatformDeps {
  db: Kysely<Database>;
  config: AppConfig;
  crypto: FieldCrypto;
  tokens: PlatformTokenService;
}

export interface PlatformIdentity {
  adminId: string;
  username: string;
  displayName: string;
}

const ISSUER = 'Inventory Audit';
const totpContext = (adminId: string): string => `platform_admins:${adminId}:totp`;

const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 401, 'Invalid username or password');
const invalidCode = (): AppError =>
  new AppError('INVALID_CODE', 401, 'Invalid or expired verification code');
const invalidStepToken = (): AppError =>
  new AppError('INVALID_STEP_TOKEN', 401, 'Sign-in step expired, start again');
const lockedError = (until: Date, now: Date): AppError =>
  new AppError('ACCOUNT_LOCKED', 429, 'Account temporarily locked, try again later', {
    retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  });

type AdminRow = {
  id: string;
  failed_login_count: number;
  locked_until: Date | null;
};

// نفس سياسة قفل مستخدمي الشركات: المحاولات الخاطئة (كلمة مرور أو رمز) تُعدّ معاً وتقفل الحساب.
// The same lock policy as company users: wrong attempts (password or code) count together and lock the account.
const recordFailure = async (
  trx: Transaction<Database>,
  admin: AdminRow,
  now: Date,
  config: AppConfig,
): Promise<Date | null> => {
  const base = admin.locked_until && admin.locked_until <= now ? 0 : admin.failed_login_count;
  const failures = base + 1;
  const lockedUntil =
    failures >= config.loginMaxFailures
      ? new Date(now.getTime() + config.loginLockMinutes * 60_000)
      : null;
  await trx
    .updateTable('platform_admins')
    .set({ failed_login_count: failures, locked_until: lockedUntil, updated_at: now })
    .where('id', '=', admin.id)
    .execute();
  return lockedUntil;
};

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

// ---------------------------------------------------------------- إنشاء | creation

/**
 * ينشئ مدير منصة بكلمة مرور مؤقتة؛ يُستعمل من CLI ومن الإنشاء عند الإقلاع.
 * Creates a platform admin with a temporary password; used by the CLI and the boot-time bootstrap.
 */
export const createPlatformAdmin = async (
  deps: Pick<PlatformDeps, 'db' | 'config'>,
  input: { username: string; displayName?: string; password: string },
): Promise<{ id: string }> => {
  const username = input.username.trim();
  if (username.length < 3 || username.length > 64) {
    throw new AppError('VALIDATION_ERROR', 400, 'Username must be 3 to 64 characters');
  }
  const pw = newPasswordSchema.safeParse(input.password);
  if (!pw.success) throw new AppError('VALIDATION_ERROR', 400, 'Password is too short or too long');

  const id = newId();
  const hash = await hashPassword(input.password, deps.config.passwordHashLogN);
  try {
    await withPlatform(deps.db, (trx) =>
      trx
        .insertInto('platform_admins')
        .values({
          id,
          username,
          display_name: input.displayName?.trim() || username,
          password_hash: hash,
        })
        .execute(),
    );
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('USERNAME_TAKEN', 409, 'Username already exists');
    throw err;
  }
  return { id };
};

/**
 * يعيد تهيئة مدير: كلمة مرور مؤقتة جديدة ويُمحى ربط TOTP وتبطل توكناته. لضياع الجهاز أو كلمة المرور.
 * Resets an admin: a new temporary password, TOTP enrollment cleared, tokens voided. For a lost device or password.
 */
export const resetPlatformAdmin = async (
  deps: Pick<PlatformDeps, 'db' | 'config'>,
  username: string,
  password: string,
): Promise<boolean> => {
  if (!newPasswordSchema.safeParse(password).success) {
    throw new AppError('VALIDATION_ERROR', 400, 'Password is too short or too long');
  }
  const hash = await hashPassword(password, deps.config.passwordHashLogN);
  return withPlatform(deps.db, async (trx) => {
    const res = await trx
      .updateTable('platform_admins')
      .set((eb) => ({
        password_hash: hash,
        must_change_password: true,
        totp_secret_enc: null,
        totp_enrolled_at: null,
        totp_last_step: null,
        failed_login_count: 0,
        locked_until: null,
        active: true,
        token_version: eb('token_version', '+', 1),
        updated_at: new Date(),
      }))
      .where(sql<string>`lower(username)`, '=', username.trim().toLowerCase())
      .executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  });
};

// ---------------------------------------------------------------- دخول | sign-in

export type LoginStep =
  | { step: 'totp'; mfaToken: string }
  | {
      step: 'enroll';
      enrollToken: string;
      totp: { secret: string; otpauthUri: string };
      mustChangePassword: boolean;
    };

type LoginOutcome =
  | { kind: 'totp'; adminId: string; tv: number }
  | {
      kind: 'enroll';
      adminId: string;
      tv: number;
      secret: string;
      uri: string;
      mustChange: boolean;
    }
  | { kind: 'invalid' }
  | { kind: 'locked'; until: Date };

export const login = async (
  deps: PlatformDeps,
  input: { username: string; password: string },
  now: Date = new Date(),
): Promise<LoginStep> => {
  const { db, config, crypto, tokens } = deps;

  // النتيجة تُعاد من المعاملة ثم يُرمى الخطأ بعد تثبيتها كي لا يُلغى عدّاد الفشل بالتراجع.
  // The outcome is returned from the transaction and the error thrown after it commits, so a rollback never discards the failure counter.
  const outcome = await withPlatform<LoginOutcome>(db, async (trx) => {
    const admin = await trx
      .selectFrom('platform_admins')
      .selectAll()
      .where(sql<string>`lower(username)`, '=', input.username.trim().toLowerCase())
      .executeTakeFirst();

    if (!admin || !admin.active) {
      await verifyAgainstDummy(input.password, config.passwordHashLogN);
      return { kind: 'invalid' };
    }
    if (admin.locked_until && admin.locked_until > now) {
      return { kind: 'locked', until: admin.locked_until };
    }
    if (!(await verifyPassword(input.password, admin.password_hash))) {
      const lockedUntil = await recordFailure(trx, admin, now, config);
      return lockedUntil ? { kind: 'locked', until: lockedUntil } : { kind: 'invalid' };
    }
    // لا نصفّر العدّاد هنا: يُصفَّر بنجاح TOTP فقط، فلا يُخمَّن الرمز بدورات دخول متتالية.
    // We do not reset the counter here: only a TOTP success does, so the code cannot be guessed across repeated sign-ins.

    if (admin.totp_enrolled_at) return { kind: 'totp', adminId: admin.id, tv: admin.token_version };

    // غير مربوط: نولّد سراً جديداً (يُستبدل في كل دخول حتى يكتمل الربط) ونعرضه الآن فقط.
    // Not enrolled: generate a fresh secret (replaced on each sign-in until enrollment completes) and show it now only.
    const secret = generateTotpSecret();
    await trx
      .updateTable('platform_admins')
      .set({
        totp_secret_enc: crypto.encrypt(secret, totpContext(admin.id)),
        updated_at: now,
      })
      .where('id', '=', admin.id)
      .execute();
    return {
      kind: 'enroll',
      adminId: admin.id,
      tv: admin.token_version,
      secret,
      uri: otpauthUri(ISSUER, admin.username, secret),
      mustChange: admin.must_change_password,
    };
  });

  if (outcome.kind === 'locked') throw lockedError(outcome.until, now);
  if (outcome.kind === 'invalid') throw invalidCredentials();

  const claims = { adminId: outcome.adminId, tokenVersion: outcome.tv };
  if (outcome.kind === 'totp') {
    return { step: 'totp', mfaToken: (await tokens.sign('mfa', claims, now)).token };
  }
  return {
    step: 'enroll',
    enrollToken: (await tokens.sign('enroll', claims, now)).token,
    totp: { secret: outcome.secret, otpauthUri: outcome.uri },
    mustChangePassword: outcome.mustChange,
  };
};

export interface PlatformSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: Date;
  admin: PlatformIdentity;
}

type CodeOutcome =
  | { kind: 'ok'; admin: PlatformIdentity; tv: number }
  | { kind: 'bad_token' }
  | { kind: 'bad_code' }
  | { kind: 'locked'; until: Date };

// يتحقق من رمز TOTP لمدير بتوكن مرحلة. mode='verify' للمربوط، 'enroll' لإكمال الربط وتغيير كلمة المرور.
// Verifies a TOTP code for an admin holding a step token. 'verify' is for enrolled admins; 'enroll' completes enrollment and the password change.
const checkCode = async (
  deps: PlatformDeps,
  mode: 'verify' | 'enroll',
  adminId: string,
  tokenVersion: number,
  code: string,
  newPassword: string | undefined,
  now: Date,
): Promise<CodeOutcome> => {
  const { db, config, crypto } = deps;
  return withPlatform<CodeOutcome>(db, async (trx) => {
    // قفل الصف: رمزان متزامنان لا يقبلان معاً (يمنع التفاف حماية إعادة الاستعمال).
    // Row lock: two concurrent codes cannot both be accepted (closes a race around replay protection).
    const admin = await trx
      .selectFrom('platform_admins')
      .selectAll()
      .where('id', '=', adminId)
      .forUpdate()
      .executeTakeFirst();

    if (!admin || !admin.active || admin.token_version !== tokenVersion) {
      return { kind: 'bad_token' };
    }
    if ((mode === 'verify') !== Boolean(admin.totp_enrolled_at)) return { kind: 'bad_token' };
    if (!admin.totp_secret_enc) return { kind: 'bad_token' };
    if (admin.locked_until && admin.locked_until > now) {
      return { kind: 'locked', until: admin.locked_until };
    }
    if (mode === 'enroll' && admin.must_change_password && newPassword === undefined) {
      throw new AppError('VALIDATION_ERROR', 400, 'A new password is required', [
        { path: 'newPassword', message: 'Required for the first sign-in' },
      ]);
    }

    const secret = crypto.decrypt(admin.totp_secret_enc, totpContext(admin.id));
    const last = admin.totp_last_step === null ? null : Number(admin.totp_last_step);
    const step = verifyTotp(secret, code, now.getTime(), last);
    if (step === null) {
      const lockedUntil = await recordFailure(trx, admin, now, config);
      return lockedUntil ? { kind: 'locked', until: lockedUntil } : { kind: 'bad_code' };
    }

    const changes: Record<string, unknown> = {
      totp_last_step: String(step),
      failed_login_count: 0,
      locked_until: null,
      last_login_at: now,
      updated_at: now,
    };
    let tv = admin.token_version;
    if (mode === 'enroll') {
      changes['totp_enrolled_at'] = now;
      if (admin.must_change_password) {
        // كلمة المرور المؤقتة (من البيئة) لا تبقى صالحة بعد الربط، وتبطل التوكنات القديمة.
        // The temporary password (from the environment) stops being valid after enrollment, and old tokens are voided.
        changes['password_hash'] = await hashPassword(newPassword!, config.passwordHashLogN);
        changes['must_change_password'] = false;
        changes['token_version'] = tv + 1;
        tv += 1;
      }
    }
    await trx.updateTable('platform_admins').set(changes).where('id', '=', admin.id).execute();
    return {
      kind: 'ok',
      tv,
      admin: { adminId: admin.id, username: admin.username, displayName: admin.display_name },
    };
  });
};

const finish = async (
  deps: PlatformDeps,
  outcome: CodeOutcome,
  now: Date,
): Promise<PlatformSession> => {
  if (outcome.kind === 'locked') throw lockedError(outcome.until, now);
  if (outcome.kind === 'bad_token') throw invalidStepToken();
  if (outcome.kind === 'bad_code') throw invalidCode();
  const issued = await deps.tokens.sign(
    'access',
    { adminId: outcome.admin.adminId, tokenVersion: outcome.tv },
    now,
  );
  return {
    accessToken: issued.token,
    tokenType: 'Bearer',
    expiresAt: issued.expiresAt,
    admin: outcome.admin,
  };
};

export const verifyLoginCode = async (
  deps: PlatformDeps,
  input: { mfaToken: string; code: string },
  now: Date = new Date(),
): Promise<PlatformSession> => {
  const claims = await deps.tokens.verify('mfa', input.mfaToken);
  if (!claims) throw invalidStepToken();
  const outcome = await checkCode(
    deps,
    'verify',
    claims.adminId,
    claims.tokenVersion,
    input.code,
    undefined,
    now,
  );
  return finish(deps, outcome, now);
};

export const completeEnrollment = async (
  deps: PlatformDeps,
  input: { enrollToken: string; code: string; newPassword?: string | undefined },
  now: Date = new Date(),
): Promise<PlatformSession> => {
  const claims = await deps.tokens.verify('enroll', input.enrollToken);
  if (!claims) throw invalidStepToken();
  const outcome = await checkCode(
    deps,
    'enroll',
    claims.adminId,
    claims.tokenVersion,
    input.code,
    input.newPassword,
    now,
  );
  return finish(deps, outcome, now);
};

// ---------------------------------------------------------------- كل طلب | per request

/** حالة المدير تُقرأ من القاعدة عند كل طلب: التعطيل وإعادة التهيئة يسريان فوراً. Admin state is read from the database on every request: disabling or resetting takes effect at once. */
export const loadPlatformIdentity = (
  deps: Pick<PlatformDeps, 'db'>,
  claims: { adminId: string; tokenVersion: number },
): Promise<PlatformIdentity | null> =>
  withPlatform(deps.db, async (trx) => {
    const admin = await trx
      .selectFrom('platform_admins')
      .select(['id', 'username', 'display_name', 'active', 'token_version', 'totp_enrolled_at'])
      .where('id', '=', claims.adminId)
      .executeTakeFirst();
    if (!admin || !admin.active || !admin.totp_enrolled_at) return null;
    if (admin.token_version !== claims.tokenVersion) return null;
    return { adminId: admin.id, username: admin.username, displayName: admin.display_name };
  });

export { stepAt };
