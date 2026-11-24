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
let importerA: string;

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

const csvPost = (token: string, qs: string, csv: string, type = 'text/csv') =>
  request(app)
    .post(`/api/v1/items/import${qs}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', type)
    .send(csv);

const count = (company: string): Promise<number> =>
  withTenant(t.db, { companyId: company }, async ({ trx }) =>
    Number(
      (
        await trx
          .selectFrom('items')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).n,
    ),
  );

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  coA = await seedCompany(t.db, 'Imp A', 'imp-a');
  coB = await seedCompany(t.db, 'Imp B', 'imp-b');
  adminA = await makeUser(coA, 'imp-a', 'admin', null);
  adminB = await makeUser(coB, 'imp-b', 'admin', null);
  readerA = await makeUser(coA, 'imp-a', 'reader', [
    'inventory.item.read',
    'inventory.item.create',
  ]);
  importerA = await makeUser(coA, 'imp-a', 'importer', ['inventory.item.import']);
});
afterAll(async () => {
  await t.cleanup();
});

describe('permissions', () => {
  it('requires inventory.item.import (create/read are not enough)', async () => {
    const csv = 'barcode,name\nP1,x';
    expect((await csvPost(readerA, '', csv)).status).toBe(403);
    expect((await as(readerA).get('/items/import/template')).status).toBe(403);
    expect((await csvPost(importerA, '', csv)).status).toBe(200);
    expect((await as(importerA).get('/items/import/template')).status).toBe(200);
  });

  it('serves the template as CSV that itself imports cleanly', async () => {
    const res = await as(adminA).get('/items/import/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const again = await csvPost(adminA, '?mode=preview', res.text);
    expect(again.body.data.errorsTotal).toBe(0);
  });
});

describe('preview and apply', () => {
  it('preview writes nothing; apply creates; the same file again changes nothing', async () => {
    const csv = 'barcode,name,price,category\nA1,Tea,1.50,Drinks\nA2,Coffee,2,Drinks';
    const before = await count(coA);
    const pre = await csvPost(adminA, '?mode=preview', csv);
    expect(pre.status).toBe(200);
    expect(pre.body.data).toMatchObject({ mode: 'preview', created: 2, updated: 0 });
    expect(await count(coA)).toBe(before);

    const ap = await csvPost(adminA, '?mode=apply', csv);
    expect(ap.body.data).toMatchObject({ mode: 'apply', created: 2, updated: 0, unchanged: 0 });
    expect(await count(coA)).toBe(before + 2);

    const again = await csvPost(adminA, '?mode=apply', csv);
    expect(again.body.data).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await count(coA)).toBe(before + 2);
  });

  it('defaults to preview when mode is omitted', async () => {
    const res = await csvPost(adminA, '', 'barcode,name\nDEF1,x');
    expect(res.body.data.mode).toBe('preview');
    expect((await as(adminA).get('/items/by-barcode/DEF1')).status).toBe(404);
  });

  it('updates by barcode: blank keeps the value, version increases, search follows', async () => {
    await csvPost(adminA, '?mode=apply', 'barcode,name,price,supplier\nU1,Old name,5,Acme');
    const first = (await as(adminA).get('/items/by-barcode/U1')).body.data;
    const up = await csvPost(
      adminA,
      '?mode=apply',
      'barcode,name,price,supplier,category\nU1,New name,,,زيوت',
    );
    expect(up.body.data).toMatchObject({ created: 0, updated: 1 });
    const after = (await as(adminA).get('/items/by-barcode/U1')).body.data;
    expect(after).toMatchObject({ id: first.id, name: 'New name', price: '5', supplier: 'Acme' });
    expect(after.category).toBe('زيوت');
    expect(after.version).toBe(first.version + 1);
    const found = await as(adminA).get('/items?q=زيوت');
    expect(found.body.data.map((i: Item) => i.barcode)).toContain('U1');
  });

  it('accepts Arabic headers, Arabic digits, semicolons and a BOM', async () => {
    const csv = '﻿الباركود;الاسم;السعر\nAR1;صنف عربي;١٢٫٥';
    const res = await csvPost(adminA, '?mode=apply', csv);
    expect(res.body.data.created).toBe(1);
    expect((await as(adminA).get('/items/by-barcode/AR1')).body.data.price).toBe('12.5');
  });

  it('ignores a companyId column (mass assignment) and reports it as ignored', async () => {
    const res = await csvPost(adminA, '?mode=apply', `barcode,name,companyId\nMA1,x,${coB}`);
    expect(res.body.data.ignoredColumns).toEqual(['companyId']);
    expect((await as(adminA).get('/items/by-barcode/MA1')).status).toBe(200);
    expect((await as(adminB).get('/items/by-barcode/MA1')).status).toBe(404);
  });
});

describe('invalid rows', () => {
  it('apply without skipInvalid → 422 with a line-numbered report and nothing written', async () => {
    const before = await count(coA);
    const res = await csvPost(
      adminA,
      '?mode=apply',
      'barcode,name,price\nV1,ok,1\nV2,bad,abc\nV3,,1',
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_INVALID');
    expect(res.body.error.details.errors.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect(await count(coA)).toBe(before);
  });

  it('skipInvalid writes the valid rows and counts the skipped ones', async () => {
    const res = await csvPost(
      adminA,
      '?mode=apply&skipInvalid=true',
      'barcode,name,price\nS1,ok,1\nS2,bad,abc',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 1, skipped: 1, errorsTotal: 1 });
    expect((await as(adminA).get('/items/by-barcode/S1')).status).toBe(200);
    expect((await as(adminA).get('/items/by-barcode/S2')).status).toBe(404);
  });

  it('a code that belongs to another item is a row error, not a crash', async () => {
    await csvPost(adminA, '?mode=apply', 'barcode,name,sku\nK1,one,CODE-1');
    const res = await csvPost(adminA, '?mode=preview', 'barcode,name,sku\nK2,two,code-1');
    expect(res.body.data.errors).toEqual([
      expect.objectContaining({ line: 2, field: 'sku', code: 'SKU_TAKEN' }),
    ]);
    // وللصنف نفسه لا خطأ. For the item's own code there is no error.
    const own = await csvPost(adminA, '?mode=preview', 'barcode,name,sku\nK1,one,CODE-1');
    expect(own.body.data.errorsTotal).toBe(0);
  });

  it('a new base unit that repeats an existing extra unit is a row error', async () => {
    await mk(adminA, {
      barcode: 'BU1',
      name: 'bu',
      units: [{ name: 'كرتون', factor: '12' }],
    });
    const res = await csvPost(adminA, '?mode=preview', 'barcode,name,unit\nBU1,bu,كرتون');
    expect(res.body.data.errors[0]).toMatchObject({ code: 'BASE_UNIT_CONFLICT', line: 2 });
  });

  it('caps the error list at 200 but reports the true total', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `E${i},n,bad`).join('\n');
    const res = await csvPost(adminA, '?mode=preview', `barcode,name,price\n${lines}`);
    expect(res.body.data).toMatchObject({ errorsTotal: 250, errorsTruncated: true });
    expect(res.body.data.errors).toHaveLength(200);
  });
});

describe('file-level errors', () => {
  it('maps them to 422 with a code', async () => {
    const miss = await csvPost(adminA, '', 'barcode,price\n1,2');
    expect(miss.status).toBe(422);
    expect(miss.body.error).toMatchObject({ code: 'IMPORT_MISSING_COLUMNS' });
    expect(miss.body.error.details.missing).toEqual(['name']);
    expect((await csvPost(adminA, '', 'barcode,name\n')).body.error.code).toBe('IMPORT_EMPTY_FILE');
    expect((await csvPost(adminA, '', 'barcode,name\n"1,2')).body.error.code).toBe(
      'IMPORT_BAD_CSV',
    );
  });

  it('rejects JSON bodies (415), unknown query values (400) and oversized bodies (413)', async () => {
    const json = await request(app)
      .post('/api/v1/items/import')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ barcode: '1' });
    expect(json.status).toBe(415);
    expect((await csvPost(adminA, '?mode=nope', 'barcode,name\n1,2')).status).toBe(400);
    const huge = 'barcode,name\n' + 'x'.repeat(11 * 1024 * 1024);
    expect((await csvPost(adminA, '', huge)).status).toBe(413);
  });
});

describe('company isolation', () => {
  it('the same barcodes in two companies stay separate', async () => {
    await csvPost(adminA, '?mode=apply', 'barcode,name,price\nISO1,A side,1');
    const b = await csvPost(adminB, '?mode=apply', 'barcode,name,price\nISO1,B side,9');
    expect(b.body.data).toMatchObject({ created: 1, updated: 0 });
    expect((await as(adminA).get('/items/by-barcode/ISO1')).body.data).toMatchObject({
      name: 'A side',
      price: '1',
    });
    expect((await as(adminB).get('/items/by-barcode/ISO1')).body.data).toMatchObject({
      name: 'B side',
      price: '9',
    });
  });

  it('preview in one company never sees the other company’s items or codes', async () => {
    await csvPost(adminB, '?mode=apply', 'barcode,name,sku\nONLYB,b,SKU-B');
    const res = await csvPost(adminA, '?mode=preview', 'barcode,name,sku\nONLYB,a,SKU-B');
    expect(res.body.data).toMatchObject({ created: 1, updated: 0, errorsTotal: 0 });
  });
});

describe('scale', () => {
  it('imports 10,000 rows in one request, then re-imports them as unchanged', async () => {
    const rows = Array.from(
      { length: 10_000 },
      (_, i) => `BULK${i},صنف ${i},${(i % 100) + 0.25},فئة ${i % 7}`,
    );
    const csv = `barcode,name,price,category\n${rows.join('\n')}`;
    const t0 = Date.now();
    const res = await csvPost(adminA, '?mode=apply', csv);
    const ms = Date.now() - t0;
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.body.data).toMatchObject({ created: 10_000, errorsTotal: 0 });
    expect(ms).toBeLessThan(30_000);
    const again = await csvPost(adminA, '?mode=apply', csv);
    expect(again.body.data).toMatchObject({ created: 0, updated: 0, unchanged: 10_000 });
  }, 90_000);
});
