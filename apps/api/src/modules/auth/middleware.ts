import type { RequestHandler } from 'express';
import { AppError } from '../../errors';
import { loadAuthContext } from './service';
import type { AuthContext, AuthDeps } from './service';

declare global {
  namespace Express {
    interface Request {
      /** هوية المستخدم بعد requireAuth. The caller's identity after requireAuth. */
      auth?: AuthContext;
    }
  }
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

const unauthenticated = (): AppError =>
  new AppError('UNAUTHENTICATED', 401, 'Authentication required');

// المسارات المسموحة بكلمة مرور مؤقتة: تغييرها وقراءة الهوية فقط. غيرها يُرفض من الخادم
// (لا من الواجهة وحدها).
// Routes allowed with a temporary password: changing it and reading identity only. Anything
// else is refused by the server (not merely hidden by the UI).
const ALLOWED_WHILE_PASSWORD_TEMPORARY = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/change-password',
]);

export const createAuthMiddleware = (
  deps: AuthDeps,
): { requireAuth: RequestHandler; blockUntilPasswordChanged: RequestHandler } => ({
  requireAuth: async (req, _res, next) => {
    const match = BEARER_RE.exec(req.headers.authorization ?? '');
    if (!match?.[1]) throw unauthenticated();

    const claims = await deps.tokens.verify(match[1]);
    if (!claims) throw unauthenticated();

    const ctx = await loadAuthContext(deps, claims);
    if (!ctx) throw unauthenticated();

    req.auth = ctx;
    next();
  },

  blockUntilPasswordChanged: (req, _res, next) => {
    if (req.auth?.mustChangePassword) {
      const key = `${req.method} ${req.baseUrl}${req.path}`;
      if (!ALLOWED_WHILE_PASSWORD_TEMPORARY.has(key)) {
        throw new AppError(
          'PASSWORD_CHANGE_REQUIRED',
          403,
          'You must change your temporary password first',
        );
      }
    }
    next();
  },
});
