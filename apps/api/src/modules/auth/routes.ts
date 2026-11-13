import { changePasswordSchema, loginSchema } from '@inventory/shared';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import { changePassword, login } from './service';
import type { AuthContext, AuthDeps } from './service';

const toPublicUser = (u: AuthContext): Record<string, unknown> => ({
  id: u.userId,
  companyId: u.companyId,
  username: u.username,
  displayName: u.displayName,
  mustChangePassword: u.mustChangePassword,
});

// نقرأ الحقل لمفتاح المحدِّد فقط ونطبّعه؛ التحقق الصارم يبقى على الجسم الأصلي في المسار.
// We read the field only to build the limiter key and normalize it; strict validation still runs
// on the original body in the route.
const field = (req: Request, name: string): string => {
  const body: unknown = req.body;
  const value =
    body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 64) : '';
};

const tooMany = (): AppError =>
  new AppError('RATE_LIMITED', 429, 'Too many attempts, try again later');

// حدّان للدخول: لكل (عنوان + شركة + مستخدم) كي لا يُقفل حساب بتخمين من عنوان واحد بلا حدود،
// ولكل عنوان بحدّ أوسع كي لا يدور المهاجم على أسماء مستخدمين كثيرة.
// Two login limits: per (ip + company + user) so one address cannot guess one account endlessly,
// and per address with a wider cap so an attacker cannot just rotate through many usernames.
const loginLimiters = (deps: AuthDeps): RequestHandler[] => {
  const { loginPerWindow, loginWindowMinutes } = deps.config.rateLimit;
  const windowMs = loginWindowMinutes * 60_000;
  const common = {
    windowMs,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    handler: (_req: Request, _res: unknown, next: (e?: unknown) => void) => next(tooMany()),
  };
  return [
    rateLimit({
      ...common,
      limit: loginPerWindow,
      keyGenerator: (req) =>
        `${ipKeyGenerator(req.ip ?? '')}|${field(req, 'companyCode')}|${field(req, 'username')}`,
    }),
    rateLimit({
      ...common,
      limit: loginPerWindow * 5,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    }),
  ];
};

/** مسارات عامة: لا تتطلب توكناً. Public routes: no token required. */
export const createPublicAuthRouter = (deps: AuthDeps): Router => {
  const router = Router();

  router.post('/login', ...loginLimiters(deps), async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const result = await login(deps, input);
    res.json({
      data: {
        accessToken: result.accessToken,
        tokenType: 'Bearer',
        expiresAt: result.expiresAt.toISOString(),
        user: toPublicUser(result.user),
      },
      meta: {},
    });
  });

  return router;
};

/** مسارات محمية: تمر بـ requireAuth. Protected routes: they go through requireAuth. */
export const createProtectedAuthRouter = (deps: AuthDeps): Router => {
  const router = Router();

  router.get('/me', (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    res.json({ data: toPublicUser(auth), meta: {} });
  });

  router.post('/change-password', async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    const input = parseInput(changePasswordSchema, req.body);
    await changePassword(deps, auth, input);
    res.json({ data: { changed: true }, meta: {} });
  });

  return router;
};
