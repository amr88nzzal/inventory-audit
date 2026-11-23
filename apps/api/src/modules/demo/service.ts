import {
  DEMO_ACCOUNTS,
  DEMO_COMPANY_CODE,
  DEMO_COMPANY_NAME,
  DEMO_PASSWORD,
  DEMO_ROLES,
} from '@inventory/shared';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { newId, withPlatform, withTenant } from '../../db';
import type { Database } from '../../db';
import { hashPassword } from '../auth';
import { ensureAdminRole, ensureRole, ensureUserRole } from '../rbac';

export interface DemoDeps {
  db: Kysely<Database>;
  /** تكلفة تجزئة كلمة المرور (config.passwordHashLogN). Password hash cost. */
  logN: number;
}

export interface DemoResult {
  companyId: string;
  companyCode: string;
  createdCompany: boolean;
  usernames: string[];
}

// يجد الشركة التجريبية الحية أو ينشئها. بدور المنصة، وسياساته تقصر الكتابة على is_demo.
// Finds the live demo company or creates it. Runs as the platform role, whose policies confine writes to is_demo.
const ensureDemoCompany = (db: Kysely<Database>): Promise<{ id: string; created: boolean }> =>
  withPlatform(db, async (trx) => {
    const existing = await trx
      .selectFrom('companies')
      .select('id')
      .where('code', '=', DEMO_COMPANY_CODE)
      .where('is_demo', '=', true)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing) return { id: existing.id, created: false };
    const id = newId();
    await trx
      .insertInto('companies')
      .values({
        id,
        name: DEMO_COMPANY_NAME,
        code: DEMO_COMPANY_CODE,
        is_demo: true,
        created_by: null,
        updated_by: null,
        deleted_at: null,
      })
      .execute();
    return { id, created: true };
  });

// بذر آمن للإعادة، طبقة لكل مرحلة: كل مرحلة جديدة تضيف طبقتها هنا دون كسر ما سبق.
// Repeat-safe seeding, one layer per phase: each new phase adds its layer here without breaking earlier ones.
export const seedDemo = async (deps: DemoDeps): Promise<DemoResult> => {
  const company = await ensureDemoCompany(deps.db);
  // التجزئة خارج المعاملة (ثقيلة) وتُحسب مرة لكل حساب جديد فقط.
  // Hashing happens outside the transaction (it is slow) and only for accounts that need creating.
  const existingNames = await withTenant(deps.db, { companyId: company.id }, ({ trx }) =>
    trx.selectFrom('users').select('username').where('deleted_at', 'is', null).execute(),
  );
  const have = new Set(existingNames.map((r) => r.username.toLowerCase()));
  const hashes = new Map<string, string>();
  for (const a of DEMO_ACCOUNTS) {
    if (!have.has(a.username.toLowerCase())) {
      hashes.set(a.username, await hashPassword(DEMO_PASSWORD, deps.logN));
    }
  }

  await withTenant(deps.db, { companyId: company.id }, async ({ trx, companyId }) => {
    const adminRoleId = await ensureAdminRole(trx, companyId, null);
    const roleIds = new Map<string, string>();
    for (const r of DEMO_ROLES) roleIds.set(r.name, await ensureRole(trx, companyId, r, null));

    for (const a of DEMO_ACCOUNTS) {
      const existing = await trx
        .selectFrom('users')
        .select('id')
        .where(sql<boolean>`lower(username) = ${a.username.toLowerCase()}`)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      let userId = existing?.id;
      if (!userId) {
        userId = newId();
        await trx
          .insertInto('users')
          .values({
            id: userId,
            company_id: companyId,
            username: a.username,
            display_name: a.displayName,
            active: true,
            password_hash: hashes.get(a.username)!,
            must_change_password: false,
            password_changed_at: null,
            locked_until: null,
            last_login_at: null,
            created_by: null,
            updated_by: null,
            deleted_at: null,
          })
          .execute();
      }
      const roleId = a.role === null ? adminRoleId : roleIds.get(a.role)!;
      await ensureUserRole(trx, companyId, userId, roleId, null);
    }
  });

  return {
    companyId: company.id,
    companyCode: DEMO_COMPANY_CODE,
    createdCompany: company.created,
    usernames: DEMO_ACCOUNTS.map((a) => a.username),
  };
};

// يُخرج الشركة التجريبية الحالية من الخدمة (حذف ناعم وتغيير رمزها) ثم يبذر نسخة نظيفة.
// لا يمسّ إلا is_demo (السياسة تفرضه)، وتبقى النسخ القديمة محذوفة ناعماً (تراكم مقبول).
// Retires the current demo company (soft delete + rename its code) and seeds a clean one.
// Only is_demo rows can be touched (enforced by policy); old copies stay soft-deleted (accumulation accepted).
export const resetDemo = async (deps: DemoDeps): Promise<DemoResult> => {
  await withPlatform(deps.db, async (trx) => {
    const stamp = Date.now().toString(36);
    await trx
      .updateTable('companies')
      .set({ code: `${DEMO_COMPANY_CODE}-old-${stamp}`, deleted_at: new Date() })
      .where('code', '=', DEMO_COMPANY_CODE)
      .where('is_demo', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
  });
  return seedDemo(deps);
};
