import { loadConfig } from './config';
import { createDb } from './db';
import { createPlatformAdmin, resetPlatformAdmin } from './modules/platform';

// أوامر تشغيلية تُنفَّذ على الخادم (الخيار الأول لإنشاء مدير المنصة):
//   node dist/cli.js create-platform-admin <username>   [PLATFORM_CLI_PASSWORD في البيئة]
//   node dist/cli.js reset-platform-admin  <username>   [PLATFORM_CLI_PASSWORD في البيئة]
// كلمة المرور تُقرأ من البيئة لا من سطر الأوامر كي لا تُحفظ في تاريخ الصدفة (history).
// Operational commands run on the server (the first option for creating the platform admin).
// The password is read from the environment, not the command line, so it never lands in shell history.

const USAGE =
  'Usage: PLATFORM_CLI_PASSWORD=... node dist/cli.js <create-platform-admin|reset-platform-admin> <username>';

const main = async (): Promise<number> => {
  const [command, username] = process.argv.slice(2);
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
