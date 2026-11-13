import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import helmet from 'helmet';
import { AppError } from './errors';

// نوسّع Request عبر مساحة Express العامة (لا تحتاج حزمة داخلية غير قابلة للاستيراد).
// Augment Request via the global Express namespace (no need for an internal, non-importable package).
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
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

export const createApp = (): Express => {
  const app = express();

  // خلف Nginx وCloudflare نثق بالوكيل الأول فقط.
  // Behind Nginx and Cloudflare we trust exactly one proxy hop.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok' }, meta: {} });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
};
