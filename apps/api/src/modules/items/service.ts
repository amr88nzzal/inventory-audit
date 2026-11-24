import { escapeLike, normalizeSearch, offsetOf, pageMeta } from '@inventory/shared';
import type { CreateItemInput, ItemListQuery, PageMeta, UpdateItemInput } from '@inventory/shared';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { newId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';

export interface Actor {
  companyId: string;
  userId: string;
}
export interface ItemDeps {
  db: Kysely<Database>;
}

export interface ItemView {
  id: string;
  barcode: string;
  sku: string | null;
  name: string;
  price: string | null;
  supplier: string | null;
  category: string | null;
  accountNo: string | null;
  baseUnit: string;
  tolerancePct: string | null;
  active: boolean;
  version: number;
  units: { name: string; factor: string }[];
  createdAt: string;
}

type Trx = Transaction<Database>;
const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Item not found');
const isUnique = (err: unknown): { constraint?: string } | null =>
  (err as { code?: string }).code === '23505' ? (err as { constraint?: string }) : null;

// numeric يُعاد بصيغة موحّدة (بلا أصفار زائدة) كي يتطابق ما يُرسل وما يُستلم.
// numeric is returned normalised (no trailing zeros) so what is sent equals what is received.
const dec = (v: string | null): string | null => (v === null ? null : new Decimal(v).toFixed());

type ItemRow = Awaited<ReturnType<typeof loadRows>>[number];

const loadRows = (trx: Trx, ids: string[]) =>
  trx
    .selectFrom('items')
    .selectAll()
    .where('id', 'in', ids)
    .where('deleted_at', 'is', null)
    .execute();

const toViews = async (trx: Trx, rows: ItemRow[]): Promise<ItemView[]> => {
  if (rows.length === 0) return [];
  const units = await trx
    .selectFrom('item_units')
    .select(['item_id', 'name', 'factor'])
    .where(
      'item_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('factor')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    barcode: r.barcode,
    sku: r.sku,
    name: r.name,
    price: dec(r.price),
    supplier: r.supplier,
    category: r.category,
    accountNo: r.account_no,
    baseUnit: r.base_unit,
    tolerancePct: dec(r.tolerance_pct),
    active: r.active,
    version: r.version,
    units: units
      .filter((u) => u.item_id === r.id)
      .map((u) => ({ name: u.name, factor: dec(u.factor)! })),
    createdAt: new Date(r.created_at).toISOString(),
  }));
};

// نص البحث يجمع ما يبحث عنه المستخدم: الباركود والرمز والاسم والفئة والمورد.
// The search text gathers what users look for: barcode, code, name, category and supplier.
const searchTextOf = (v: {
  barcode: string;
  sku?: string | null | undefined;
  name: string;
  category?: string | null | undefined;
  supplier?: string | null | undefined;
}): string =>
  normalizeSearch([v.barcode, v.sku, v.name, v.category, v.supplier].filter(Boolean).join(' '));

const mapUnique = (err: unknown): never => {
  const u = isUnique(err);
  if (u?.constraint === 'items_company_barcode_uq')
    throw new AppError('BARCODE_TAKEN', 409, 'An item with this barcode already exists');
  if (u?.constraint === 'items_company_sku_uq')
    throw new AppError('SKU_TAKEN', 409, 'An item with this code already exists');
  throw err;
};

const writeUnits = async (
  trx: Trx,
  actor: Actor,
  itemId: string,
  units: { name: string; factor: string }[],
): Promise<void> => {
  await trx.deleteFrom('item_units').where('item_id', '=', itemId).execute();
  if (units.length > 0) {
    await trx
      .insertInto('item_units')
      .values(
        units.map((u) => ({
          id: newId(),
          company_id: actor.companyId,
          item_id: itemId,
          name: u.name,
          factor: u.factor,
          created_by: actor.userId,
        })),
      )
      .execute();
  }
};

export const createItem = async (
  deps: ItemDeps,
  actor: Actor,
  input: CreateItemInput,
): Promise<ItemView> => {
  const id = newId();
  try {
    return await withTenant(deps.db, actor, async ({ trx }) => {
      await trx
        .insertInto('items')
        .values({
          id,
          company_id: actor.companyId,
          barcode: input.barcode,
          sku: input.sku ?? null,
          name: input.name,
          search_text: searchTextOf(input),
          price: input.price ?? null,
          supplier: input.supplier ?? null,
          category: input.category ?? null,
          account_no: input.accountNo ?? null,
          base_unit: input.baseUnit,
          tolerance_pct: input.tolerancePct ?? null,
          created_by: actor.userId,
          updated_by: actor.userId,
          deleted_at: null,
        })
        .execute();
      await writeUnits(trx, actor, id, input.units);
      return (await toViews(trx, await loadRows(trx, [id])))[0]!;
    });
  } catch (err) {
    return mapUnique(err);
  }
};

export const getItem = (deps: ItemDeps, actor: Actor, id: string): Promise<ItemView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const view = (await toViews(trx, await loadRows(trx, [id])))[0];
    if (!view) throw notFound();
    return view;
  });

// بحث بالباركود الكامل (للمسح): لا يطابق جزءاً ولا يتجاهل الحالة. Exact barcode lookup (for scanning).
export const getItemByBarcode = (
  deps: ItemDeps,
  actor: Actor,
  barcode: string,
): Promise<ItemView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const row = await trx
      .selectFrom('items')
      .selectAll()
      .where('barcode', '=', barcode)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound();
    return (await toViews(trx, [row]))[0]!;
  });

export const listItems = (
  deps: ItemDeps,
  actor: Actor,
  query: ItemListQuery,
): Promise<{ data: ItemView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    let q = trx.selectFrom('items').where('deleted_at', 'is', null);
    if (query.active) q = q.where('active', '=', query.active === 'true');
    if (query.category) q = q.where('category', '=', query.category);
    if (query.supplier) q = q.where('supplier', '=', query.supplier);
    const term = query.q ? normalizeSearch(query.q) : '';
    if (term) q = q.where(sql<boolean>`search_text LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);

    const total = Number(
      (await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n,
    );
    const col = { name: 'name', barcode: 'barcode', createdAt: 'created_at', price: 'price' }[
      query.sort
    ] as 'name' | 'barcode' | 'created_at' | 'price';
    const rows = await q
      .selectAll()
      // الفارغ (مثل صنف بلا سعر) يأتي أخيراً في الاتجاهين، لا أولاً في التنازلي كما يفعل PostgreSQL افتراضياً.
      // NULLs (e.g. no price) sort last both ways, not first when descending as PostgreSQL does by default.
      .orderBy(col, (ob) => (query.dir === 'asc' ? ob.asc().nullsLast() : ob.desc().nullsLast()))
      .orderBy('id')
      .limit(query.pageSize)
      .offset(offsetOf(query.page, query.pageSize))
      .execute();
    return { data: await toViews(trx, rows), meta: pageMeta(query.page, query.pageSize, total) };
  });

export const updateItem = async (
  deps: ItemDeps,
  actor: Actor,
  id: string,
  input: UpdateItemInput,
): Promise<ItemView> => {
  try {
    return await withTenant(deps.db, actor, async ({ trx }) => {
      const current = await trx
        .selectFrom('items')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!current) throw notFound();
      const merged = {
        barcode: input.barcode ?? current.barcode,
        sku: input.sku === undefined ? current.sku : input.sku,
        name: input.name ?? current.name,
        category: input.category === undefined ? current.category : input.category,
        supplier: input.supplier === undefined ? current.supplier : input.supplier,
      };
      // الوحدة الأساسية الجديدة لا تتكرر مع وحدة قائمة. The new base unit must not repeat an existing unit name.
      if (input.baseUnit !== undefined && input.units === undefined) {
        const clash = await trx
          .selectFrom('item_units')
          .select('id')
          .where('item_id', '=', id)
          .where(sql<boolean>`lower(name) = ${input.baseUnit.toLowerCase()}`)
          .executeTakeFirst();
        if (clash)
          throw new AppError('VALIDATION_ERROR', 400, 'A unit cannot repeat the base unit name');
      }
      if (
        input.units &&
        input.units.some(
          (u) => u.name.toLowerCase() === (input.baseUnit ?? current.base_unit).toLowerCase(),
        )
      )
        throw new AppError('VALIDATION_ERROR', 400, 'A unit cannot repeat the base unit name');

      const updated = await trx
        .updateTable('items')
        .set((eb) => ({
          barcode: merged.barcode,
          sku: merged.sku,
          name: merged.name,
          category: merged.category,
          supplier: merged.supplier,
          search_text: searchTextOf(merged),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.accountNo !== undefined ? { account_no: input.accountNo } : {}),
          ...(input.baseUnit !== undefined ? { base_unit: input.baseUnit } : {}),
          ...(input.tolerancePct !== undefined ? { tolerance_pct: input.tolerancePct } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          version: eb('version', '+', 1),
          updated_at: new Date(),
          updated_by: actor.userId,
        }))
        .where('id', '=', id)
        .where('version', '=', input.version)
        .returning('id')
        .executeTakeFirst();
      if (!updated)
        throw new AppError('VERSION_CONFLICT', 409, 'The item was changed by someone else', {
          currentVersion: current.version,
        });
      if (input.units) await writeUnits(trx, actor, id, input.units);
      return (await toViews(trx, await loadRows(trx, [id])))[0]!;
    });
  } catch (err) {
    if (isUnique(err)) return mapUnique(err);
    throw err;
  }
};

export const deleteItem = (deps: ItemDeps, actor: Actor, id: string): Promise<void> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const res = await trx
      .updateTable('items')
      .set({ deleted_at: new Date(), updated_at: new Date(), updated_by: actor.userId })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!res) throw notFound();
  });
