import {
  createRoleSchema,
  PERMISSIONS,
  setUserRolesSchema,
  updateRoleSchema,
} from '@inventory/shared';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import type { RequirePermission } from './middleware';
import type { PermissionService } from './permissions';
import { createRole, deleteRole, listRoles, setUserRoles, updateRole } from './service';
import type { Actor, RbacDeps } from './service';

const uuidSchema = z.uuid();

// معرّف غير صالح في المسار يُعامل كسجل غير موجود (404) لا كخطأ تحقق، فلا نكشف شكل المعرّفات.
// A malformed id in the path is treated as a missing record (404), not a validation error.
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

export const createRbacRouter = (
  deps: RbacDeps,
  permissions: PermissionService,
  requirePermission: RequirePermission,
): Router => {
  const router = Router();

  // صلاحياتي: أي مستخدم مسجّل يرى صلاحياته (تحتاجها الواجهة لإخفاء الأزرار).
  // My permissions: any signed-in user sees their own (the UI needs them to hide controls).
  router.get('/permissions/mine', async (req, res) => {
    const held = await permissions.forUser(actorOf(req));
    res.json({ data: { permissions: [...held].sort() }, meta: {} });
  });

  router.get('/permissions/catalog', requirePermission('identity.role.read'), (_req, res) => {
    res.json({ data: { permissions: [...PERMISSIONS] }, meta: {} });
  });

  router.get('/roles', requirePermission('identity.role.read'), async (req, res) => {
    res.json({ data: await listRoles(deps, actorOf(req)), meta: {} });
  });

  router.post('/roles', requirePermission('identity.role.create'), async (req, res) => {
    const input = parseInput(createRoleSchema, req.body);
    res.status(201).json({ data: await createRole(deps, actorOf(req), input), meta: {} });
  });

  router.patch('/roles/:id', requirePermission('identity.role.update'), async (req, res) => {
    const input = parseInput(updateRoleSchema, req.body);
    res.json({ data: await updateRole(deps, actorOf(req), idParam(req, 'id'), input), meta: {} });
  });

  router.delete('/roles/:id', requirePermission('identity.role.delete'), async (req, res) => {
    await deleteRole(deps, actorOf(req), idParam(req, 'id'));
    res.json({ data: { deleted: true }, meta: {} });
  });

  router.put(
    '/users/:userId/roles',
    requirePermission('identity.user.assign_role'),
    async (req, res) => {
      const input = parseInput(setUserRolesSchema, req.body);
      const roles = await setUserRoles(deps, actorOf(req), idParam(req, 'userId'), input.roleIds);
      res.json({ data: roles, meta: {} });
    },
  );

  return router;
};
