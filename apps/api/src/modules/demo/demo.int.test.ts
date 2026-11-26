import request from 'supertest';
import { sql } from 'kysely';
import {
  DEMO_ACCOUNTS,
  DEMO_ITEMS,
  DEMO_TASK,
  DEMO_COMPANY_CODE,
  DEMO_PASSWORD,
  DEMO_ROLES,
} from '@inventory/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { withPlatform, withTenant } from '../../db';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { testConfig } from '../../testing/test-config';
import { resetDemo, seedDemo } from './index';

let t: TestDb;
let app: ReturnType<typeof createApp>;
let real: string;
const deps = () => ({ db: t.db, logN: 10 });

const login = (username: string, code = DEMO_COMPANY_CODE, password = DEMO_PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ companyCode: code, username, password });

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  // شركة حقيقية موازية: يجب ألا يمسّها البذر ولا إعادة الضبط. A parallel real company the seed/reset must never touch.
  real = await seedCompany(t.db, 'Real Co', 'real-co');
  await seedLoginUser(t.db, real, 'realuser', 'correct-horse-battery-9');
});
afterAll(async () => {
  await t.cleanup();
});

const countUsers = (companyId: string) =>
  withTenant(t.db, { companyId }, async ({ trx }) =>
    Number(
      (
        await trx
          .selectFrom('users')
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
  );

describe('seedDemo', () => {
  it('creates the flagged demo company with every account, all able to sign in', async () => {
    const r = await seedDemo(deps());
    expect(r.createdCompany).toBe(true);
    expect(r.usernames).toEqual(DEMO_ACCOUNTS.map((a) => a.username));
    const row = await withPlatform(t.db, (trx) =>
      trx
        .selectFrom('companies')
        .select(['is_demo', 'code'])
        .where('id', '=', r.companyId)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ is_demo: true, code: DEMO_COMPANY_CODE });
    for (const a of DEMO_ACCOUNTS) {
      const res = await login(a.username);
      expect(res.status, a.username).toBe(200);
    }
  });

  it('is repeat-safe: no duplicate company, users or roles', async () => {
    const before = await seedDemo(deps());
    const again = await seedDemo(deps());
    expect(again.createdCompany).toBe(false);
    expect(again.companyId).toBe(before.companyId);
    expect(await countUsers(before.companyId)).toBe(DEMO_ACCOUNTS.length);
    const roles = await withTenant(t.db, { companyId: before.companyId }, ({ trx }) =>
      trx.selectFrom('roles').select('name').where('deleted_at', 'is', null).execute(),
    );
    expect(roles).toHaveLength(DEMO_ROLES.length + 1); // + admin
  });

  it('gives each account the intended access (admin all, supervisor read-only, auditor none)', async () => {
    const tok = async (u: string) => (await login(u)).body.data.accessToken as string;
    const roles = (token: string) =>
      request(app).get('/api/v1/roles').set('Authorization', `Bearer ${token}`);
    expect((await roles(await tok('demo.admin'))).status).toBe(200);
    expect((await roles(await tok('demo.supervisor'))).status).toBe(200);
    expect((await roles(await tok('demo.auditor1'))).status).toBe(403);
  });

  it('never leaks into another company: demo password fails there and demo users are invisible', async () => {
    expect((await login('demo.admin', 'real-co')).status).toBe(401);
    expect((await login('realuser', DEMO_COMPANY_CODE, 'correct-horse-battery-9')).status).toBe(
      401,
    );
    expect(await countUsers(real)).toBe(1);
  });
});

describe('warehouses layer', () => {
  it('seeds warehouses and locations once, and scopes the auditors', async () => {
    const r = await seedDemo(deps());
    await seedDemo(deps());
    const rows = await withTenant(t.db, { companyId: r.companyId }, async ({ trx }) => ({
      w: await trx
        .selectFrom('warehouses')
        .select('code')
        .where('deleted_at', 'is', null)
        .execute(),
      l: await trx.selectFrom('locations').select('id').where('deleted_at', 'is', null).execute(),
    }));
    expect(rows.w.map((x) => x.code).sort()).toEqual(['BR1', 'COLD', 'MAIN']);
    expect(rows.l).toHaveLength(7);
    const tok = async (u: string) => (await login(u)).body.data.accessToken as string;
    const codes = async (u: string) =>
      (
        await request(app)
          .get('/api/v1/warehouses')
          .set('Authorization', `Bearer ${await tok(u)}`)
      ).body.data
        .map((w: { code: string }) => w.code)
        .sort();
    expect(await codes('demo.admin')).toEqual(['BR1', 'COLD', 'MAIN']);
    expect(await codes('demo.supervisor')).toEqual(['BR1', 'COLD', 'MAIN']);
    expect(await codes('demo.auditor1')).toEqual(['MAIN']);
    expect(await codes('demo.auditor2')).toEqual(['BR1']);
  });
});

describe('items layer', () => {
  it('seeds the items once with their units, readable by the auditors, scannable by barcode', async () => {
    const r = await seedDemo(deps());
    await seedDemo(deps());
    const rows = await withTenant(t.db, { companyId: r.companyId }, async ({ trx }) => ({
      items: await trx.selectFrom('items').select('id').where('deleted_at', 'is', null).execute(),
      units: await trx.selectFrom('item_units').select('id').execute(),
    }));
    expect(rows.items).toHaveLength(DEMO_ITEMS.length);
    expect(rows.units).toHaveLength(DEMO_ITEMS.reduce((n, i) => n + (i.units?.length ?? 0), 0));
    const token = (await login('demo.auditor1')).body.data.accessToken as string;
    const res = await request(app)
      .get('/api/v1/items/by-barcode/9900000000028')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.units.map((u: { name: string }) => u.name)).toEqual(['كرتونة', 'باليت']);
    // لا يكتب الموظف. The auditor cannot write.
    const write = await request(app)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ barcode: 'X1', name: 'x' });
    expect(write.status).toBe(403);
  });
});

describe('tasks layer', () => {
  it('seeds one demo task once; only its assignee and the supervisor see it', async () => {
    const r = await seedDemo(deps());
    await seedDemo(deps());
    const rows = await withTenant(t.db, { companyId: r.companyId }, ({ trx }) =>
      trx.selectFrom('audit_tasks').select(['title', 'status']).execute(),
    );
    expect(rows).toEqual([{ title: DEMO_TASK.title, status: 'draft' }]);
    // لقطة الرصيد تُبذر مرة واحدة. The balance snapshot is seeded exactly once.
    const bal = await withTenant(t.db, { companyId: r.companyId }, ({ trx }) =>
      trx.selectFrom('audit_task_balances').select('item_id').execute(),
    );
    expect(bal).toHaveLength(DEMO_TASK.balances.length);
    const list = async (u: string) => {
      const token = (await login(u)).body.data.accessToken as string;
      const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return res.body.data.length as number;
    };
    expect(await list('demo.auditor1')).toBe(1);
    expect(await list('demo.auditor2')).toBe(0);
    expect(await list('demo.supervisor')).toBe(1);
    expect(await list('demo.admin')).toBe(1);
  });
});

describe('resetDemo', () => {
  it('retires the old demo company and seeds a clean one; old accounts stop working', async () => {
    const before = await seedDemo(deps());
    // ضرر تجريبي: مستخدم إضافي وتغيير كلمة مرور. Experiment damage: an extra user and a changed password.
    await seedLoginUser(t.db, before.companyId, 'scratch', 'another-long-pass-1');
    const r = await resetDemo(deps());
    expect(r.companyId).not.toBe(before.companyId);
    expect(r.createdCompany).toBe(true);
    expect(await countUsers(r.companyId)).toBe(DEMO_ACCOUNTS.length);
    expect((await login('scratch', DEMO_COMPANY_CODE, 'another-long-pass-1')).status).toBe(401);
    expect((await login('demo.admin')).status).toBe(200);
    const old = await withPlatform(t.db, (trx) =>
      trx
        .selectFrom('companies')
        .select(['code', 'deleted_at'])
        .where('id', '=', before.companyId)
        .executeTakeFirstOrThrow(),
    );
    expect(old.deleted_at).not.toBeNull();
    expect(old.code).not.toBe(DEMO_COMPANY_CODE);
  });

  it('leaves a real company untouched', async () => {
    await resetDemo(deps());
    const row = await withPlatform(t.db, (trx) =>
      trx
        .selectFrom('companies')
        .select(['deleted_at', 'is_demo'])
        .where('id', '=', real)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ deleted_at: null, is_demo: false });
    expect((await login('realuser', 'real-co', 'correct-horse-battery-9')).status).toBe(200);
  });
});

describe('privilege boundaries', () => {
  it('the platform role cannot update a non-demo company, nor read users', async () => {
    const upd = await withPlatform(t.db, (trx) =>
      trx
        .updateTable('companies')
        .set({ deleted_at: new Date() })
        .where('id', '=', real)
        .executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    await expect(
      withPlatform(t.db, (trx) => sql`SELECT 1 FROM users`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('a tenant cannot flip its own is_demo flag or change its code', async () => {
    for (const col of ['is_demo', 'code']) {
      await expect(
        withTenant(t.db, { companyId: real }, ({ trx }) =>
          col === 'is_demo'
            ? sql`UPDATE companies SET is_demo = true`.execute(trx)
            : sql`UPDATE companies SET code = 'hijack-1'`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
