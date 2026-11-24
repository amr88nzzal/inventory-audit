import { loadConfig } from './config';
import { createDb, provisionAppLogin, runMigrations } from './db';
import { resetDemo, seedDemo } from './modules/demo';
import { createPlatformAdmin, resetPlatformAdmin } from './modules/platform';

// أوامر تشغيلية تُنفَّذ على الخادم (الخيار الأول لإنشاء مدير المنصة):
//   node dist/cli.js create-platform-admin <username>   [PLATFORM_CLI_PASSWORD في البيئة]
//   node dist/cli.js reset-platform-admin  <username>   [PLATFORM_CLI_PASSWORD في البيئة]
// كلمة المرور تُقرأ من البيئة لا من سطر الأوامر كي لا تُحفظ في تاريخ الصدفة (history).
// Operational commands run on the server (the first option for creating the platform admin).
// The password is read from the environment, not the command line, so it never lands in shell history.

const USAGE =
  'Usage: PLATFORM_CLI_PASSWORD=... node dist/cli.js <create-platform-admin|reset-platform-admin> <username>\n       node dist/cli.js <seed-demo|reset-demo>\n       DATABASE_ADMIN_URL=... [APP_DB_PASSWORD=...] node dist/cli.js <migrate|post-migrate>';

const main = async (): Promise<number> => {
  const [command, username] = process.argv.slice(2);
  // أوامر النشر (تعمل بحساب المالك في حاوية migrate): migrate ثم post-migrate. آمنة لإعادة التشغيل.
  // Deploy commands (run as the owner in the migrate container): migrate, then post-migrate. Safe to re-run.
  if (command === 'migrate') {
    const url = process.env['DATABASE_ADMIN_URL'];
    if (!url) throw new Error('DATABASE_ADMIN_URL is required');
    const result = await runMigrations(url);
    console.log(`migrate: ${JSON.stringify(result)}`);
    return 0;
  }
  if (command === 'post-migrate') {
    const url = process.env['DATABASE_ADMIN_URL'];
    const password = process.env['APP_DB_PASSWORD'];
    if (!url || !password) throw new Error('DATABASE_ADMIN_URL and APP_DB_PASSWORD are required');
    const db = createDb(url, { max: 1 });
    try {
      await provisionAppLogin(db, password);
      console.log('post-migrate: app login role configured');
      return 0;
    } finally {
      await db.destroy();
    }
  }
  // أوامر الشركة التجريبية لا تحتاج كلمة مرور (كلمتها معروفة ومنشورة في الدليل).
  // Demo commands need no password (the demo password is public, in the guide).
  if (command === 'seed-demo' || command === 'reset-demo') {
    const config = loadConfig();
    const db = createDb(config.databaseUrl, { max: 2 });
    try {
      const deps = { db, logN: config.passwordHashLogN };
      const r = command === 'seed-demo' ? await seedDemo(deps) : await resetDemo(deps);
      console.log(
        `${command === 'seed-demo' ? 'Seeded' : 'Reset'} demo company "${r.companyCode}" ` +
          `(${r.createdCompany ? 'created' : 'already existed'}): ${r.usernames.join(', ')}`,
      );
      return 0;
    } finally {
      await db.destroy();
    }
  }
  const password = process.env['PLATFORM_CLI_PASSWORD'] ?? '';
  if (!command || !username || !password) {
    console.error(USAGE);
    return 2;
  }

  const config = loadConfig();
  const db = createDb(config.databaseUrl, { max: 2 });
  try {
    if (command === 'create-platform-admin') {
      await createPlatformAdmin({ db, config }, { username, password });
      console.log(`Created platform admin "${username}". Sign in to enroll the authenticator app.`);
      return 0;
    }
    if (command === 'reset-platform-admin') {
      const found = await resetPlatformAdmin({ db, config }, username, password);
      if (!found) {
        console.error(`No platform admin named "${username}".`);
        return 1;
      }
      console.log(
        `Reset "${username}": temporary password set, authenticator cleared, sessions voided.`,
      );
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    await db.destroy();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // رسالة الخطأ فقط (لا تتضمن كلمة المرور). The error message only (it never contains the password).
    console.error(`Failed: ${(err as Error).message}`);
    process.exit(1);
  });
