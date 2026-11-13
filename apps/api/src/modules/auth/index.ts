// الواجهة العامة لوحدة المصادقة: لا يستورد غيرها من ملفاتها الداخلية.
// The auth module's public surface: nothing imports its internal files directly.
import type { Router } from 'express';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../../config';
import type { Database } from '../../db';
import type { Kysely } from 'kysely';
import { createAuthMiddleware } from './middleware';
import { createProtectedAuthRouter, createPublicAuthRouter } from './routes';
import { createTokenService } from './tokens';

export interface AuthModule {
  /** يُركَّب قبل requireAuth (تسجيل الدخول). Mounted before requireAuth (login). */
  publicRouter: Router;
  /** يُركَّب بعد requireAuth. Mounted after requireAuth. */
  protectedRouter: Router;
  requireAuth: RequestHandler;
  blockUntilPasswordChanged: RequestHandler;
}

export const createAuthModule = (deps: { db: Kysely<Database>; config: AppConfig }): AuthModule => {
  const tokens = createTokenService(deps.config.jwtSecret, deps.config.accessTokenTtlSeconds);
  const authDeps = { ...deps, tokens };
  return {
    publicRouter: createPublicAuthRouter(authDeps),
    protectedRouter: createProtectedAuthRouter(authDeps),
    ...createAuthMiddleware(authDeps),
  };
};

export type { AuthContext } from './service';

// تجزئة كلمات المرور متاحة للوحدات الأخرى (مثل إنشاء الأدمن الأول لاحقاً).
// Password hashing is exposed to other modules (e.g. creating the first admin later).
export { hashPassword } from './password';
