import { platformEnrollSchema, platformLoginSchema, platformVerifySchema } from '@inventory/shared';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import { completeEnrollment, login, verifyLoginCode } from './service';
import type { PlatformDeps, PlatformSession } from './service';

const sessionBody = (s: PlatformSession): Record<string, unknown> => ({
  accessToken: s.accessToken,
  tokenType: s.tokenType,
  expiresAt: s.expiresAt.toISOString(),
  admin: { id: s.admin.adminId, username: s.admin.username, displayName: s.admin.displayName },
});

// عدد المستخدمين قليل جداً فالحدّ صارم: لكل عنوان 20 محاولة كل 15 دقيقة على كل خطوات الدخول.
// There are very few platform users, so the limit is strict: 20 attempts per address per 15 minutes across all sign-in steps.
const authLimiter = (deps: PlatformDeps): RequestHandler =>
  rateLimit({
    windowMs: deps.config.rateLimit.loginWindowMinutes * 60_000,
    limit: deps.config.rateLimit.loginPerWindow * 2,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) =>
      next(new AppError('RATE_LIMITED', 429, 'Too many attempts, try again later')),
  });

/** مسارات الدخول العامة (لا توكن بعد). Public sign-in routes (no token yet). */
export const createPlatformPublicRouter = (deps: PlatformDeps): Router => {
  const router = Router();
  const limiter = authLimiter(deps);

  router.post('/auth/login', limiter, async (req, res) => {
    const input = parseInput(platformLoginSchema, req.body);
    res.json({ data: await login(deps, input), meta: {} });
  });

  router.post('/auth/verify', limiter, async (req, res) => {
    const input = parseInput(platformVerifySchema, req.body);
    res.json({ data: sessionBody(await verifyLoginCode(deps, input)), meta: {} });
  });

  router.post('/auth/enroll', limiter, async (req, res) => {
    const input = parseInput(platformEnrollSchema, req.body);
    res.json({ data: sessionBody(await completeEnrollment(deps, input)), meta: {} });
  });

  return router;
};

/** مسارات محمية بتوكن المنصة. Routes protected by a platform token. */
export const createPlatformProtectedRouter = (): Router => {
  const router = Router();
  router.get('/me', (req, res) => {
    const admin = req.platformAdmin;
    if (!admin) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    res.json({
      data: { id: admin.adminId, username: admin.username, displayName: admin.displayName },
      meta: {},
    });
  });
  return router;
};
