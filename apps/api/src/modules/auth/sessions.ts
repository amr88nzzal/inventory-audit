import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from 'kysely';
import { newId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';
import type { AuthContext, AuthDeps } from './service';

// الجلسات وتوكن التحديث الدوّار. توكن التحديث: `<companyId>.<سر>`؛ رقم الشركة ليس سراً لكنه يحدد
// سياق RLS قبل البحث، والسر عشوائي 256 بتاً ولا يُخزَّن إلا مجزَّأً.
// Sessions and the rotating refresh token. Format `<companyId>.<secret>`: the company id is not
// secret but selects the RLS context before the lookup; the secret is 256 random bits, stored only hashed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

export const generateRefreshToken = (companyId: string): { token: string; hash: string } => {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${companyId}.${secret}`, hash: hashSecret(secret) };
};

/** null لأي شكل غير صالح. null for any malformed shape. */
export const parseRefreshToken = (raw: unknown): { companyId: string; hash: string } | null => {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const [companyId, secret, ...rest] = raw.split('.');
  if (rest.length > 0 || !companyId || !secret) return null;
  if (!UUID_RE.test(companyId) || !SECRET_RE.test(secret)) return null;
  return { companyId: companyId.toLowerCase(), hash: hashSecret(secret) };
};

// يُنشأ داخل معاملة الدخول نفسها: لا جلسة دون دخول ناجح ولا دخول ناجح دون جلسة.
// Created inside the login transaction itself: no session without a successful login and vice versa.
export const createSession = async (
  trx: Transaction<Database>,
  deps: AuthDeps,
  args: { companyId: string; userId: string; userAgent: string | null },
  now: Date,
): Promise<{ sessionId: string; refreshToken: string; refreshExpiresAt: Date }> => {
  const sessionId = newId();
  const sessionExpires = new Date(now.getTime() + deps.config.sessionMaxDays * DAY_MS);
  const refreshExpiresAt = new Date(
    Math.min(now.getTime() + deps.config.refreshTokenTtlDays * DAY_MS, sessionExpires.getTime()),
  );
  const { token, hash } = generateRefreshToken(args.companyId);

  await trx
    .insertInto('sessions')
    .values({
      id: sessionId,
      company_id: args.companyId,
      user_id: args.userId,
      user_agent: args.userAgent?.slice(0, 256) ?? null,
      created_at: now,
      last_used_at: now,
      expires_at: sessionExpires,
    })
    .execute();
  await trx
    .insertInto('refresh_tokens')
    .values({
      id: newId(),
      company_id: args.companyId,
      session_id: sessionId,
      token_hash: hash,
      created_at: now,
      expires_at: refreshExpiresAt,
    })
    .execute();
  return { sessionId, refreshToken: token, refreshExpiresAt };
};

const invalidRefresh = (): AppError =>
  new AppError('INVALID_REFRESH_TOKEN', 401, 'Refresh token is invalid or expired');

export interface RefreshResult {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: AuthContext;
}

type RefreshOutcome =
  | {
      kind: 'ok';
      user: AuthContext;
      sessionId: string;
      refreshToken: string;
      refreshExpiresAt: Date;
    }
  | { kind: 'invalid' };

// تدوير: كل استدعاء يستهلك التوكن ويصدر بديلاً. الاستهلاك بـ UPDATE شرطي (used_at IS NULL)
// فيفوز طلب واحد فقط عند التزامن، والخاسر يُعامَل كإعادة استعمال.
// Rotation: each call consumes the token and issues a replacement. Consumption is a conditional
// UPDATE (used_at IS NULL) so exactly one concurrent request wins and the loser is treated as reuse.
export const refreshSession = async (
  deps: AuthDeps,
  rawToken: unknown,
  now: Date = new Date(),
): Promise<RefreshResult> => {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) throw invalidRefresh();

  // النتيجة تُعاد بعد تثبيت المعاملة كي لا يُلغى إبطال الجلسة عند إعادة الاستعمال بالتراجع.
  // The outcome is returned after commit so the reuse revocation is never rolled back.
  const outcome = await withTenant<RefreshOutcome>(
    deps.db,
    { companyId: parsed.companyId },
    async ({ trx }) => {
      const row = await trx
        .selectFrom('refresh_tokens as r')
        .innerJoin('sessions as s', 's.id', 'r.session_id')
        .select([
          'r.id as token_id',
          'r.expires_at as token_expires',
          's.id as session_id',
          's.user_id',
          's.expires_at as session_expires',
          's.revoked_at',
        ])
        .where('r.token_hash', '=', parsed.hash)
        .executeTakeFirst();
      if (!row) return { kind: 'invalid' };

      const revokeSession = (reason: 'reuse'): Promise<unknown> =>
        trx
          .updateTable('sessions')
          .set({ revoked_at: now, revoked_reason: reason })
          .where('id', '=', row.session_id)
          .where('revoked_at', 'is', null)
          .execute();

      if (row.revoked_at || row.session_expires <= now || row.token_expires <= now) {
        return { kind: 'invalid' };
      }

      const consumed = await trx
        .updateTable('refresh_tokens')
        .set({ used_at: now })
        .where('id', '=', row.token_id)
        .where('used_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!consumed) {
        // توكن مستهلك يعود: نسخة مسروقة أو عميل أعاد المحاولة؛ نلغي العائلة كلها.
        // A consumed token is back: a stolen copy (or a retrying client); revoke the whole family.
        await revokeSession('reuse');
        return { kind: 'invalid' };
      }

      const user = await trx
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'active', 'must_change_password'])
        .where('id', '=', row.user_id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      const company = await trx
        .selectFrom('companies')
        .select('id')
        .where('id', '=', parsed.companyId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!user || !user.active || !company) return { kind: 'invalid' };

      const next = generateRefreshToken(parsed.companyId);
      const refreshExpiresAt = new Date(
        Math.min(
          now.getTime() + deps.config.refreshTokenTtlDays * DAY_MS,
          row.session_expires.getTime(),
        ),
      );
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: newId(),
          company_id: parsed.companyId,
          session_id: row.session_id,
          token_hash: next.hash,
          created_at: now,
          expires_at: refreshExpiresAt,
        })
        .execute();
      await trx
        .updateTable('sessions')
        .set({ last_used_at: now })
        .where('id', '=', row.session_id)
        .execute();

      return {
        kind: 'ok',
        sessionId: row.session_id,
        refreshToken: next.token,
        refreshExpiresAt,
        user: {
          userId: user.id,
          companyId: parsed.companyId,
          sessionId: row.session_id,
          username: user.username,
          displayName: user.display_name,
          mustChangePassword: user.must_change_password,
        },
      };
    },
  );

  if (outcome.kind === 'invalid') throw invalidRefresh();

  const issued = await deps.tokens.sign(
    {
      userId: outcome.user.userId,
      companyId: outcome.user.companyId,
      sessionId: outcome.sessionId,
    },
    now,
  );
  return {
    accessToken: issued.token,
    expiresAt: issued.expiresAt,
    refreshToken: outcome.refreshToken,
    refreshExpiresAt: outcome.refreshExpiresAt,
    user: outcome.user,
  };
};

// خروج بتوكن التحديث لا بالوصول: يعمل حتى بعد انتهاء توكن الوصول، ولا يكشف صحة التوكن (دائماً نجاح).
// Logout by refresh token, not access token: works after the access token expired and never reveals
// whether the token was valid (always succeeds).
export const logoutByRefreshToken = async (
  deps: AuthDeps,
  rawToken: unknown,
  now: Date = new Date(),
): Promise<void> => {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) return;
  await withTenant(deps.db, { companyId: parsed.companyId }, async ({ trx }) => {
    const row = await trx
      .selectFrom('refresh_tokens')
      .select('session_id')
      .where('token_hash', '=', parsed.hash)
      .executeTakeFirst();
    if (!row) return;
    await trx
      .updateTable('sessions')
      .set({ revoked_at: now, revoked_reason: 'logout' })
      .where('id', '=', row.session_id)
      .where('revoked_at', 'is', null)
      .execute();
  });
};

export const logoutAll = (
  deps: AuthDeps,
  ctx: AuthContext,
  now: Date = new Date(),
): Promise<void> =>
  withTenant(deps.db, { companyId: ctx.companyId, userId: ctx.userId }, async ({ trx }) => {
    await trx
      .updateTable('sessions')
      .set({ revoked_at: now, revoked_reason: 'logout_all' })
      .where('user_id', '=', ctx.userId)
      .where('revoked_at', 'is', null)
      .execute();
  });

// بعد تغيير كلمة المرور تُلغى كل الجلسات الأخرى (قد تكون لمن عرف كلمة المرور القديمة).
// After a password change every other session is revoked (they may belong to whoever knew the old password).
export const revokeOtherSessions = async (
  trx: Transaction<Database>,
  ctx: AuthContext,
  now: Date,
): Promise<void> => {
  await trx
    .updateTable('sessions')
    .set({ revoked_at: now, revoked_reason: 'password_changed' })
    .where('user_id', '=', ctx.userId)
    .where('id', '!=', ctx.sessionId)
    .where('revoked_at', 'is', null)
    .execute();
};
