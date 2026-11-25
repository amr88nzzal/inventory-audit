import {
  createTaskSchema,
  taskListQuerySchema,
  taskTransitionSchema,
  updateTaskSchema,
} from '@inventory/shared';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import type { PermissionService, RequirePermission } from '../rbac';
import { cancelTask, createTask, getTask, listTasks, startTask, updateTask } from './service';
import type { Actor, TaskDeps } from './service';

const uuidSchema = z.uuid();
// معرّف غير صالح = سجل غير موجود (404). A malformed id is a missing record (404).
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

export const createTaskRouter = (
  deps: TaskDeps,
  permissions: PermissionService,
  requirePermission: RequirePermission,
): Router => {
  const router = Router();
  // من يملك read_all يرى كل المهام؛ غيره لا يرى إلا ما أُسند إليه. read_all sees every task; others only their own.
  const seesAll = async (req: Request): Promise<boolean> =>
    (await permissions.forUser(actorOf(req))).has('inventory.task.read_all');

  router.get('/tasks', requirePermission('inventory.task.read'), async (req, res) => {
    const query = parseInput(taskListQuerySchema, req.query);
    const { data, meta } = await listTasks(deps, actorOf(req), query, await seesAll(req));
    res.json({ data, meta });
  });

  router.post('/tasks', requirePermission('inventory.task.create'), async (req, res) => {
    const input = parseInput(createTaskSchema, req.body);
    res.status(201).json({ data: await createTask(deps, actorOf(req), input), meta: {} });
  });

  router.get('/tasks/:id', requirePermission('inventory.task.read'), async (req, res) => {
    res.json({
      data: await getTask(deps, actorOf(req), idParam(req), await seesAll(req)),
      meta: {},
    });
  });

  router.patch('/tasks/:id', requirePermission('inventory.task.update'), async (req, res) => {
    const input = parseInput(updateTaskSchema, req.body);
    res.json({ data: await updateTask(deps, actorOf(req), idParam(req), input), meta: {} });
  });

  router.post('/tasks/:id/start', requirePermission('inventory.task.start'), async (req, res) => {
    const { version } = parseInput(taskTransitionSchema, req.body);
    res.json({ data: await startTask(deps, actorOf(req), idParam(req), version), meta: {} });
  });

  router.post('/tasks/:id/cancel', requirePermission('inventory.task.cancel'), async (req, res) => {
    const { version } = parseInput(taskTransitionSchema, req.body);
    res.json({ data: await cancelTask(deps, actorOf(req), idParam(req), version), meta: {} });
  });

  return router;
};
