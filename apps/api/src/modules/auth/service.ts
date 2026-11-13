import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { ChangePasswordInput, LoginInput } from '@inventory/shared';
import type { AppConfig } from '../../config';
import { lookupCompanyId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import type { TokenService } from './tokens';

export interface AuthDeps {
  db: Kysely<Database>;
  config: AppConfig;
  tokens: TokenService;
}

export interface AuthContext {
  userId: string;
  companyId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: Date;
  user: AuthContext;
}

// رسالة واحدة لكل أسباب الفشل (شركة مجهولة، مستخدم مجهول، كلمة مرور خاطئة، حساب معطّل)
// فلا يستطيع المهاجم معرفة أي منها صحيح.
// One message for every failure reason (unknown company, unknown user, wrong password, disabled
// account) so an attacker cannot tell which part was right.
const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 401, 'Invalid company code, username or password');

type UserRow = {
  id: string;
  failed_login_count: number;
  locked_until: Date | null;
};

// يسجّل محاولة فاشلة ويقفل الحساب عند بلوغ الحد. إن انتهى قفل سابق نبدأ العدّ من الصفر.
// Records a failed attempt and locks the account at the limit. After an expired lock, counting restarts.
const recordFailure = async (
  trx: Transaction<Database>,
  user: UserRow,
  now: Date,
  config: AppConfig,
): Promise<Date | null> => {
  const base = user.locked_until && user.locked_until <= now ? 0 : user.failed_login_count;
  const failures = base + 1;
  const lockedUntil =
    failures >= config.loginMaxFailures
      ? new Date(now.getTime() + config.loginLockMinutes * 60_000)
      : null;
  await trx
    .updateTable('users')
    .set({ failed_login_count: failures, locked_until: lockedUntil, updated_at: now })
    .where('id', '=', user.id)
    .execute();
  return lockedUntil;
};

const lockedError = (until: Date, now: Date): AppError =>
  new AppError('ACCOUNT_LOCKED', 429, 'Account temporarily locked, try again later', {
    retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  });

type LoginOutcome =
  { kind: 'ok'; user: AuthContext } | { kind: 'invalid' } | { kind: 'locked'; until: Date };

export const login = async (
  deps: AuthDeps,
  input: LoginInput,
  now: Date = new Date(),
): Promise<LoginResult> => {
  const { db, config, tokens } = deps;

  const companyId = await lookupCompanyId(db, input.companyCode);
  if (!companyId) {
    await verifyAgainstDummy(input.password, config.passwordHashLogN);
    throw invalidCredentials();
  }

  // النتيجة تُعاد من المعاملة ثم نرمي الخطأ بعد تثبيتها، فلا يُلغى عدّاد المحاولات الفاشلة بالتراجع.
  // The outcome is returned from the transaction and the error thrown after it commits, so a
  // rollback never discards the failed-attempt counter.
  const outcome = await withTenant<LoginOutcome>(db, { companyId }, async ({ trx }) => {
    const user = await trx
      .selectFrom('users')
      .selectAll()
      .where(sql<string>`lower(username)`, '=', input.username.toLowerCase())
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!user || !user.active || !user.password_hash) {
      await verifyAgainstDummy(input.password, config.passwordHashLogN);
      return { kind: 'invalid' };
    }
    if (user.locked_until && user.locked_until > now) {
      return { kind: 'locked', until: user.locked_until };
    }

    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      const lockedUntil = await recordFailure(trx, user, now, config);
      return lockedUntil ? { kind: 'locked', until: lockedUntil } : { kind: 'invalid' };
    }

    await trx
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: now })
      .where('id', '=', user.id)
      .execute();

    return {
      kind: 'ok',
      user: {
        userId: user.id,
        companyId,
        username: user.username,
        displayName: user.display_name,
        mustChangePassword: user.must_change_password,
      },
    };
  });

  if (outcome.kind === 'locked') throw lockedError(outcome.until, now);
  if (outcome.kind === 'invalid') throw invalidCredentials();

  const issued = await tokens.sign(
    { userId: outcome.user.userId, companyId: outcome.user.companyId },
    now,
  );
  return { accessToken: issued.token, expiresAt: issued.expiresAt, user: outcome.user };
};

// يُستدعى عند كل طلب محمي: التوكن يثبت الهوية فقط، وحالة الحساب (معطّل، محذوف، كلمة مؤقتة)
// تُقرأ من القاعدة، فيسري التعطيل فوراً لا بعد انتهاء التوكن.
// Called on every protected request: the token proves identity only, and account state (disabled,
// deleted, temporary password) is read from the database, so a disable takes effect immediately
// rather than when the token expires.
export const loadAuthContext = (
  deps: AuthDeps,
  claims: { userId: string; companyId: string },
): Promise<AuthContext | null> =>
  withTenant(deps.db, { companyId: claims.companyId, userId: claims.userId }, async ({ trx }) => {
    const company = await trx
      .selectFrom('companies')
      .select('id')
      .where('id', '=', claims.companyId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!company) return null;

    const user = await trx
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'active', 'must_change_password'])
      .where('id', '=', claims.userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user || !user.active) return null;

    return {
      userId: user.id,
      companyId: claims.companyId,
      username: user.username,
      displayName: user.display_name,
      mustChangePassword: user.must_change_password,
    };
  });

export const changePassword = async (
  deps: AuthDeps,
  ctx: AuthContext,
  input: ChangePasswordInput,
  now: Date = new Date(),
): Promise<void> => {
  const { db, config } = deps;

  type Outcome = 'ok' | 'wrong_current' | { locked: Date };
  const outcome = await withTenant<Outcome>(
    db,
    { companyId: ctx.companyId, userId: ctx.userId },
    async ({ trx }) => {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'password_hash', 'failed_login_count', 'locked_until'])
        .where('id', '=', ctx.userId)
        .executeTakeFirstOrThrow();

      if (user.locked_until && user.locked_until > now) return { locked: user.locked_until };

      // التوكن المسروق لا يكفي لتغيير كلمة المرور بالتخمين: المحاولات الخاطئة تُعدّ وتقفل كما في الدخول.
      // A stolen token must not allow guessing the current password: failures are counted and lock as at login.
      const ok = user.password_hash
        ? await verifyPassword(input.currentPassword, user.password_hash)
        : false;
      if (!ok) {
        const lockedUntil = await recordFailure(trx, user, now, config);
        return lockedUntil ? { locked: lockedUntil } : 'wrong_current';
      }

      const newHash = await hashPassword(input.newPassword, config.passwordHashLogN);
      await trx
        .updateTable('users')
        .set({
          password_hash: newHash,
          must_change_password: false,
          password_changed_at: now,
          failed_login_count: 0,
          locked_until: null,
          updated_at: now,
          updated_by: ctx.userId,
        })
        .where('id', '=', ctx.userId)
        .execute();
      return 'ok';
    },
  );

  if (outcome === 'wrong_current') {
    throw new AppError('INVALID_CURRENT_PASSWORD', 400, 'Current password is incorrect');
  }
  if (outcome !== 'ok') throw lockedError(outcome.locked, now);
};
