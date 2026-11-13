import { createApp } from './app';
import { runMigrations } from './db';

const port = Number(process.env['PORT'] ?? 3000);
const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify(entry));

const main = async (): Promise<void> => {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    // فشل سريع بدل التشغيل بنصف إعداد.
    // Fail fast rather than run half-configured.
    throw new Error('DATABASE_URL is required');
  }

  // التهجيرات تُطبَّق عند الإقلاع. حساب منفصل بصلاحيات أعلى اختياري (MIGRATION_DATABASE_URL)
  // كي يعمل التطبيق نفسه بحساب أضعف.
  // Migrations run on boot. A separate, more privileged account is optional
  // (MIGRATION_DATABASE_URL) so the app itself can run with a weaker one.
  const result = await runMigrations(process.env['MIGRATION_DATABASE_URL'] ?? databaseUrl);
  log({ level: 'info', msg: 'migrations done', ...result });

  createApp().listen(port, () => log({ level: 'info', msg: 'api listening', port }));
};

main().catch((err: unknown) => {
  log({ level: 'fatal', msg: 'startup failed', error: (err as Error).message });
  process.exit(1);
});
