import type { RequestHandler } from 'express';
import { AppError } from '../../errors';
import { loadPlatformIdentity } from './service';
import type { PlatformDeps, PlatformIdentity } from './service';

declare global {
  namespace Express {
    interface Request {
      platformAdmin?: PlatformIdentity;
    }
  }
}

// قائمة عناوين مسموحة اختيارية: غير المسموح يرى 404 كأن المسار غير موجود (لا نكشف وجود لوحة المنصة).
// An optional address allowlist: anyone else sees 404 as if the route did not exist (we do not reveal the platform area).
export const platformIpGuard =
  (allowedIps: readonly string[]): RequestHandler =>
  (req, _res, next) => {
    if (allowedIps.length > 0 && !allowedIps.includes(req.ip ?? '')) {
      throw new AppError('NOT_FOUND', 404, `Route not found: ${req.method} ${req.path}`);
    }
    next();
  };

export const createRequirePlatformAuth =
  (deps: PlatformDeps): RequestHandler =>
  async (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    const claims = scheme === 'Bearer' && token ? await deps.tokens.verify('access', token) : null;
    // الحالة من القاعدة عند كل طلب: تعطيل المدير أو إعادة تهيئته يقطع توكنه فوراً.
    // State comes from the database on every request: disabling or resetting an admin cuts their token at once.
    const identity = claims ? await loadPlatformIdentity(deps, claims) : null;
    if (!identity) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    req.platformAdmin = identity;
    next();
  };
