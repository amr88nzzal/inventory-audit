import { ADMIN_ROLE_CODE, PERMISSIONS } from '@inventory/shared';
import type { Permission } from '@inventory/shared';
import type { Kysely } from 'kysely';
import { isPermission } from '@inventory/shared';
import { withTenant } from '../../db';
import type { Database } from '../../db';
import { createTtlCache } from './cache';

export interface PermissionService {
  /** صلاحيات المستخدم الفعلية (مجمّعة من كل أدواره). The user's effective permissions (union of all roles). */
  forUser: (ctx: { companyId: string; userId: string }) => Promise<ReadonlySet<Permission>>;
  /** يُستدعى بعد أي تغيير في الأدوار أو إسنادها. Call after any role or assignment change. */
  invalidateCompany: (companyId: string) => void;
}

const ALL: ReadonlySet<Permission> = new Set(PERMISSIONS);

export const createPermissionService = (
  db: Kysely<Database>,
  ttlMs = 30_000,
): PermissionService => {
  const cache = createTtlCache<ReadonlySet<Permission>>(ttlMs);

  return {
    forUser: async ({ companyId, userId }) => {
      const key = `${companyId}:${userId}`;
      const hit = cache.get(key);
      if (hit) return hit;

      const set = await withTenant(db, { companyId, userId }, async ({ trx }) => {
        const roles = await trx
          .selectFrom('user_roles as ur')
          .innerJoin('roles as r', 'r.id', 'ur.role_id')
          .select(['r.id', 'r.code'])
          .where('ur.user_id', '=', userId)
          .where('r.deleted_at', 'is', null)
          .execute();
        // دور المدير يملك كل الكتالوج ضمنياً. The admin role holds the whole catalog implicitly.
        if (roles.some((r) => r.code === ADMIN_ROLE_CODE)) return ALL;
        if (roles.length === 0) return new Set<Permission>();

        const rows = await trx
          .selectFrom('role_permissions')
          .select('permission')
          .where(
            'role_id',
            'in',
            roles.map((r) => r.id),
          )
          .execute();
        // صلاحية حُذفت من الكتالوج بعد منحها تُتجاهل بدل أن تمنح شيئاً مجهولاً.
        // A permission removed from the catalog after being granted is ignored rather than granting something unknown.
        return new Set(rows.map((r) => r.permission).filter(isPermission));
      });

      cache.set(key, set);
      return set;
    },
    invalidateCompany: (companyId) => cache.invalidatePrefix(`${companyId}:`),
  };
};
