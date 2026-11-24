import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { sql } from 'kysely';
import { DEMO_PASSWORD } from '@inventory/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedDemo } from '../modules/demo';
import { testConfig } from '../testing/test-config';
import { createTestDb } from '../testing/test-db';
import type { TestDb } from '../testing/test-db';
import { createDb, provisionAppLogin, withPlatform, withTenant } from './index';
import type { Database } from './index';
import type { Kysely } from 'kysely';

// الإنتاج: التطبيق يتصل بحساب بلا صلاحيات بذاته (INHERIT FALSE). نثبت أن كل شيء يعمل بهذا الحساب
// وأن أي وصول خارج withTenant/withPlatform يفشل، فلا يتجاوز التطبيق RLS حتى لو نسي مطوّر الغلاف.
// Production: the app connects as an account with no privileges of its own (INHERIT FALSE). We prove
// everything works as that account and that any access outside withTenant/withPlatform fails, so the
// app cannot bypass RLS even if a developer forgets the wrapper.

const ROLE = `inv_login_${randomBytes(4).toString('hex')}`;
const PW = 'a-long-random-login-password-1';
let t: TestDb;
let app: Kysely<Database>;

beforeAll(async () => {
  t = await createTestDb();
  await provisionAppLogin(t.db, PW, ROLE);
  const u = new URL(t.url);
  u.username = ROLE;
  u.password = PW;
  app = createDb(u.toString(), { max: 3 });
});
afterAll(async () => {
  await app.destroy();
  await t.cleanup();
  const { Pool } = await import('pg');
  const admin = new Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    max: 1,
  });
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.end();
});

describe('least-privilege app login', () => {
  it('is not a superuser, cannot bypass RLS and holds no privilege of its own', async () => {
    const row = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean }>`
      SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname = ${ROLE}`.execute(
      t.db,
    );
    expect(row.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false });
    for (const q of ['SELECT 1 FROM users', 'SELECT 1 FROM companies', 'CREATE TABLE x (a int)']) {
      await expect(sql.raw(q).execute(app), q).rejects.toThrow(/permission denied/);
    }
  });

  it('the whole app works through it: demo seed, sign-in, RBAC, platform guard', async () => {
    const config = testConfig();
    const result = await seedDemo({ db: app, logN: 10 });
    const api = createApp({ db: app, config });
    const login = await request(api)
      .post('/api/v1/auth/login')
      .send({ companyCode: 'demo', username: 'demo.admin', password: DEMO_PASSWORD });
    expect(login.status).toBe(200);
    const roles = await request(api)
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(roles.status).toBe(200);
    expect((await request(api).get('/api/v1/platform/me')).status).toBe(401);
    // الغلافان وحدهما يفتحان البيانات. Only the two wrappers open data.
    const users = await withTenant(app, { companyId: result.companyId }, ({ trx }) =>
      trx.selectFrom('users').select('id').execute(),
    );
    expect(users.length).toBeGreaterThan(0);
    await expect(withPlatform(app, (trx) => sql`SELECT 1 FROM users`.execute(trx))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('is safe to re-run and rejects weak passwords and bad role names', async () => {
    await expect(provisionAppLogin(t.db, PW, ROLE)).resolves.toBeUndefined();
    await expect(provisionAppLogin(t.db, 'short', ROLE)).rejects.toThrow(/16/);
    await expect(provisionAppLogin(t.db, PW, 'Bad Name; DROP')).rejects.toThrow(/invalid/);
  });
});
