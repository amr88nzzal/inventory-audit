import type { Permission } from '@inventory/shared';
import type { RequestHandler } from 'express';
import { AppError } from '../../errors';
import type { PermissionService } from './permissions';

/**
 * يشترط صلاحية على المسار: يعمل بعد requireAuth. غياب الهوية 401، وغياب الصلاحية 403.
 * Requires a permission on a route: runs after requireAuth. No identity is 401, no permission is 403.
 */
export const createRequirePermission =
  (permissions: PermissionService) =>
  (...required: [Permission, ...Permission[]]): RequestHandler =>
  async (req, _res, next) => {
    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    const held = await permissions.forUser({ companyId: auth.companyId, userId: auth.userId });
    const missing = required.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission for this action', {
        missing,
      });
    }
    next();
  };

export type RequirePermission = ReturnType<typeof createRequirePermission>;
