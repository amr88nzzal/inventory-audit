import { escapeLike, normalizeSearch, offsetOf, pageMeta } from '@inventory/shared';
import type {
  CreateLocationInput,
  CreateWarehouseInput,
  PageMeta,
  UpdateLocationInput,
  UpdateWarehouseInput,
  WarehouseListQuery,
} from '@inventory/shared';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { newId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';

export interface Actor {
  companyId: string;
  userId: string;
}
export interface WarehouseDeps {
  db: Kysely<Database>;
}

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: string;
}
export interface LocationView {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

type Trx = Transaction<Database>;

const notFound = (what: string): AppError => new AppError('NOT_FOUND', 404, `${what} not found`);
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';
const iso = (d: Date | string): string => new Date(d).toISOString();

// نطاق المستخدم: null = كل المستودعات (لا صفوف)، وإلا قائمة المسموح بها فقط.
// User scope: null = every warehouse (no rows), otherwise only the listed ones.
export const scopeOf = async (trx: Trx, userId: string): Promise<string[] | null> => {
  const rows = await trx
    .selectFrom('user_warehouses')
    .select('warehouse_id')
    .where('user_id', '=', userId)
    .execute();
  return rows.length === 0 ? null : rows.map((r) => r.warehouse_id);
};

const toView = (r: {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
  created_at: Date | string;
}): WarehouseView => ({
  id: r.id,
  code: r.code,
  name: r.name,
  active: r.active,
  version: r.version,
  createdAt: iso(r.created_at),
});

// يحمّل مستودعاً ضمن نطاق المستخدم أو 404 (لا نكشف وجود مستودع خارج نطاقه).
// Loads a warehouse within the user's scope or 404 (we never reveal one outside the scope).
const loadInScope = async (trx: Trx, actor: Actor, id: string) => {
  const scope = await scopeOf(trx, actor.userId);
  if (scope && !scope.includes(id)) throw notFound('Warehouse');
  const row = await trx
    .selectFrom('warehouses')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw notFound('Warehouse');
  return row;
};

export const listWarehouses = (
  deps: WarehouseDeps,
  actor: Actor,
  query: WarehouseListQuery,
): Promise<{ data: WarehouseView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const scope = await scopeOf(trx, actor.userId);
    let q = trx.selectFrom('warehouses').where('deleted_at', 'is', null);
    if (scope) q = q.where('id', 'in', scope);
    if (query.active) q = q.where('active', '=', query.active === 'true');
    const term = query.q ? normalizeSearch(query.q) : '';
    if (term) q = q.where(sql<boolean>`search_text LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);

    const total = Number(
      (await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n,
    );
    const sortColumn = { code: 'code', name: 'name', createdAt: 'created_at' }[query.sort] as
      'code' | 'name' | 'created_at';
    const rows = await q
      .selectAll()
      .orderBy(sortColumn, query.dir)
      // ترتيب ثانوي ثابت كي لا تتكرر الصفوف بين الصفحات. A stable tiebreaker so rows never repeat across pages.
      .orderBy('id')
      .limit(query.pageSize)
      .offset(offsetOf(query.page, query.pageSize))
      .execute();
    return { data: rows.map(toView), meta: pageMeta(query.page, query.pageSize, total) };
  });

export const getWarehouse = (
  deps: WarehouseDeps,
  actor: Actor,
  id: string,
): Promise<WarehouseView> =>
  withTenant(deps.db, actor, async ({ trx }) => toView(await loadInScope(trx, actor, id)));

export const createWarehouse = async (
  deps: WarehouseDeps,
  actor: Actor,
  input: CreateWarehouseInput,
): Promise<WarehouseView> => {
  try {
    return await withTenant(deps.db, actor, async ({ trx }) => {
      // إنشاء المستودعات عمل إداري: من نطاقه مقيَّد لا ينشئ (وإلا اتسع نطاقه بلا علمه).
      // Creating warehouses is an admin act: a scope-restricted user may not (it would silently widen their world).
      if (await scopeOf(trx, actor.userId))
        throw new AppError('SCOPE_RESTRICTED', 403, 'Your warehouse scope does not allow this');
      const row = await trx
        .insertInto('warehouses')
        .values({
          id: newId(),
          company_id: actor.companyId,
          code: input.code,
          name: input.name,
          search_text: normalizeSearch(`${input.code} ${input.name}`),
          created_by: actor.userId,
          updated_by: actor.userId,
          deleted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toView(row);
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('WAREHOUSE_CODE_TAKEN', 409, 'A warehouse with this code already exists');
    throw err;
  }
};

export const updateWarehouse = (
  deps: WarehouseDeps,
  actor: Actor,
  id: string,
  input: UpdateWarehouseInput,
): Promise<WarehouseView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const current = await loadInScope(trx, actor, id);
    const name = input.name ?? current.name;
    // القفل المتفائل. Optimistic lock.
    const row = await trx
      .updateTable('warehouses')
      .set((eb) => ({
        name,
        search_text: normalizeSearch(`${current.code} ${name}`),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: eb('version', '+', 1),
        updated_at: new Date(),
        updated_by: actor.userId,
      }))
      .where('id', '=', id)
      .where('version', '=', input.version)
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new AppError('VERSION_CONFLICT', 409, 'The warehouse was changed by someone else', {
        currentVersion: current.version,
      });
    return toView(row);
  });

export const deleteWarehouse = (deps: WarehouseDeps, actor: Actor, id: string): Promise<void> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadInScope(trx, actor, id);
    const now = new Date();
    // حذف ناعم يشمل مواقعه. A soft delete that includes its locations.
    await trx
      .updateTable('locations')
      .set({ deleted_at: now, updated_at: now, updated_by: actor.userId })
      .where('warehouse_id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
    await trx
      .updateTable('warehouses')
      .set({ deleted_at: now, updated_at: now, updated_by: actor.userId })
      .where('id', '=', id)
      .execute();
    // يُزال من نطاق كل مستخدم كي لا يبقى مرجع لمستودع محذوف (وإلا صار نطاق مستخدم «فارغاً فعلياً» لكنه مقيَّد).
    // Remove it from every user's scope so no reference to a deleted warehouse remains.
    await trx.deleteFrom('user_warehouses').where('warehouse_id', '=', id).execute();
  });

const locView = (r: {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}): LocationView => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  code: r.code,
  name: r.name,
  active: r.active,
  version: r.version,
});

export const listLocations = (
  deps: WarehouseDeps,
  actor: Actor,
  warehouseId: string,
): Promise<LocationView[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadInScope(trx, actor, warehouseId);
    const rows = await trx
      .selectFrom('locations')
      .selectAll()
      .where('warehouse_id', '=', warehouseId)
      .where('deleted_at', 'is', null)
      .orderBy('code')
      .execute();
    return rows.map(locView);
  });

export const createLocation = async (
  deps: WarehouseDeps,
  actor: Actor,
  warehouseId: string,
  input: CreateLocationInput,
): Promise<LocationView> => {
  try {
    return await withTenant(deps.db, actor, async ({ trx }) => {
      await loadInScope(trx, actor, warehouseId);
      const row = await trx
        .insertInto('locations')
        .values({
          id: newId(),
          company_id: actor.companyId,
          warehouse_id: warehouseId,
          code: input.code,
          name: input.name,
          created_by: actor.userId,
          updated_by: actor.userId,
          deleted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return locView(row);
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('LOCATION_CODE_TAKEN', 409, 'A location with this code already exists');
    throw err;
  }
};

const loadLocation = async (trx: Trx, actor: Actor, warehouseId: string, id: string) => {
  await loadInScope(trx, actor, warehouseId);
  const row = await trx
    .selectFrom('locations')
    .selectAll()
    .where('id', '=', id)
    .where('warehouse_id', '=', warehouseId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw notFound('Location');
  return row;
};

export const updateLocation = (
  deps: WarehouseDeps,
  actor: Actor,
  warehouseId: string,
  id: string,
  input: UpdateLocationInput,
): Promise<LocationView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const current = await loadLocation(trx, actor, warehouseId, id);
    const row = await trx
      .updateTable('locations')
      .set((eb) => ({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        version: eb('version', '+', 1),
        updated_at: new Date(),
        updated_by: actor.userId,
      }))
      .where('id', '=', id)
      .where('version', '=', input.version)
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new AppError('VERSION_CONFLICT', 409, 'The location was changed by someone else', {
        currentVersion: current.version,
      });
    return locView(row);
  });

export const deleteLocation = (
  deps: WarehouseDeps,
  actor: Actor,
  warehouseId: string,
  id: string,
): Promise<void> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadLocation(trx, actor, warehouseId, id);
    await trx
      .updateTable('locations')
      .set({ deleted_at: new Date(), updated_at: new Date(), updated_by: actor.userId })
      .where('id', '=', id)
      .execute();
  });

// نطاق مستخدم: يضبطه من يملك identity.user.assign_warehouse. فارغ = كل المستودعات.
// A user's scope, set by whoever holds identity.user.assign_warehouse. Empty = every warehouse.
export const getUserWarehouses = (
  deps: WarehouseDeps,
  actor: Actor,
  targetUserId: string,
): Promise<string[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await assertUserExists(trx, targetUserId);
    return (await scopeOf(trx, targetUserId)) ?? [];
  });

const assertUserExists = async (trx: Trx, userId: string): Promise<void> => {
  const u = await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!u) throw notFound('User');
};

export const setUserWarehouses = (
  deps: WarehouseDeps,
  actor: Actor,
  targetUserId: string,
  warehouseIds: string[],
): Promise<string[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await assertUserExists(trx, targetUserId);
    if (warehouseIds.length > 0) {
      const found = await trx
        .selectFrom('warehouses')
        .select('id')
        .where('id', 'in', warehouseIds)
        .where('deleted_at', 'is', null)
        .execute();
      if (found.length !== warehouseIds.length) throw notFound('Warehouse');
    }
    // منع التصعيد: من نطاقه مقيَّد لا يمنح غير مستودعاته (وإلا وسّع نطاقه عبر مستخدم آخر).
    // Escalation guard: a scope-restricted actor may only grant warehouses inside their own scope.
    const own = await scopeOf(trx, actor.userId);
    if (own) {
      const outside = warehouseIds.length === 0 || warehouseIds.some((w) => !own.includes(w));
      if (outside)
        throw new AppError(
          'SCOPE_RESTRICTED',
          403,
          'You can only assign warehouses within your own scope',
        );
    }
    await trx.deleteFrom('user_warehouses').where('user_id', '=', targetUserId).execute();
    if (warehouseIds.length > 0) {
      await trx
        .insertInto('user_warehouses')
        .values(
          warehouseIds.map((warehouse_id) => ({
            user_id: targetUserId,
            warehouse_id,
            company_id: actor.companyId,
            created_by: actor.userId,
          })),
        )
        .execute();
    }
    return warehouseIds;
  });
