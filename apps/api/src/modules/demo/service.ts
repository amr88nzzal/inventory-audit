import {
  DEMO_ACCOUNTS,
  DEMO_COMPANY_CODE,
  DEMO_COMPANY_NAME,
  DEMO_ITEMS,
  DEMO_PASSWORD,
  DEMO_ROLES,
  DEMO_WAREHOUSES,
  normalizeSearch,
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

type Trx = Parameters<Parameters<typeof withTenant>[2]>[0]['trx'];

// طبقة المرحلة 2: المستودعات والمواقع بالرمز (آمنة للإعادة: لا تكرار ولا تعديل لما عدّله المستخدم).
// Phase 2 layer: warehouses and locations by code (repeat-safe: no duplicates, and user edits are kept).
const seedWarehouses = async (trx: Trx, companyId: string): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  for (const w of DEMO_WAREHOUSES) {
    const found = await trx
      .selectFrom('warehouses')
      .select('id')
      .where(sql<boolean>`lower(code) = ${w.code.toLowerCase()}`)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const id = found?.id ?? newId();
    ids.set(w.code, id);
    if (!found) {
      await trx
        .insertInto('warehouses')
        .values({
          id,
          company_id: companyId,
          code: w.code,
          name: w.name,
          search_text: normalizeSearch(`${w.code} ${w.name}`),
          created_by: null,
          updated_by: null,
          deleted_at: null,
        })
        .execute();
    }
    for (const l of w.locations) {
      await trx
        .insertInto('locations')
        .values({
          id: newId(),
          company_id: companyId,
          warehouse_id: id,
          code: l.code,
          name: l.name,
          created_by: null,
          updated_by: null,
          deleted_at: null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
  return ids;
};

// طبقة المرحلة 2ب: الأصناف بالباركود (آمنة للإعادة: الصنف الموجود يبقى كما عدّله المستخدم).
// Phase 2b layer: items by barcode (repeat-safe: an existing item stays as the user edited it).
const seedItems = async (trx: Trx, companyId: string): Promise<void> => {
  for (const i of DEMO_ITEMS) {
    const found = await trx
      .selectFrom('items')
      .select('id')
      .where('barcode', '=', i.barcode)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (found) continue;
    const id = newId();
    await trx
      .insertInto('items')
      .values({
        id,
        company_id: companyId,
        barcode: i.barcode,
        sku: null,
        name: i.name,
        search_text: normalizeSearch(`${i.barcode} ${i.name} ${i.category} ${i.supplier}`),
        price: i.price,
        supplier: i.supplier,
        category: i.category,
        account_no: null,
        base_unit: i.baseUnit ?? 'قطعة',
        tolerance_pct: null,
        created_by: null,
        updated_by: null,
        deleted_at: null,
      })
      .execute();
    if (i.units?.length) {
      await trx
        .insertInto('item_units')
        .values(
          i.units.map((u) => ({
            id: newId(),
            company_id: companyId,
            item_id: id,
            name: u.name,
            factor: u.factor,
            created_by: null,
          })),
        )
        .execute();
    }
  }
};

// يضبط نطاق مستخدم تجريبي (فارغ = كل المستودعات). Sets a demo user's scope (empty = every warehouse).
const setScope = async (
  trx: Trx,
  companyId: string,
  userId: string,
  warehouseIds: string[],
): Promise<void> => {
  await trx.deleteFrom('user_warehouses').where('user_id', '=', userId).execute();
  if (warehouseIds.length > 0) {
    await trx
      .insertInto('user_warehouses')
      .values(
        warehouseIds.map((warehouse_id) => ({
          user_id: userId,
          warehouse_id,
          company_id: companyId,
          created_by: null,
        })),
      )
      .execute();
  }
};

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

    const warehouseIds = await seedWarehouses(trx, companyId);
    await seedItems(trx, companyId);

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
      await setScope(
        trx,
        companyId,
        userId,
        (a.warehouses ?? []).map((c) => warehouseIds.get(c)!),
      );
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
