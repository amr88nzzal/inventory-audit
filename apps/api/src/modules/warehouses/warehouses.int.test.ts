import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@inventory/shared';
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
let adminA: string;
let adminB: string;
let readerA: string;
let scopedA: { token: string; id: string };
let plainA: string;
const userIdOf: Record<string, string> = {};

const login = async (code: string, username: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ companyCode: code, username, password: PASSWORD });
  expect(res.status, `${code}/${username}`).toBe(200);
  return res.body.data.accessToken as string;
};

// يُنشئ مستخدماً بصلاحيات محددة (null = المدير الكامل، [] = بلا دور). Creates a user with given permissions.
const makeUser = async (
  companyId: string,
  code: string,
  username: string,
  perms: Permission[] | null,
): Promise<string> => {
  const id = await seedLoginUser(t.db, companyId, username, PASSWORD);
  userIdOf[`${code}/${username}`] = id;
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
  return login(code, username);
};

const as = (token: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object = {}) =>
    request(app).patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  put: (url: string, body: object = {}) =>
    request(app).put(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string) =>
    request(app).delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
});

const mk = async (
  token: string,
  code: string,
  name: string,
): Promise<{ id: string; version: number }> => {
  const res = await as(token).post('/warehouses', { code, name });
  expect(res.status, `${code}: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.data;
};

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  coA = await seedCompany(t.db, 'Co A', 'co-a');
  coB = await seedCompany(t.db, 'Co B', 'co-b');
  adminA = await makeUser(coA, 'co-a', 'admin', null);
  adminB = await makeUser(coB, 'co-b', 'admin', null);
  readerA = await makeUser(coA, 'co-a', 'reader', ['inventory.warehouse.read']);
  plainA = await makeUser(coA, 'co-a', 'plain', []);
  const scopedToken = await makeUser(coA, 'co-a', 'scoped', [
    'inventory.warehouse.read',
    'inventory.warehouse.update',
    'inventory.warehouse.delete',
    'inventory.warehouse.create',
    'identity.user.assign_warehouse',
  ]);
  scopedA = { token: scopedToken, id: userIdOf['co-a/scoped']! };
});
afterAll(async () => {
  await t.cleanup();
});

describe('permissions', () => {
  it('no role → 403 everywhere; read-only → can list but not write', async () => {
    expect((await as(plainA).get('/warehouses')).status).toBe(403);
    expect((await as(plainA).post('/warehouses', { code: 'X1', name: 'x' })).status).toBe(403);
    expect((await as(readerA).get('/warehouses')).status).toBe(200);
    for (const res of [
      await as(readerA).post('/warehouses', { code: 'X1', name: 'x' }),
      await as(readerA).patch(`/warehouses/${'0'.repeat(8)}-0000-7000-8000-000000000001`, {
        version: 1,
        name: 'x',
      }),
      await as(readerA).del(`/warehouses/${'0'.repeat(8)}-0000-7000-8000-000000000001`),
      await as(readerA).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [] }),
    ]) {
      expect(res.status).toBe(403);
    }
  });
});

describe('warehouses CRUD', () => {
  it('creates, reads, updates with a version, and soft-deletes (code is then reusable)', async () => {
    const w = await mk(adminA, 'MAIN', 'المستودع الرئيسي');
    const got = await as(adminA).get(`/warehouses/${w.id}`);
    expect(got.body.data).toMatchObject({
      code: 'MAIN',
      name: 'المستودع الرئيسي',
      active: true,
      version: 1,
    });

    const upd = await as(adminA).patch(`/warehouses/${w.id}`, {
      version: 1,
      name: 'الرئيسي',
      active: false,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ name: 'الرئيسي', active: false, version: 2 });
    // الرمز غير قابل للتعديل (مفتاح غير معروف = 400). The code is immutable (an unknown key = 400).
    expect(
      (await as(adminA).patch(`/warehouses/${w.id}`, { version: 2, code: 'NEW' })).status,
    ).toBe(400);

    expect((await as(adminA).del(`/warehouses/${w.id}`)).status).toBe(200);
    expect((await as(adminA).get(`/warehouses/${w.id}`)).status).toBe(404);
    const again = await mk(adminA, 'MAIN', 'جديد');
    expect(again.id).not.toBe(w.id);
  });

  it('rejects a duplicate code case-insensitively, but allows the same code in another company', async () => {
    await mk(adminA, 'DUP', 'one');
    const dup = await as(adminA).post('/warehouses', { code: 'dup', name: 'two' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WAREHOUSE_CODE_TAKEN');
    await mk(adminB, 'DUP', 'other company');
  });

  it('optimistic locking: a stale version is rejected with VERSION_CONFLICT and the current version', async () => {
    const w = await mk(adminA, 'OCC', 'occ');
    expect((await as(adminA).patch(`/warehouses/${w.id}`, { version: 1, name: 'b' })).status).toBe(
      200,
    );
    const stale = await as(adminA).patch(`/warehouses/${w.id}`, { version: 1, name: 'c' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details).toEqual({ currentVersion: 2 });
  });

  it('validates input strictly (bad code, unknown keys incl. companyId, empty update)', async () => {
    for (const body of [
      { code: 'has space', name: 'x' },
      { code: '', name: 'x' },
      { code: 'OK1', name: '   ' },
      { code: 'OK1', name: 'x', companyId: coB },
      { code: 'OK1', name: 'x', active: false },
      { code: 'x'.repeat(33), name: 'x' },
    ]) {
      expect((await as(adminA).post('/warehouses', body)).status, JSON.stringify(body)).toBe(400);
    }
    const w = await mk(adminA, 'VAL', 'val');
    expect((await as(adminA).patch(`/warehouses/${w.id}`, { version: 1 })).status).toBe(400);
    expect((await as(adminA).get('/warehouses/not-a-uuid')).status).toBe(404);
  });
});

describe('list: pagination, filter, sort, Arabic search', () => {
  beforeAll(async () => {
    for (let i = 1; i <= 7; i++) await mk(adminB, `P${String(i).padStart(2, '0')}`, `Page wh ${i}`);
    await mk(adminB, 'AR1', 'مستودع الأغذية');
    await mk(adminB, 'AR2', 'مخزن الأدوات');
  });

  it('paginates from the server with meta, a stable order and no overlap', async () => {
    const p1 = await as(adminB).get('/warehouses?pageSize=4&sort=code');
    const p2 = await as(adminB).get('/warehouses?pageSize=4&page=2&sort=code');
    expect(p1.body.meta).toMatchObject({ page: 1, pageSize: 4 });
    expect(p1.body.meta.total).toBeGreaterThanOrEqual(10);
    const ids1 = p1.body.data.map((w: { id: string }) => w.id);
    const ids2 = p2.body.data.map((w: { id: string }) => w.id);
    expect(ids1).toHaveLength(4);
    expect(ids1.filter((i: string) => ids2.includes(i))).toEqual([]);
    const codes = [...p1.body.data, ...p2.body.data].map((w: { code: string }) => w.code);
    expect(codes).toEqual([...codes].sort());
    const desc = await as(adminB).get('/warehouses?sort=code&dir=desc&pageSize=1');
    expect(desc.body.data[0].code >= (codes[codes.length - 1] ?? '')).toBe(true);
  });

  it('searches Arabic without caring about hamza/taa marbuta/diacritics, and treats % _ as literals', async () => {
    const hit = async (q: string) =>
      (await as(adminB).get(`/warehouses?q=${encodeURIComponent(q)}`)).body.data.map(
        (w: { code: string }) => w.code,
      );
    expect(await hit('الاغذيه')).toEqual(['AR1']);
    expect(await hit('الأَغْذِيَة')).toEqual(['AR1']);
    expect(await hit('ar2')).toEqual(['AR2']);
    expect(await hit('%')).toEqual([]);
    expect(await hit('_')).toEqual([]);
    expect(await hit("'; DROP TABLE warehouses;--")).toEqual([]);
    expect((await as(adminB).get('/warehouses')).body.meta.total).toBeGreaterThanOrEqual(9);
  });

  it('filters by active and rejects bad query values (never 5xx)', async () => {
    const w = await mk(adminB, 'OFF1', 'inactive one');
    await as(adminB).patch(`/warehouses/${w.id}`, { version: 1, active: false });
    const off = await as(adminB).get('/warehouses?active=false');
    expect(off.body.data.map((x: { code: string }) => x.code)).toEqual(['OFF1']);
    for (const q of [
      'page=0',
      'pageSize=101',
      'pageSize=abc',
      'sort=password_hash',
      'dir=sideways',
      'active=maybe',
      'q=' + 'x'.repeat(101),
    ]) {
      expect((await as(adminB).get(`/warehouses?${q}`)).status, q).toBe(400);
    }
  });
});

describe('locations', () => {
  it('CRUD inside a warehouse; code unique per warehouse, reusable across warehouses', async () => {
    const w1 = await mk(adminA, 'LOC1', 'with locations');
    const w2 = await mk(adminA, 'LOC2', 'second');
    const l = await as(adminA).post(`/warehouses/${w1.id}/locations`, {
      code: 'A-01',
      name: 'الواجهة 1',
    });
    expect(l.status).toBe(201);
    expect(
      (await as(adminA).post(`/warehouses/${w1.id}/locations`, { code: 'a-01', name: 'dup' })).body
        .error.code,
    ).toBe('LOCATION_CODE_TAKEN');
    expect(
      (
        await as(adminA).post(`/warehouses/${w2.id}/locations`, {
          code: 'A-01',
          name: 'same code elsewhere',
        })
      ).status,
    ).toBe(201);

    const upd = await as(adminA).patch(`/warehouses/${w1.id}/locations/${l.body.data.id}`, {
      version: 1,
      name: 'الواجهة 2',
    });
    expect(upd.body.data).toMatchObject({ name: 'الواجهة 2', version: 2 });
    expect(
      (
        await as(adminA).patch(`/warehouses/${w1.id}/locations/${l.body.data.id}`, {
          version: 1,
          name: 'stale',
        })
      ).status,
    ).toBe(409);
    // موقع من مستودع آخر عبر مسار هذا المستودع = 404. A location through another warehouse's path = 404.
    expect(
      (
        await as(adminA).patch(`/warehouses/${w2.id}/locations/${l.body.data.id}`, {
          version: 2,
          name: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await as(adminA).get(`/warehouses/${w1.id}/locations`)).body.data).toHaveLength(1);
    expect((await as(adminA).del(`/warehouses/${w1.id}/locations/${l.body.data.id}`)).status).toBe(
      200,
    );
    expect((await as(adminA).get(`/warehouses/${w1.id}/locations`)).body.data).toHaveLength(0);
  });

  it('deleting a warehouse also removes its locations', async () => {
    const w = await mk(adminA, 'CASC', 'cascade');
    await as(adminA).post(`/warehouses/${w.id}/locations`, { code: 'L1', name: 'l' });
    await as(adminA).del(`/warehouses/${w.id}`);
    const left = await withTenant(t.db, { companyId: coA }, ({ trx }) =>
      trx
        .selectFrom('locations')
        .select('id')
        .where('warehouse_id', '=', w.id)
        .where('deleted_at', 'is', null)
        .execute(),
    );
    expect(left).toEqual([]);
  });
});

describe('user warehouse scope', () => {
  let w1: string;
  let w2: string;
  let w3: string;
  beforeAll(async () => {
    w1 = (await mk(adminA, 'SC1', 'scope one')).id;
    w2 = (await mk(adminA, 'SC2', 'scope two')).id;
    w3 = (await mk(adminA, 'SC3', 'scope three')).id;
  });

  it('assigning a scope narrows what the user sees; everything else is 404, never 403', async () => {
    const before = await as(scopedA.token).get('/warehouses?pageSize=100');
    expect(before.body.data.map((w: { id: string }) => w.id)).toEqual(
      expect.arrayContaining([w1, w2, w3]),
    );

    const set = await as(adminA).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [w1] });
    expect(set.status).toBe(200);
    expect((await as(adminA).get(`/users/${scopedA.id}/warehouses`)).body.data).toEqual([w1]);

    const list = await as(scopedA.token).get('/warehouses?pageSize=100');
    expect(list.body.data.map((w: { id: string }) => w.id)).toEqual([w1]);
    expect(list.body.meta.total).toBe(1);
    expect((await as(scopedA.token).get(`/warehouses/${w1}`)).status).toBe(200);
    expect((await as(scopedA.token).get(`/warehouses/${w2}`)).status).toBe(404);
    expect(
      (await as(scopedA.token).patch(`/warehouses/${w2}`, { version: 1, name: 'x' })).status,
    ).toBe(404);
    expect((await as(scopedA.token).del(`/warehouses/${w2}`)).status).toBe(404);
    expect((await as(scopedA.token).get(`/warehouses/${w2}/locations`)).status).toBe(404);
    expect(
      (await as(scopedA.token).post(`/warehouses/${w2}/locations`, { code: 'Z', name: 'z' }))
        .status,
    ).toBe(404);
    // البحث لا يكشف ما خارج النطاق. Search never reveals what is out of scope.
    expect(
      (await as(scopedA.token).get('/warehouses?q=scope')).body.data.map(
        (w: { id: string }) => w.id,
      ),
    ).toEqual([w1]);
  });

  it('a scope-restricted user cannot create warehouses nor widen scope (escalation guard)', async () => {
    expect(
      (await as(scopedA.token).post('/warehouses', { code: 'NEWX', name: 'n' })).body.error.code,
    ).toBe('SCOPE_RESTRICTED');
    const widen = await as(scopedA.token).put(`/users/${scopedA.id}/warehouses`, {
      warehouseIds: [w1, w2],
    });
    expect(widen.status).toBe(403);
    expect(
      (await as(scopedA.token).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [] })).status,
    ).toBe(403);
    expect(
      (await as(scopedA.token).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [w1] }))
        .status,
    ).toBe(200);
    expect((await as(adminA).get(`/users/${scopedA.id}/warehouses`)).body.data).toEqual([w1]);
  });

  it('deleting a warehouse drops it from every scope; an empty scope means everything again', async () => {
    await as(adminA).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [w1, w2] });
    await as(adminA).del(`/warehouses/${w2}`);
    expect((await as(adminA).get(`/users/${scopedA.id}/warehouses`)).body.data).toEqual([w1]);
    await as(adminA).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: [] });
    const all = await as(scopedA.token).get('/warehouses?pageSize=100');
    expect(all.body.data.map((w: { id: string }) => w.id)).toEqual(
      expect.arrayContaining([w1, w3]),
    );
  });

  it('rejects unknown, duplicate, deleted and foreign-company warehouses and unknown users', async () => {
    const foreign = (await as(adminB).get('/warehouses')).body.data[0].id;
    for (const ids of [[foreign], [w1, w1], [w2], ['00000000-0000-7000-8000-00000000dead']]) {
      const res = await as(adminA).put(`/users/${scopedA.id}/warehouses`, { warehouseIds: ids });
      expect([400, 404], JSON.stringify(ids)).toContain(res.status);
    }
    expect(
      (await as(adminA).put(`/users/${userIdOf['co-b/admin']}/warehouses`, { warehouseIds: [] }))
        .status,
    ).toBe(404);
    expect((await as(adminA).get(`/users/${userIdOf['co-b/admin']}/warehouses`)).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("company A never sees or touches company B's warehouses and locations", async () => {
    const b = await mk(adminB, 'ISO-B', 'only in B');
    const loc = await as(adminB).post(`/warehouses/${b.id}/locations`, { code: 'BL', name: 'bl' });
    const list = await as(adminA).get('/warehouses?pageSize=100');
    expect(JSON.stringify(list.body)).not.toContain(b.id);
    expect((await as(adminA).get('/warehouses?q=only in B')).body.data).toEqual([]);
    expect((await as(adminA).get(`/warehouses/${b.id}`)).status).toBe(404);
    expect(
      (await as(adminA).patch(`/warehouses/${b.id}`, { version: 1, name: 'hijack' })).status,
    ).toBe(404);
    expect((await as(adminA).del(`/warehouses/${b.id}`)).status).toBe(404);
    expect((await as(adminA).get(`/warehouses/${b.id}/locations`)).status).toBe(404);
    expect(
      (await as(adminA).post(`/warehouses/${b.id}/locations`, { code: 'X', name: 'x' })).status,
    ).toBe(404);
    expect(
      (
        await as(adminA).patch(`/warehouses/${b.id}/locations/${loc.body.data.id}`, {
          version: 1,
          name: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await as(adminB).get(`/warehouses/${b.id}`)).body.data.name).toBe('only in B');
  });

  it('a created row always belongs to the caller company (RLS check even if the app were wrong)', async () => {
    const w = await mk(adminA, 'OWN', 'own');
    const row = await withTenant(t.db, { companyId: coA }, ({ trx }) =>
      trx
        .selectFrom('warehouses')
        .select('company_id')
        .where('id', '=', w.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.company_id).toBe(coA);
    const invisible = await withTenant(t.db, { companyId: coB }, ({ trx }) =>
      trx.selectFrom('warehouses').select('id').where('id', '=', w.id).execute(),
    );
    expect(invisible).toEqual([]);
  });
});
