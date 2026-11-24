import {
  BARCODE_PATTERN,
  createItemSchema,
  itemListQuerySchema,
  updateItemSchema,
} from '@inventory/shared';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import type { RequirePermission } from '../rbac';
import {
  createItem,
  deleteItem,
  getItem,
  getItemByBarcode,
  listItems,
  updateItem,
} from './service';
import type { Actor, ItemDeps } from './service';

const uuidSchema = z.uuid();
const idParam = (req: Request): string => {
  const parsed = uuidSchema.safeParse(req.params['id']);
  if (!parsed.success) throw new AppError('NOT_FOUND', 404, 'Not found');
  return parsed.data;
};
const actorOf = (req: Request): Actor => {
  const auth = req.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
  return { companyId: auth.companyId, userId: auth.userId };
};

export const createItemRouter = (deps: ItemDeps, requirePermission: RequirePermission): Router => {
  const router = Router();

  router.get('/items', requirePermission('inventory.item.read'), async (req, res) => {
    const { data, meta } = await listItems(
      deps,
      actorOf(req),
      parseInput(itemListQuerySchema, req.query),
    );
    res.json({ data, meta });
  });

  // قبل /items/:id كي لا يُفسَّر «by-barcode» معرّفاً. Declared before /items/:id so "by-barcode" is not read as an id.
  router.get(
    '/items/by-barcode/:barcode',
    requirePermission('inventory.item.read'),
    async (req, res) => {
      const barcode = String(req.params['barcode']);
      if (!BARCODE_PATTERN.test(barcode)) throw new AppError('NOT_FOUND', 404, 'Item not found');
      res.json({ data: await getItemByBarcode(deps, actorOf(req), barcode), meta: {} });
    },
  );

  router.post('/items', requirePermission('inventory.item.create'), async (req, res) => {
    const input = parseInput(createItemSchema, req.body);
    res.status(201).json({ data: await createItem(deps, actorOf(req), input), meta: {} });
  });

  router.get('/items/:id', requirePermission('inventory.item.read'), async (req, res) => {
    res.json({ data: await getItem(deps, actorOf(req), idParam(req)), meta: {} });
  });

  router.patch('/items/:id', requirePermission('inventory.item.update'), async (req, res) => {
    const input = parseInput(updateItemSchema, req.body);
    res.json({ data: await updateItem(deps, actorOf(req), idParam(req), input), meta: {} });
  });

  router.delete('/items/:id', requirePermission('inventory.item.delete'), async (req, res) => {
    await deleteItem(deps, actorOf(req), idParam(req));
    res.json({ data: { deleted: true }, meta: {} });
  });

  return router;
};
