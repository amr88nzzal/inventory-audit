import { createApp } from './app';
import { loadConfig } from './config';
import { createDb, runMigrations } from './db';
import { bootstrapPlatformAdmin } from './modules/platform';

const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify(entry));

const main = async (): Promise<void> => {
  // فشل سريع بدل التشغيل بنصف إعداد (قاعدة بيانات أو سر JWT ناقص أو ضعيف).
  // Fail fast rather than run half-configured (missing or weak database URL or JWT secret).
  const config = loadConfig();

  // التهجيرات تُطبَّق عند الإقلاع. حساب منفصل بصلاحيات أعلى اختياري (MIGRATION_DATABASE_URL)
  // كي يعمل التطبيق نفسه بحساب أضعف.
  // Migrations run on boot. A separate, more privileged account is optional
  // (MIGRATION_DATABASE_URL) so the app itself can run with a weaker one.
  // في الإنتاج تعمل حاوية migrate بحساب المالك قبل الـ API، فيضبط compose القيمة false ويتصل الـ API
  // بحساب بلا صلاحيات لا يملك حق تغيير المخطط. الافتراضي true للتطوير.
  // In production a migrate container runs as the owner before the API, so compose sets this to false and
  // the API connects as a privilege-less account that cannot alter the schema. Default true for development.
  if (process.env['RUN_MIGRATIONS'] !== 'false') {
    const result = await runMigrations(process.env['MIGRATION_DATABASE_URL'] ?? config.databaseUrl);
    log({ level: 'info', msg: 'migrations done', ...result });
  }

  const db = createDb(config.databaseUrl);

  // أول مدير منصة من البيئة (الإنتاج): يُنشأ مرة واحدة فقط إن لم يوجد مدير.
  // The first platform admin from the environment (production): created once, only when none exists.
  await bootstrapPlatformAdmin({ db, config }, log);
  const server = createApp({ db, config }).listen(config.port, () =>
    log({ level: 'info', msg: 'api listening', port: config.port }),
  );

  // إغلاق نظيف عند إيقاف الحاوية: نكمل الطلبات الجارية ثم نغلق الاتصالات.
  // Clean shutdown when the container stops: finish in-flight requests, then close connections.
  const shutdown = (signal: string): void => {
    log({ level: 'info', msg: 'shutting down', signal });
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

main().catch((err: unknown) => {
  log({ level: 'fatal', msg: 'startup failed', error: (err as Error).message });
  process.exit(1);
});
