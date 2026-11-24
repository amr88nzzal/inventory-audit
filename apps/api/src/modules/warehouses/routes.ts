import {
  createLocationSchema,
  createWarehouseSchema,
  setUserWarehousesSchema,
  updateLocationSchema,
  updateWarehouseSchema,
  warehouseListQuerySchema,
} from '@inventory/shared';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import type { RequirePermission } from '../rbac';
import {
  createLocation,
  createWarehouse,
  deleteLocation,
  deleteWarehouse,
  getUserWarehouses,
  getWarehouse,
  listLocations,
  listWarehouses,
  setUserWarehouses,
  updateLocation,
  updateWarehouse,
} from './service';
import type { Actor, WarehouseDeps } from './service';

const uuidSchema = z.uuid();
// معرّف غير صالح = سجل غير موجود (404). A malformed id is a missing record (404).
const idParam = (req: Request, name: string): string => {
  const parsed = uuidSchema.safeParse(req.params[name]);
  if (!parsed.success) throw new AppError('NOT_FOUND', 404, 'Not found');
  return parsed.data;
};
const actorOf = (req: Request): Actor => {
  const auth = req.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
  return { companyId: auth.companyId, userId: auth.userId };
};

export const createWarehouseRouter = (
  deps: WarehouseDeps,
  requirePermission: RequirePermission,
): Router => {
  const router = Router();

  router.get('/warehouses', requirePermission('inventory.warehouse.read'), async (req, res) => {
    const query = parseInput(warehouseListQuerySchema, req.query);
    const { data, meta } = await listWarehouses(deps, actorOf(req), query);
    res.json({ data, meta });
  });

  router.post('/warehouses', requirePermission('inventory.warehouse.create'), async (req, res) => {
    const input = parseInput(createWarehouseSchema, req.body);
    res.status(201).json({ data: await createWarehouse(deps, actorOf(req), input), meta: {} });
  });

  router.get('/warehouses/:id', requirePermission('inventory.warehouse.read'), async (req, res) => {
    res.json({ data: await getWarehouse(deps, actorOf(req), idParam(req, 'id')), meta: {} });
  });

  router.patch(
    '/warehouses/:id',
    requirePermission('inventory.warehouse.update'),
    async (req, res) => {
      const input = parseInput(updateWarehouseSchema, req.body);
      res.json({
        data: await updateWarehouse(deps, actorOf(req), idParam(req, 'id'), input),
        meta: {},
      });
    },
  );

  router.delete(
    '/warehouses/:id',
    requirePermission('inventory.warehouse.delete'),
    async (req, res) => {
      await deleteWarehouse(deps, actorOf(req), idParam(req, 'id'));
      res.json({ data: { deleted: true }, meta: {} });
    },
  );

  // المواقع جزء من المستودع: القراءة بصلاحية قراءته، والكتابة بصلاحية تعديله.
  // Locations belong to the warehouse: reading needs its read permission, writing its update permission.
  router.get(
    '/warehouses/:id/locations',
    requirePermission('inventory.warehouse.read'),
    async (req, res) => {
      res.json({ data: await listLocations(deps, actorOf(req), idParam(req, 'id')), meta: {} });
    },
  );

  router.post(
    '/warehouses/:id/locations',
    requirePermission('inventory.warehouse.update'),
    async (req, res) => {
      const input = parseInput(createLocationSchema, req.body);
      res.status(201).json({
        data: await createLocation(deps, actorOf(req), idParam(req, 'id'), input),
        meta: {},
      });
    },
  );

  router.patch(
    '/warehouses/:id/locations/:locationId',
    requirePermission('inventory.warehouse.update'),
    async (req, res) => {
      const input = parseInput(updateLocationSchema, req.body);
      res.json({
        data: await updateLocation(
          deps,
          actorOf(req),
          idParam(req, 'id'),
          idParam(req, 'locationId'),
          input,
        ),
        meta: {},
      });
    },
  );

  router.delete(
    '/warehouses/:id/locations/:locationId',
    requirePermission('inventory.warehouse.update'),
    async (req, res) => {
      await deleteLocation(deps, actorOf(req), idParam(req, 'id'), idParam(req, 'locationId'));
      res.json({ data: { deleted: true }, meta: {} });
    },
  );

  router.get(
    '/users/:userId/warehouses',
    requirePermission('identity.user.assign_warehouse'),
    async (req, res) => {
      res.json({
        data: await getUserWarehouses(deps, actorOf(req), idParam(req, 'userId')),
        meta: {},
      });
    },
  );

  router.put(
    '/users/:userId/warehouses',
    requirePermission('identity.user.assign_warehouse'),
    async (req, res) => {
      const input = parseInput(setUserWarehousesSchema, req.body);
      res.json({
        data: await setUserWarehouses(
          deps,
          actorOf(req),
          idParam(req, 'userId'),
          input.warehouseIds,
        ),
        meta: {},
      });
    },
  );

  return router;
};
