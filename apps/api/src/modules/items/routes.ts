import {
  BARCODE_PATTERN,
  IMPORT_MAX_BYTES,
  ImportFileError,
  ITEMS_IMPORT_TEMPLATE,
  createItemSchema,
  itemListQuerySchema,
  updateItemSchema,
} from '@inventory/shared';
import { Router, text } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import type { RequirePermission } from '../rbac';
import { importItems } from './import';
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
const importQuerySchema = z
  .object({
    mode: z.enum(['preview', 'apply']).default('preview'),
    skipInvalid: z.enum(['true', 'false']).default('false'),
  })
  .strict();
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

  // قالب الاستيراد (قبل /items/:id). The import template (before /items/:id).
  router.get('/items/import/template', requirePermission('inventory.item.import'), (_req, res) => {
    res
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="items-template.csv"');
    res.send(ITEMS_IMPORT_TEMPLATE);
  });

  // الجسم نص CSV خام؛ المحلل خاص بهذا المسار كي لا يرفع حد JSON العام (1mb).
  // The body is raw CSV text; the parser is route-level so the global JSON limit (1mb) stays.
  router.post(
    '/items/import',
    requirePermission('inventory.item.import'),
    text({ type: ['text/csv', 'text/plain'], limit: IMPORT_MAX_BYTES }),
    async (req, res) => {
      if (typeof req.body !== 'string')
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the file as text/csv');
      const q = parseInput(importQuerySchema, req.query);
      try {
        const data = await importItems(deps, actorOf(req), req.body, {
          mode: q.mode,
          skipInvalid: q.skipInvalid === 'true',
        });
        res.json({ data, meta: {} });
      } catch (err) {
        if (err instanceof ImportFileError)
          throw new AppError(`IMPORT_${err.code}`, 422, err.message, err.details);
        throw err;
      }
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
