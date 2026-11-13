// الواجهة العامة لوحدة الصلاحيات: لا يستورد غيرها من ملفاتها الداخلية.
// The RBAC module's public surface: nothing imports its internal files directly.
import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../../db';
import { createRequirePermission } from './middleware';
import type { RequirePermission } from './middleware';
import { createPermissionService } from './permissions';
import type { PermissionService } from './permissions';
import { createRbacRouter } from './routes';

export interface RbacModule {
  router: Router;
  permissions: PermissionService;
  /** يُستعمل في وحدات الأعمال: requirePermission('الوحدة.المورد.الفعل'). Used by business modules. */
  requirePermission: RequirePermission;
}

export const createRbacModule = (deps: {
  db: Kysely<Database>;
  /** مدة الذاكرة المؤقتة للصلاحيات بالمللي ثانية. Permission cache TTL in milliseconds. */
  permissionCacheTtlMs?: number;
}): RbacModule => {
  const permissions = createPermissionService(deps.db, deps.permissionCacheTtlMs);
  const requirePermission = createRequirePermission(permissions);
  return {
    permissions,
    requirePermission,
    router: createRbacRouter({ db: deps.db, permissions }, permissions, requirePermission),
  };
};

export { ensureAdminRole } from './service';
export type { RequirePermission } from './middleware';
