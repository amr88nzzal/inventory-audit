import { changePasswordSchema, loginSchema } from '@inventory/shared';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../errors';
import { parseInput } from '../../validation';
import { changePassword, login } from './service';
import type { LoginResult } from './service';
import { logoutAll, logoutByRefreshToken, refreshSession } from './sessions';
import type { RefreshResult } from './sessions';
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

// الويب: توكن التحديث في كوكي httpOnly لا تصل إليه سكربتات الصفحة. الموبايل (X-Client: mobile): في
// الجسم ليحفظه في التخزين الآمن للجهاز. SameSite=Strict ومسار الكوكي محصور في /auth.
// Web: the refresh token lives in an httpOnly cookie that page scripts cannot read. Mobile
// (X-Client: mobile): in the body, to keep in the device's secure storage. SameSite=Strict and
// the cookie path is limited to /auth.
const COOKIE_NAME = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

const isMobile = (req: Request): boolean => req.header('x-client') === 'mobile';

const readCookie = (req: Request, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
};

const refreshTokenFrom = (req: Request): unknown => {
  if (isMobile(req)) {
    const body: unknown = req.body;
    return body && typeof body === 'object'
      ? (body as Record<string, unknown>)['refreshToken']
      : undefined;
  }
  return readCookie(req, COOKIE_NAME);
};

const setRefreshCookie = (res: Response, deps: AuthDeps, token: string, expires: Date): void => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: deps.config.nodeEnv === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires,
  });
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

const sendSession = (
  req: Request,
  res: Response,
  deps: AuthDeps,
  result: LoginResult | RefreshResult,
): void => {
  const mobile = isMobile(req);
  if (!mobile) setRefreshCookie(res, deps, result.refreshToken, result.refreshExpiresAt);
  res.json({
    data: {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresAt: result.expiresAt.toISOString(),
      ...(mobile
        ? {
            refreshToken: result.refreshToken,
            refreshExpiresAt: result.refreshExpiresAt.toISOString(),
          }
        : {}),
      user: toPublicUser(result.user),
    },
    meta: {},
  });
};

// التحديث والخروج: حدّ لكل عنوان فقط؛ التوكن العشوائي 256 بتاً لا يُخمَّن.
// Refresh and logout: a per-address limit only; the 256-bit random token cannot be guessed.
const refreshLimiters = (deps: AuthDeps): RequestHandler[] => [
  rateLimit({
    windowMs: deps.config.rateLimit.loginWindowMinutes * 60_000,
    limit: deps.config.rateLimit.loginPerWindow * 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) => next(tooMany()),
  }),
];

/** مسارات عامة: لا تتطلب توكناً. Public routes: no token required. */
export const createPublicAuthRouter = (deps: AuthDeps): Router => {
  const router = Router();

  router.post('/login', ...loginLimiters(deps), async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const result = await login(deps, input, new Date(), {
      userAgent: req.header('user-agent') ?? null,
    });
    sendSession(req, res, deps, result);
  });

  router.post('/refresh', ...refreshLimiters(deps), async (req, res) => {
    const result = await refreshSession(deps, refreshTokenFrom(req));
    sendSession(req, res, deps, result);
  });

  // يعمل بلا توكن وصول وبنجاح دائماً؛ لا يكشف إن كان توكن التحديث صالحاً.
  // Works without an access token and always succeeds; it does not reveal whether the token was valid.
  router.post('/logout', ...refreshLimiters(deps), async (req, res) => {
    await logoutByRefreshToken(deps, refreshTokenFrom(req));
    res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
    res.json({ data: { loggedOut: true }, meta: {} });
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

  router.post('/logout-all', async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    await logoutAll(deps, auth);
    res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
    res.json({ data: { loggedOut: true }, meta: {} });
  });

  return router;
};
