// الواجهة العامة لوحدة المستودعات: لا يستورد غيرها من ملفاتها الداخلية.
// The warehouses module's public surface: nothing imports its internal files directly.
import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../../db';
import type { RequirePermission } from '../rbac';
import { createWarehouseRouter } from './routes';

export const createWarehousesModule = (deps: {
  db: Kysely<Database>;
  requirePermission: RequirePermission;
}): { router: Router } => ({
  router: createWarehouseRouter({ db: deps.db }, deps.requirePermission),
});

export { createLocation, createWarehouse, scopeOf, setUserWarehouses } from './service';
export type { Actor as WarehouseActor } from './service';
