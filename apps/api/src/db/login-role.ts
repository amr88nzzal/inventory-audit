import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './schema';

export const APP_LOGIN_ROLE = 'inventory_login';

/**
 * ينشئ/يحدّث حساب الدخول الذي يتصل به التطبيق في الإنتاج. حساب بلا صلاحيات بذاته:
 * عضو في دوري التطبيق والمنصة بخيار SET فقط (INHERIT FALSE)، فلا يقرأ شيئاً إلا داخل
 * withTenant/withPlatform الذي يبدّل الدور. أي استعلام خارجهما يفشل بـ permission denied.
 * Creates/updates the login account the app connects with in production. It holds no privileges itself:
 * a member of the app and platform roles with the SET option only (INHERIT FALSE), so it can read
 * nothing except inside withTenant/withPlatform, which switch role. Any query outside them fails
 * with permission denied.
 *
 * يعمل بحساب المالك (يتجاوز RLS)، ويمرَّر السر عبر set_config ثم format(%L) لأن ALTER ROLE لا يقبل
 * معاملات ربط. آمن لإعادة التشغيل. Runs as the owner; the secret goes through set_config then
 * format(%L) since ALTER ROLE takes no bind parameters. Safe to re-run.
 */
export const provisionAppLogin = async (
  adminDb: Kysely<Database>,
  password: string,
  loginRole: string = APP_LOGIN_ROLE,
): Promise<void> => {
  if (!/^[a-z_][a-z0-9_]{2,40}$/.test(loginRole)) throw new Error('invalid role name');
  if (password.length < 16) throw new Error('APP_DB_PASSWORD must be at least 16 characters');
  await adminDb.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.provision_pw', ${password}, true),
                     set_config('app.provision_role', ${loginRole}, true)`.execute(trx);
    await sql`
      DO $$
      DECLARE r text := current_setting('app.provision_role'); pw text := current_setting('app.provision_pw');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', r, pw);
        ELSE
          EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', r, pw);
        END IF;
        EXECUTE format('GRANT inventory_app, inventory_platform TO %I WITH INHERIT FALSE, SET TRUE', r);
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
      END $$`.execute(trx);
  });
};
