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
let plainA: string;
let adminC: string;

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
): Promise<string> => {
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
  return login(code, username);
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

type Item = {
  id: string;
  version: number;
  barcode: string;
  units: { name: string; factor: string }[];
} & Record<string, unknown>;
const mk = async (token: string, body: Record<string, unknown>): Promise<Item> => {
  const res = await as(token).post('/items', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  coA = await seedCompany(t.db, 'Items A', 'items-a');
  coB = await seedCompany(t.db, 'Items B', 'items-b');
  adminA = await makeUser(coA, 'items-a', 'admin', null);
  adminB = await makeUser(coB, 'items-b', 'admin', null);
  readerA = await makeUser(coA, 'items-a', 'reader', ['inventory.item.read']);
  plainA = await makeUser(coA, 'items-a', 'plain', []);
  // شركة مستقلة لاختبارات القائمة كي لا تتأثر أعدادها بغيرها.
  // A dedicated company for list tests so their counts are not affected by other tests.
  const coC = await seedCompany(t.db, 'Items C', 'items-c');
  adminC = await makeUser(coC, 'items-c', 'admin', null);
});
afterAll(async () => {
  await t.cleanup();
});

describe('permissions', () => {
  it('no role → 403; read-only → list/get/by-barcode only', async () => {
    const item = await mk(adminA, { barcode: 'PERM-1', name: 'perm' });
    expect((await as(plainA).get('/items')).status).toBe(403);
    expect((await as(plainA).get('/items/by-barcode/PERM-1')).status).toBe(403);
    expect((await as(readerA).get('/items')).status).toBe(200);
    expect((await as(readerA).get(`/items/${item.id}`)).status).toBe(200);
    expect((await as(readerA).get('/items/by-barcode/PERM-1')).status).toBe(200);
    expect((await as(readerA).post('/items', { barcode: 'X', name: 'x' })).status).toBe(403);
    expect((await as(readerA).patch(`/items/${item.id}`, { version: 1, name: 'x' })).status).toBe(
      403,
    );
    expect((await as(readerA).del(`/items/${item.id}`)).status).toBe(403);
  });
});

describe('create / read / update / delete', () => {
  it('stores money and factors as exact decimal strings with units', async () => {
    const item = await mk(adminA, {
      barcode: '6281000000011',
      sku: 'JUICE-1',
      name: 'عصير برتقال',
      price: '19.9900',
      supplier: 'مصنع النور',
      category: 'مشروبات',
      accountNo: '1410',
      tolerancePct: '2.5',
      units: [
        { name: 'كرتونة', factor: '12' },
        { name: 'باليت', factor: '240.500000' },
      ],
    });
    expect(item).toMatchObject({
      barcode: '6281000000011',
      price: '19.99',
      tolerancePct: '2.5',
      baseUnit: 'قطعة',
      active: true,
      version: 1,
      units: [
        { name: 'كرتونة', factor: '12' },
        { name: 'باليت', factor: '240.5' },
      ],
    });
    expect((await as(adminA).get(`/items/${item.id}`)).body.data).toEqual(item);
  });

  it('a decimal that floats would corrupt survives untouched', async () => {
    const item = await mk(adminA, {
      barcode: 'DEC-1',
      name: 'dec',
      price: '0.1',
      units: [{ name: 'box', factor: '3.00001' }],
    });
    expect(item.price).toBe('0.1');
    expect(item.units[0]!.factor).toBe('3.00001');
  });

  it('updates with a version; null clears optionals; units are replaced as a set', async () => {
    const item = await mk(adminA, {
      barcode: 'UPD-1',
      name: 'upd',
      price: '5',
      category: 'c1',
      units: [{ name: 'u1', factor: '2' }],
    });
    const r = await as(adminA).patch(`/items/${item.id}`, {
      version: 1,
      name: 'renamed',
      price: null,
      category: null,
      tolerancePct: '1',
      units: [
        { name: 'u2', factor: '6' },
        { name: 'u3', factor: '10' },
      ],
      active: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'renamed',
      price: null,
      category: null,
      tolerancePct: '1',
      active: false,
      version: 2,
    });
    expect(r.body.data.units.map((u: { name: string }) => u.name)).toEqual(['u2', 'u3']);
    // بدون units تبقى الوحدات كما هي. Without units they are kept.
    const r2 = await as(adminA).patch(`/items/${item.id}`, { version: 2, name: 'again' });
    expect(r2.body.data.units).toHaveLength(2);
    // units فارغة تمسحها. An empty list clears them.
    const r3 = await as(adminA).patch(`/items/${item.id}`, { version: 3, units: [] });
    expect(r3.body.data.units).toEqual([]);
  });

  it('optimistic locking: a stale version → VERSION_CONFLICT with the current version, nothing written', async () => {
    const item = await mk(adminA, { barcode: 'OCC-1', name: 'occ' });
    await as(adminA).patch(`/items/${item.id}`, { version: 1, name: 'b' });
    const stale = await as(adminA).patch(`/items/${item.id}`, {
      version: 1,
      name: 'c',
      units: [{ name: 'x', factor: '2' }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details).toEqual({ currentVersion: 2 });
    const now = (await as(adminA).get(`/items/${item.id}`)).body.data;
    expect(now.name).toBe('b');
    expect(now.units).toEqual([]);
  });

  it('soft-deletes; the barcode is then reusable and the old id is gone', async () => {
    const item = await mk(adminA, { barcode: 'DEL-1', name: 'del' });
    expect((await as(adminA).del(`/items/${item.id}`)).status).toBe(200);
    expect((await as(adminA).get(`/items/${item.id}`)).status).toBe(404);
    expect((await as(adminA).del(`/items/${item.id}`)).status).toBe(404);
    expect((await as(adminA).get('/items/by-barcode/DEL-1')).status).toBe(404);
    const again = await mk(adminA, { barcode: 'DEL-1', name: 'del again' });
    expect(again.id).not.toBe(item.id);
  });

  it('a base unit may not collide with an existing unit name', async () => {
    const item = await mk(adminA, {
      barcode: 'BASE-1',
      name: 'b',
      units: [{ name: 'علبة', factor: '6' }],
    });
    expect(
      (await as(adminA).patch(`/items/${item.id}`, { version: 1, baseUnit: 'علبة' })).status,
    ).toBe(400);
    expect(
      (await as(adminA).patch(`/items/${item.id}`, { version: 1, baseUnit: 'حبة' })).status,
    ).toBe(200);
  });
});

describe('uniqueness and validation', () => {
  it('rejects a duplicate barcode and SKU (SKU case-insensitively); same values are fine in another company', async () => {
    await mk(adminA, { barcode: 'UNQ-1', sku: 'Sku-One', name: 'one' });
    const dupBarcode = await as(adminA).post('/items', { barcode: 'UNQ-1', name: 'two' });
    expect(dupBarcode.status).toBe(409);
    expect(dupBarcode.body.error.code).toBe('BARCODE_TAKEN');
    const dupSku = await as(adminA).post('/items', {
      barcode: 'UNQ-2',
      sku: 'SKU-ONE',
      name: 'two',
    });
    expect(dupSku.body.error.code).toBe('SKU_TAKEN');
    expect((await as(adminA).get('/items/by-barcode/UNQ-2')).status).toBe(404);
    await mk(adminB, { barcode: 'UNQ-1', sku: 'Sku-One', name: 'other company' });
  });

  it('changing the barcode to a taken one is rejected, to a free one works and is searchable', async () => {
    const a = await mk(adminA, { barcode: 'CHG-A', name: 'a' });
    await mk(adminA, { barcode: 'CHG-B', name: 'b' });
    expect(
      (await as(adminA).patch(`/items/${a.id}`, { version: 1, barcode: 'CHG-B' })).body.error.code,
    ).toBe('BARCODE_TAKEN');
    expect(
      (await as(adminA).patch(`/items/${a.id}`, { version: 1, barcode: 'CHG-C' })).status,
    ).toBe(200);
    expect((await as(adminA).get('/items/by-barcode/CHG-C')).body.data.id).toBe(a.id);
    expect((await as(adminA).get('/items/by-barcode/CHG-A')).status).toBe(404);
    expect((await as(adminA).get('/items?q=CHG-C')).body.data.map((i: Item) => i.id)).toEqual([
      a.id,
    ]);
  });

  it('validates strictly (types, ranges, mass assignment) and never answers 5xx', async () => {
    const bad: Record<string, unknown>[] = [
      { barcode: 'has space', name: 'x' },
      { barcode: '', name: 'x' },
      { barcode: 'OK', name: '' },
      { barcode: 'OK', name: 'x', price: 12.5 },
      { barcode: 'OK', name: 'x', price: '-1' },
      { barcode: 'OK', name: 'x', price: '1e3' },
      { barcode: 'OK', name: 'x', tolerancePct: '101' },
      { barcode: 'OK', name: 'x', units: [{ name: 'u', factor: '1' }] },
      {
        barcode: 'OK',
        name: 'x',
        units: [
          { name: 'u', factor: '2' },
          { name: 'U', factor: '3' },
        ],
      },
      { barcode: 'OK', name: 'x', companyId: coB },
      { barcode: 'OK', name: 'x', version: 5 },
      { barcode: 'OK', name: 'x', price: '99999999999999.99999' },
    ];
    for (const body of bad) {
      expect((await as(adminA).post('/items', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await as(adminA).get('/items/not-a-uuid')).status).toBe(404);
    expect((await as(adminA).patch('/items/not-a-uuid', { version: 1, name: 'x' })).status).toBe(
      404,
    );
    expect((await as(adminA).get('/items/by-barcode/' + 'x'.repeat(65))).status).toBe(404);
    expect((await as(adminA).get('/items/by-barcode/%00')).status).toBe(404);
  });
});

describe('by-barcode (scanning)', () => {
  it('matches the whole barcode exactly, not a prefix, and case-sensitively', async () => {
    const item = await mk(adminA, { barcode: 'Scan-ABC-123', name: 'scan me' });
    expect((await as(adminA).get('/items/by-barcode/Scan-ABC-123')).body.data.id).toBe(item.id);
    for (const miss of ['Scan-ABC', 'scan-abc-123', 'Scan-ABC-1234', '%25']) {
      expect((await as(adminA).get(`/items/by-barcode/${miss}`)).status, miss).toBe(404);
    }
  });
});

describe('list', () => {
  beforeAll(async () => {
    await mk(adminC, { barcode: 'L-000', name: 'بلا سعر' });
    const cats = ['مواد غذائية', 'أدوات', 'مشروبات'];
    for (let i = 1; i <= 12; i++) {
      await mk(adminC, {
        barcode: `L-${String(i).padStart(3, '0')}`,
        name: `صنف ${i}`,
        price: String(i * 10),
        category: cats[i % 3],
        supplier: i % 2 ? 'مورد أ' : 'مورد ب',
      });
    }
  });

  it('paginates from the server with a stable order', async () => {
    const p1 = await as(adminC).get('/items?pageSize=5&sort=barcode');
    const p3 = await as(adminC).get('/items?pageSize=5&page=3&sort=barcode');
    expect(p1.body.meta).toMatchObject({ page: 1, pageSize: 5, total: 13, totalPages: 3 });
    expect(p1.body.data.map((i: Item) => i.barcode)).toEqual([
      'L-000',
      'L-001',
      'L-002',
      'L-003',
      'L-004',
    ]);
    expect(p3.body.data.map((i: Item) => i.barcode)).toEqual(['L-010', 'L-011', 'L-012']);
  });

  it('sorts numerically by price, filters by category / supplier / active, and combines filters', async () => {
    const byPrice = await as(adminC).get('/items?sort=price&dir=desc&pageSize=3');
    expect(byPrice.body.data.map((i: Item) => i.price)).toEqual(['120', '110', '100']);
    // الفارغ أخيراً في الاتجاهين. NULLs last both ways.
    const asc = await as(adminC).get('/items?sort=price&dir=asc&pageSize=100');
    expect(asc.body.data[0].price).toBe('10');
    expect(asc.body.data[asc.body.data.length - 1].price).toBeNull();
    const desc = await as(adminC).get('/items?sort=price&dir=desc&pageSize=100');
    expect(desc.body.data[desc.body.data.length - 1].price).toBeNull();
    const cat = await as(adminC).get(
      '/items?category=' + encodeURIComponent('أدوات') + '&pageSize=100',
    );
    expect(cat.body.meta.total).toBe(4);
    const both = await as(adminC).get(
      '/items?category=' +
        encodeURIComponent('أدوات') +
        '&supplier=' +
        encodeURIComponent('مورد أ') +
        '&pageSize=100',
    );
    expect(
      both.body.data.every((i: Item) => i.supplier === 'مورد أ' && i.category === 'أدوات'),
    ).toBe(true);
    expect((await as(adminC).get('/items?active=false')).body.meta.total).toBe(0);
  });

  it('searches barcode, name and category in Arabic-insensitive form; treats % _ and quotes literally', async () => {
    const hit = async (q: string) =>
      (await as(adminC).get(`/items?q=${encodeURIComponent(q)}&pageSize=100`)).body.meta.total;
    expect(await hit('L-007')).toBe(1);
    expect(await hit('صنف 12')).toBe(1);
    expect(await hit('الادوات')).toBe(0); // الأدوات ليست «الادوات» في البيانات (أدوات بلا ال)
    expect(await hit('ادوات')).toBe(4);
    expect(await hit('أَدَوَات')).toBe(4);
    expect(await hit('%')).toBe(0);
    expect(await hit('_')).toBe(0);
    expect(await hit("' OR 1=1 --")).toBe(0);
  });

  it('rejects bad query values with 400', async () => {
    for (const q of ['page=0', 'pageSize=101', 'sort=cost', 'dir=up', 'active=1']) {
      expect((await as(adminC).get(`/items?${q}`)).status, q).toBe(400);
    }
  });
});

describe('tenant isolation', () => {
  it("company A never sees or changes company B's items, including by barcode", async () => {
    const b = await mk(adminB, {
      barcode: 'ISO-B-1',
      name: 'only B',
      units: [{ name: 'box', factor: '4' }],
    });
    expect(JSON.stringify((await as(adminA).get('/items?pageSize=100')).body)).not.toContain(b.id);
    expect((await as(adminA).get('/items?q=only B')).body.data).toEqual([]);
    expect((await as(adminA).get(`/items/${b.id}`)).status).toBe(404);
    expect((await as(adminA).get('/items/by-barcode/ISO-B-1')).status).toBe(404);
    expect(
      (await as(adminA).patch(`/items/${b.id}`, { version: 1, name: 'hijack', units: [] })).status,
    ).toBe(404);
    expect((await as(adminA).del(`/items/${b.id}`)).status).toBe(404);
    const still = (await as(adminB).get(`/items/${b.id}`)).body.data;
    expect(still.name).toBe('only B');
    expect(still.units).toHaveLength(1);
  });

  it('rows carry the caller company and are invisible to another tenant at the database level', async () => {
    const a = await mk(adminA, {
      barcode: 'RLS-1',
      name: 'rls',
      units: [{ name: 'u', factor: '2' }],
    });
    const own = await withTenant(t.db, { companyId: coA }, async ({ trx }) => ({
      item: await trx
        .selectFrom('items')
        .select('company_id')
        .where('id', '=', a.id)
        .executeTakeFirstOrThrow(),
      unit: await trx
        .selectFrom('item_units')
        .select('company_id')
        .where('item_id', '=', a.id)
        .executeTakeFirstOrThrow(),
    }));
    expect(own.item.company_id).toBe(coA);
    expect(own.unit.company_id).toBe(coA);
    const other = await withTenant(t.db, { companyId: coB }, async ({ trx }) => ({
      items: await trx.selectFrom('items').select('id').where('id', '=', a.id).execute(),
      units: await trx.selectFrom('item_units').select('id').where('item_id', '=', a.id).execute(),
    }));
    expect(other).toEqual({ items: [], units: [] });
  });
});
