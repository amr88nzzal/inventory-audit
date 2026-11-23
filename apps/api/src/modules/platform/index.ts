// الواجهة العامة لوحدة المنصة (مدير المشروع): لا يستورد غيرها من ملفاتها الداخلية.
// The platform module's public surface (the project manager): nothing imports its internal files directly.
import type { Router } from 'express';
import type { Kysely } from 'kysely';
import type { AppConfig } from '../../config';
import { createFieldCrypto } from '../../crypto/encryption';
import type { Database } from '../../db';
import { createRequirePlatformAuth, platformIpGuard } from './middleware';
import { createPlatformProtectedRouter, createPlatformPublicRouter } from './routes';
import { createPlatformTokenService } from './tokens';
import type { PlatformDeps } from './service';

export interface PlatformModule {
  /** مسارات الدخول (تُركَّب أولاً). Sign-in routes (mounted first). */
  publicRouter: Router;
  /** حارس الهوية: كل ما بعده يتطلب توكن مدير منصة. The identity guard: everything after it needs a platform token. */
  requireAuth: ReturnType<typeof createRequirePlatformAuth>;
  protectedRouter: Router;
  ipGuard: ReturnType<typeof platformIpGuard>;
  deps: PlatformDeps;
}

export const createPlatformModule = (base: {
  db: Kysely<Database>;
  config: AppConfig;
}): PlatformModule => {
  const deps: PlatformDeps = {
    db: base.db,
    config: base.config,
    crypto: createFieldCrypto(base.config.encryption),
    tokens: createPlatformTokenService(base.config.jwtSecret, base.config.platform.tokenTtlMinutes),
  };
  return {
    deps,
    publicRouter: createPlatformPublicRouter(deps),
    requireAuth: createRequirePlatformAuth(deps),
    protectedRouter: createPlatformProtectedRouter(),
    ipGuard: platformIpGuard(base.config.platform.allowedIps),
  };
};

export { bootstrapPlatformAdmin } from './bootstrap';
export { createPlatformAdmin, resetPlatformAdmin } from './service';
