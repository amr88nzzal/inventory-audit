import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Kysely } from 'kysely';
import type { AppConfig } from './config';
import type { Database } from './db';
import { AppError } from './errors';
import { createAuthModule } from './modules/auth';

// نوسّع Request عبر مساحة Express العامة (لا تحتاج حزمة داخلية غير قابلة للاستيراد).
// Augment Request via the global Express namespace (no need for an internal, non-importable package).
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export interface AppDeps {
  db: Kysely<Database>;
  config: AppConfig;
  /**
   * وحدات الأعمال المحمية؛ تُركَّب بعد requireAuth تلقائياً، فلا يمكن نسيان حمايتها.
   * Protected business modules; mounted after requireAuth automatically, so protection cannot be forgotten.
   */
  protectedRouters?: Router[];
}

// معرّف طلب لكل استدعاء لتتبّع الأخطاء في السجلات والردود.
// A per-request id so errors can be traced across logs and responses.
const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

const notFound: RequestHandler = (req) => {
  throw new AppError('NOT_FOUND', 404, `Route not found: ${req.method} ${req.path}`);
};

// لا نسرّب تفاصيل الأخطاء غير المتوقعة للعميل.
// Never leak details of unexpected errors to the client.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // JSON غير صالح خطأ من العميل (400) لا من الخادم.
  // Malformed JSON is a client error (400), not a server error.
  const normalized =
    err instanceof AppError
      ? err
      : (err as { type?: string }).type === 'entity.parse.failed'
        ? new AppError('INVALID_JSON', 400, 'Request body is not valid JSON')
        : null;
  const status = normalized?.status ?? 500;
  if (!normalized) {
    // نسجّل الخطأ الحقيقي في الخادم فقط، مع معرّف الطلب للربط.
    // Log the real error server-side only, with the request id for correlation.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'unhandled error',
        requestId: req.requestId,
        error: (err as Error).message,
      }),
    );
  }
  res.status(status).json({
    error: {
      code: normalized?.code ?? 'INTERNAL_ERROR',
      status,
      message: normalized?.message ?? 'Internal server error',
      details: normalized?.details ?? null,
      requestId: req.requestId,
    },
  });
};

export const createApp = (deps: AppDeps): Express => {
  const { config } = deps;
  const app = express();

  // خلف Nginx وCloudflare نثق بالوكيل الأول فقط.
  // Behind Nginx and Cloudflare we trust exactly one proxy hop.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimit.generalPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(new AppError('RATE_LIMITED', 429, 'Too many requests, slow down')),
    }),
  );

  const auth = createAuthModule(deps);
  const api = Router();

  // المسارات العامة: قائمة بيضاء صريحة وقصيرة. أي مسار غيرها تحت /api/v1 يتطلب توكناً.
  // Public routes: a short, explicit allowlist. Any other route under /api/v1 requires a token.
  api.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok' }, meta: {} });
  });
  api.use('/auth', auth.publicRouter);

  // رفض افتراضي: من هنا فصاعداً لا يصل أحد دون توكن صالح، حتى لمسار غير موجود (لا نكشف المسارات).
  // Default deny: from here on nobody gets through without a valid token, even to a route that
  // does not exist (we do not reveal which routes exist).
  api.use(auth.requireAuth, auth.blockUntilPasswordChanged);
  api.use('/auth', auth.protectedRouter);
  for (const router of deps.protectedRouters ?? []) api.use(router);
  api.use(notFound);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
};
