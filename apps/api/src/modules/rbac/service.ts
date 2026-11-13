import { ADMIN_ROLE_CODE, PERMISSIONS } from '@inventory/shared';
import type { CreateRoleInput, Permission, UpdateRoleInput } from '@inventory/shared';
import type { Kysely, Transaction } from 'kysely';
import { newId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';
import type { PermissionService } from './permissions';

export interface RbacDeps {
  db: Kysely<Database>;
  permissions: PermissionService;
}

export interface Actor {
  companyId: string;
  userId: string;
}

export interface RoleView {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  version: number;
  permissions: Permission[];
  userCount: number;
}

const notFound = (what: string): AppError => new AppError('NOT_FOUND', 404, `${what} not found`);

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

// منع التصعيد: لا يمنح أحدٌ دوراً يحوي صلاحيات لا يملكها هو، وإلا استطاع من يملك صلاحية الإسناد
// أن يرقّي نفسه إلى مدير. دور المدير يحوي كل الكتالوج فلا يمنحه إلا مدير.
// Escalation guard: nobody grants a role holding permissions they lack themselves; otherwise whoever
// can assign roles could promote themselves to admin. The admin role holds the whole catalog, so only an admin grants it.
const assertCanGrant = async (
  deps: RbacDeps,
  actor: Actor,
  granted: readonly Permission[],
): Promise<void> => {
  const held = await deps.permissions.forUser(actor);
  const beyond = granted.filter((p) => !held.has(p));
  if (beyond.length > 0) {
    throw new AppError(
      'PERMISSION_ESCALATION',
      403,
      'You cannot grant permissions you do not hold',
      {
        permissions: beyond,
      },
    );
  }
};

const loadRoles = async (
  trx: Transaction<Database>,
  where: { id?: string } = {},
): Promise<RoleView[]> => {
  let q = trx.selectFrom('roles').selectAll().where('deleted_at', 'is', null).orderBy('name');
  if (where.id) q = q.where('id', '=', where.id);
  const roles = await q.execute();
  if (roles.length === 0) return [];
  const ids = roles.map((r) => r.id);

  const perms = await trx
    .selectFrom('role_permissions')
    .select(['role_id', 'permission'])
    .where('role_id', 'in', ids)
    .execute();
  const counts = await trx
    .selectFrom('user_roles')
    .select(['role_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('role_id', 'in', ids)
    .groupBy('role_id')
    .execute();

  return roles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    version: r.version,
    permissions:
      r.code === ADMIN_ROLE_CODE
        ? [...PERMISSIONS]
        : perms
            .filter((p) => p.role_id === r.id)
            .map((p) => p.permission)
            .filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p))
            .sort(),
    userCount: Number(counts.find((c) => c.role_id === r.id)?.n ?? 0),
  }));
};

export const listRoles = (deps: RbacDeps, actor: Actor): Promise<RoleView[]> =>
  withTenant(deps.db, actor, ({ trx }) => loadRoles(trx));

export const createRole = async (
  deps: RbacDeps,
  actor: Actor,
  input: CreateRoleInput,
): Promise<RoleView> => {
  await assertCanGrant(deps, actor, input.permissions);
  const id = newId();
  try {
    return await withTenant(deps.db, actor, async ({ trx }) => {
      await trx
        .insertInto('roles')
        .values({
          id,
          company_id: actor.companyId,
          code: null,
          name: input.name,
          description: input.description ?? null,
          created_by: actor.userId,
          updated_by: actor.userId,
          deleted_at: null,
        })
        .execute();
      if (input.permissions.length > 0) {
        await trx
          .insertInto('role_permissions')
          .values(
            input.permissions.map((permission) => ({
              role_id: id,
              company_id: actor.companyId,
              permission,
            })),
          )
          .execute();
      }
      const [view] = await loadRoles(trx, { id });
      return view!;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('ROLE_NAME_TAKEN', 409, 'A role with this name already exists');
    throw err;
  }
};

export const updateRole = async (
  deps: RbacDeps,
  actor: Actor,
  roleId: string,
  input: UpdateRoleInput,
): Promise<RoleView> => {
  if (input.permissions) await assertCanGrant(deps, actor, input.permissions);
  try {
    const view = await withTenant(deps.db, actor, async ({ trx }) => {
      const role = await trx
        .selectFrom('roles')
        .select(['id', 'is_system', 'version'])
        .where('id', '=', roleId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!role) throw notFound('Role');
      if (role.is_system)
        throw new AppError('ROLE_IMMUTABLE', 409, 'System roles cannot be modified');

      // القفل المتفائل: يفشل التحديث إن تغيّرت النسخة منذ قراءة العميل.
      // Optimistic lock: the update fails if the version changed since the client read it.
      const updated = await trx
        .updateTable('roles')
        .set((eb) => ({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          version: eb('version', '+', 1),
          updated_at: new Date(),
          updated_by: actor.userId,
        }))
        .where('id', '=', roleId)
        .where('version', '=', input.version)
        .returning('id')
        .executeTakeFirst();
      if (!updated) {
        throw new AppError('VERSION_CONFLICT', 409, 'The role was changed by someone else', {
          currentVersion: role.version,
        });
      }

      if (input.permissions) {
        await trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
        if (input.permissions.length > 0) {
          await trx
            .insertInto('role_permissions')
            .values(
              input.permissions.map((permission) => ({
                role_id: roleId,
                company_id: actor.companyId,
                permission,
              })),
            )
            .execute();
        }
      }
      const [v] = await loadRoles(trx, { id: roleId });
      return v!;
    });
    deps.permissions.invalidateCompany(actor.companyId);
    return view;
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('ROLE_NAME_TAKEN', 409, 'A role with this name already exists');
    throw err;
  }
};

export const deleteRole = async (deps: RbacDeps, actor: Actor, roleId: string): Promise<void> => {
  await withTenant(deps.db, actor, async ({ trx }) => {
    const role = await trx
      .selectFrom('roles')
      .select(['id', 'is_system'])
      .where('id', '=', roleId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!role) throw notFound('Role');
    if (role.is_system) throw new AppError('ROLE_IMMUTABLE', 409, 'System roles cannot be deleted');

    const assigned = await trx
      .selectFrom('user_roles')
      .select('user_id')
      .where('role_id', '=', roleId)
      .limit(1)
      .executeTakeFirst();
    if (assigned) throw new AppError('ROLE_IN_USE', 409, 'Remove this role from its users first');

    await trx
      .updateTable('roles')
      .set({ deleted_at: new Date(), updated_at: new Date(), updated_by: actor.userId })
      .where('id', '=', roleId)
      .execute();
  });
  deps.permissions.invalidateCompany(actor.companyId);
};

export const setUserRoles = async (
  deps: RbacDeps,
  actor: Actor,
  targetUserId: string,
  roleIds: string[],
): Promise<RoleView[]> => {
  const result = await withTenant(deps.db, actor, async ({ trx }) => {
    const target = await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', targetUserId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!target) throw notFound('User');

    const wanted = roleIds.length === 0 ? [] : await loadRolesByIds(trx, roleIds);
    if (wanted.length !== roleIds.length) throw notFound('Role');

    // منع التصعيد على كل دور يُضاف.
    // Escalation guard for every role being added.
    const current = await trx
      .selectFrom('user_roles')
      .select('role_id')
      .where('user_id', '=', targetUserId)
      .execute();
    const currentIds = new Set(current.map((c) => c.role_id));
    const added = wanted.filter((r) => !currentIds.has(r.id));
    await assertCanGrant(
      deps,
      actor,
      added.flatMap((r) => r.permissions),
    );

    // حماية آخر مدير: قفل صف دور المدير يسلسل عمليتين متزامنتين تُنزلان آخر مديرين معاً.
    // Last-admin guard: locking the admin role row serializes two concurrent demotions that would
    // otherwise each see the other admin still in place.
    const adminRole = await trx
      .selectFrom('roles')
      .select('id')
      .where('code', '=', ADMIN_ROLE_CODE)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (adminRole && currentIds.has(adminRole.id) && !roleIds.includes(adminRole.id)) {
      const others = await trx
        .selectFrom('user_roles as ur')
        .innerJoin('users as u', 'u.id', 'ur.user_id')
        .select('ur.user_id')
        .where('ur.role_id', '=', adminRole.id)
        .where('ur.user_id', '!=', targetUserId)
        .where('u.deleted_at', 'is', null)
        .where('u.active', '=', true)
        .limit(1)
        .executeTakeFirst();
      if (!others) {
        throw new AppError('LAST_ADMIN', 409, 'The company must keep at least one active admin');
      }
    }

    await trx.deleteFrom('user_roles').where('user_id', '=', targetUserId).execute();
    if (roleIds.length > 0) {
      await trx
        .insertInto('user_roles')
        .values(
          roleIds.map((role_id) => ({
            user_id: targetUserId,
            role_id,
            company_id: actor.companyId,
            created_by: actor.userId,
          })),
        )
        .execute();
    }
    return wanted;
  });
  deps.permissions.invalidateCompany(actor.companyId);
  return result;
};

const loadRolesByIds = async (trx: Transaction<Database>, ids: string[]): Promise<RoleView[]> => {
  const all = await loadRoles(trx);
  return all.filter((r) => ids.includes(r.id));
};

// ينشئ دور المدير النظامي لشركة؛ يُستدعى عند إنشاء الشركة (1د) وفي الاختبارات.
// Creates a company's system admin role; called when a company is created (1د) and in tests.
export const ensureAdminRole = async (
  trx: Transaction<Database>,
  companyId: string,
  createdBy: string | null,
): Promise<string> => {
  const existing = await trx
    .selectFrom('roles')
    .select('id')
    .where('code', '=', ADMIN_ROLE_CODE)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await trx
    .insertInto('roles')
    .values({
      id,
      company_id: companyId,
      code: ADMIN_ROLE_CODE,
      is_system: true,
      name: 'Admin',
      description: 'Full access to everything in the company',
      created_by: createdBy,
      updated_by: createdBy,
      deleted_at: null,
    })
    .execute();
  return id;
};
