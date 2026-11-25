// الواجهة العامة لوحدة المهام: لا يستورد غيرها من ملفاتها الداخلية.
// The tasks module's public surface: nothing imports its internal files directly.
import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../../db';
import type { PermissionService, RequirePermission } from '../rbac';
import { createTaskRouter } from './routes';

export const createTasksModule = (deps: {
  db: Kysely<Database>;
  permissions: PermissionService;
  requirePermission: RequirePermission;
}): { router: Router } => ({
  router: createTaskRouter({ db: deps.db }, deps.permissions, deps.requirePermission),
});
