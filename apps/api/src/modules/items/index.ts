// الواجهة العامة لوحدة الأصناف: لا يستورد غيرها من ملفاتها الداخلية.
// The items module's public surface: nothing imports its internal files directly.
import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../../db';
import type { RequirePermission } from '../rbac';
import { createItemRouter } from './routes';

export const createItemsModule = (deps: {
  db: Kysely<Database>;
  requirePermission: RequirePermission;
}): { router: Router } => ({
  router: createItemRouter({ db: deps.db }, deps.requirePermission),
});
