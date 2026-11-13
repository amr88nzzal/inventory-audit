import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema';

export interface TenantContext {
  /** المعاملة المفتوحة بسياق الشركة؛ كل قراءة وكتابة تمر منها. The tenant-scoped transaction; every read/write goes through it. */
  trx: Transaction<Database>;
  companyId: string;
  userId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// نتحقق من الشكل قبل أي استعلام: المعرّف يأتي من التوكن لا من العميل، لكن الدفاع بالعمق أرخص.
// Validate the shape before any query: ids come from the token, not the client, but defence in depth is cheap.
const assertUuid = (value: string, name: string): void => {
  if (!UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID`);
};

/**
 * يفتح معاملة ويضبط سياق الشركة بـ SET LOCAL فيسري RLS على كل ما بداخلها.
 * Opens a transaction and sets the tenant context with SET LOCAL so RLS applies to everything inside.
 *
 * السياق ينتهي بنهاية المعاملة، فلا يتسرّب بين طلبين يتشاركان اتصالاً من المجمّع.
 * The context ends with the transaction, so it cannot leak between requests sharing a pooled connection.
 */
// async كي يصبح أي خطأ تحقق Promise مرفوضاً لا استثناءً متزامناً يفلت من .catch() عند المستدعي.
// async so a validation error is a rejected Promise, not a sync throw that escapes the caller's .catch().
export const withTenant = async <T>(
  db: Kysely<Database>,
  ctx: { companyId: string; userId?: string | null },
  fn: (tenant: TenantContext) => Promise<T>,
): Promise<T> => {
  assertUuid(ctx.companyId, 'companyId');
  const userId = ctx.userId ?? null;
  if (userId !== null) assertUuid(userId, 'userId');

  return db.transaction().execute(async (trx) => {
    // نبدّل إلى دور غير مالك ولا يتجاوز RLS، فيبقى العزل حتى لو اتصل التطبيق بحساب أقوى.
    // Switch to a non-owner role that cannot bypass RLS, so isolation holds even on a stronger login.
    await sql`SET LOCAL ROLE inventory_app`.execute(trx);
    await sql`SELECT set_config('app.company_id', ${ctx.companyId}, true),
                     set_config('app.user_id', ${userId ?? ''}, true)`.execute(trx);
    return fn({ trx, companyId: ctx.companyId, userId });
  });
};
