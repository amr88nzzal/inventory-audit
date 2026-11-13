import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { createDb, newId, runMigrations } from '../db';
import type { Database } from '../db';

const adminUrl =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface TestDb {
  /** اتصال بصلاحية المالك (يتجاوز RLS) للتحضير فقط. Owner connection (bypasses RLS), for seeding only. */
  db: Kysely<Database>;
  url: string;
  cleanup: () => Promise<void>;
}

const withDatabase = (name: string): string => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

// قاعدة مؤقتة لكل ملف اختبار، تُنشأ وتُهجَّر ثم تُحذف.
// A temporary database per test file: created, migrated, then dropped.
export const createTestDb = async (options: { max?: number } = {}): Promise<TestDb> => {
  const name = `inventory_test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = withDatabase(name);
  await runMigrations(url, migrationsDir);
  const db = createDb(url, options);

  return {
    db,
    url,
    cleanup: async () => {
      await db.destroy();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
};

export const seedCompany = async (db: Kysely<Database>, name: string): Promise<string> => {
  const id = newId();
  await db
    .insertInto('companies')
    .values({ id, name, created_by: null, updated_by: null, deleted_at: null })
    .execute();
  return id;
};

export const seedUser = async (
  db: Kysely<Database>,
  companyId: string,
  username: string,
): Promise<string> => {
  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      company_id: companyId,
      username,
      display_name: username,
      created_by: null,
      updated_by: null,
      deleted_at: null,
    })
    .execute();
  return id;
};
