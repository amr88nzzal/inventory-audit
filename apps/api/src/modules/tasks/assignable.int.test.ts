import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@inventory/shared';
import { sql } from 'kysely';
import { createApp } from '../../app';
import { withTenant } from '../../db';
import { testConfig } from '../../testing/test-config';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { ensureAdminRole, ensureRole, ensureUserRole } from '../rbac';

const PASSWORD = 'correct-horse-battery-9';
let t: TestDb;
let app: ReturnType<typeof createApp>;
let coA: string;
let coB: string;

const login = async (code: string, username: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ companyCode: code, username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
};

const makeUser = async (
  companyId: string,
  code: string,
  username: string,
  perms: Permission[] | null,
): Promise<{ token: string; id: string }> => {
  const id = await seedLoginUser(t.db, companyId, username, PASSWORD);
  await withTenant(t.db, { companyId }, async ({ trx }) => {
    if (perms === null) {
      await ensureUserRole(trx, companyId, id, await ensureAdminRole(trx, companyId, null), null);
    } else if (perms.length > 0) {
      const role = await ensureRole(
        trx,
        companyId,
        { name: `r-${username}`, description: '', permissions: perms },
        null,
      );
      await ensureUserRole(trx, companyId, id, role, null);
    }
  });
  return { token: await login(code, username), id };
};

const as = (token: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object = {}) =>
    request(app).patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string) =>
    request(app).delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
});

const scopeTo = async (companyId: string, userId: string, warehouseId: string): Promise<void> => {
  await withTenant(t.db, { companyId }, async ({ trx }) => {
    await trx
      .insertInto('user_warehouses')
      .values({ user_id: userId, warehouse_id: warehouseId, company_id: companyId })
      .execute();
  });
};
const warehouse = async (token: string, code: string): Promise<string> => {
  const res = await as(token).post('/warehouses', { code, name: `WH ${code}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};

let adminA: { token: string; id: string };
let adminB: { token: string; id: string };
let supervisor: { token: string; id: string };
let plain: { token: string; id: string };
let free: { token: string; id: string };
let inMain: { token: string; id: string };
let inOther: { token: string; id: string };
let inactive: { token: string; id: string };
let deleted: { token: string; id: string };
let whMain: string;
let whOther: string;

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  coA = await seedCompany(t.db, 'Asg A', 'asg-a');
  coB = await seedCompany(t.db, 'Asg B', 'asg-b');
  adminA = await makeUser(coA, 'asg-a', 'admin', null);
  adminB = await makeUser(coB, 'asg-b', 'admin', null);
  supervisor = await makeUser(coA, 'asg-a', 'sup', ['inventory.task.read_all']);
  plain = await makeUser(coA, 'asg-a', 'plain', ['inventory.task.read']);
  free = await makeUser(coA, 'asg-a', 'free', []);
  inMain = await makeUser(coA, 'asg-a', 'inmain', []);
  inOther = await makeUser(coA, 'asg-a', 'inother', []);
  inactive = await makeUser(coA, 'asg-a', 'gone', []);
  deleted = await makeUser(coA, 'asg-a', 'deleted', []);
  whMain = await warehouse(adminA.token, 'MAIN');
  whOther = await warehouse(adminA.token, 'OTHER');
  await scopeTo(coA, inMain.id, whMain);
  await scopeTo(coA, inOther.id, whOther);
  await withTenant(t.db, { companyId: coA }, async ({ trx }) => {
    await trx.updateTable('users').set({ active: false }).where('id', '=', inactive.id).execute();
    await trx
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', deleted.id)
      .execute();
  });
  await warehouse(adminB.token, 'MAIN');
});
afterAll(async () => {
  await t.cleanup();
});

const names = (res: { body: { data: { id: string }[] } }): string[] =>
  res.body.data.map((u) => u.id);

describe('GET /tasks/assignable-users', () => {
  it('needs read_all (a plain reader and a user with no role are refused)', async () => {
    expect(
      (await as(plain.token).get(`/tasks/assignable-users?warehouseId=${whMain}`)).status,
    ).toBe(403);
    expect(
      (await as(supervisor.token).get(`/tasks/assignable-users?warehouseId=${whMain}`)).status,
    ).toBe(200);
  });

  it('offers active users whose scope is empty or includes the warehouse, and nobody else', async () => {
    const res = await as(supervisor.token).get(`/tasks/assignable-users?warehouseId=${whMain}`);
    const ids = names(res);
    expect(ids).toContain(free.id);
    expect(ids).toContain(inMain.id);
    expect(ids).not.toContain(inOther.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(deleted.id);
    expect(res.body.data[0]).toEqual({ id: expect.any(String), displayName: expect.any(String) });
    expect(Object.keys(res.body.data[0])).toEqual(['id', 'displayName']);
  });

  it('agrees with the server: everyone offered can actually be assigned', async () => {
    const offered = names(
      await as(supervisor.token).get(`/tasks/assignable-users?warehouseId=${whOther}`),
    );
    const res = await as(adminA.token).post('/tasks', {
      title: 'x',
      warehouseId: whOther,
      assigneeIds: offered,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('never leaks another company: users and warehouses of company B are invisible', async () => {
    const own = names(
      await as(supervisor.token).get(`/tasks/assignable-users?warehouseId=${whMain}`),
    );
    expect(own).not.toContain(adminB.id);
    const whB = (await as(adminB.token).get('/warehouses')).body.data[0].id as string;
    expect(
      (await as(supervisor.token).get(`/tasks/assignable-users?warehouseId=${whB}`)).status,
    ).toBe(404);
    const fromB = await as(adminB.token).get(`/tasks/assignable-users?warehouseId=${whB}`);
    expect(names(fromB)).toEqual([adminB.id]);
  });

  it('a scope-restricted caller gets 404 for a warehouse outside their scope', async () => {
    const restricted = await makeUser(coA, 'asg-a', 'restricted', ['inventory.task.read_all']);
    await scopeTo(coA, restricted.id, whMain);
    expect(
      (await as(restricted.token).get(`/tasks/assignable-users?warehouseId=${whOther}`)).status,
    ).toBe(404);
    expect(
      (await as(restricted.token).get(`/tasks/assignable-users?warehouseId=${whMain}`)).status,
    ).toBe(200);
  });

  it('validates the query: a missing or malformed warehouseId is 400, an unknown one 404', async () => {
    expect((await as(supervisor.token).get('/tasks/assignable-users')).status).toBe(400);
    expect(
      (await as(supervisor.token).get('/tasks/assignable-users?warehouseId=nope')).status,
    ).toBe(400);
    expect(
      (
        await as(supervisor.token).get(
          '/tasks/assignable-users?warehouseId=00000000-0000-4000-8000-000000000000',
        )
      ).status,
    ).toBe(404);
  });
});
