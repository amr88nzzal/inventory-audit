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

const ALL_TASK: Permission[] = [
  'inventory.warehouse.read',
  'inventory.warehouse.create',
  'inventory.task.read',
  'inventory.task.read_all',
  'inventory.task.create',
  'inventory.task.update',
  'inventory.task.start',
  'inventory.task.cancel',
  'inventory.task.balances',
  'inventory.task.scan',
];

let managerA: { token: string; id: string };
let emp1: { token: string; id: string };
let adminAu: { token: string; id: string };
let adminBu: { token: string; id: string };
let whMain: string;
let whOther: string;

const warehouse = async (token: string, code: string): Promise<string> => {
  const res = await as(token).post('/warehouses', { code, name: `WH ${code}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
type Task = {
  id: string;
  taskNo: number;
  version: number;
  status: string;
  assignees: { userId: string }[];
} & Record<string, unknown>;
const mk = async (token: string, body: Record<string, unknown>): Promise<Task> => {
  const res = await as(token).post('/tasks', { title: 'جرد', warehouseId: whMain, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config: testConfig() });
  coA = await seedCompany(t.db, 'Task A', 'task-a');
  coB = await seedCompany(t.db, 'Task B', 'task-b');
  adminAu = await makeUser(coA, 'task-a', 'admin', null);
  adminBu = await makeUser(coB, 'task-b', 'admin', null);
  managerA = await makeUser(coA, 'task-a', 'manager', ALL_TASK);
  emp1 = await makeUser(coA, 'task-a', 'emp1', ['inventory.task.read', 'inventory.task.scan']);

  whMain = await warehouse(adminAu.token, 'MAIN');
  whOther = await warehouse(adminAu.token, 'OTHER');
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = '2026-11-27T10:00:00+03:00';
let seq = 5000;
const eid = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
const count = (barcode: string, quantity: string, extra: Record<string, unknown> = {}) => ({
  id: eid(),
  kind: 'count',
  barcode,
  quantity,
  scannedAt: NOW,
  ...extra,
});
const send = (token: string, taskId: string, events: object[]) =>
  as(token).post(`/tasks/${taskId}/scans`, { events });
const item = async (token: string, barcode: string, body: object = {}): Promise<string> => {
  const res = await as(token).post('/items', { barcode, name: `صنف ${barcode}`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const csvPost = (token: string, id: string, csv: string) =>
  request(app)
    .post(`/api/v1/tasks/${id}/balances?mode=apply`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'text/csv')
    .send(csv);
// مهمة قيد التنفيذ بلقطة رصيد. A running task with a balance snapshot.
const running = async (csv: string, extra: Record<string, unknown> = {}): Promise<Task> => {
  const tk = await mk(managerA.token, { assigneeIds: [emp1.id], ...extra });
  if (csv) expect((await csvPost(managerA.token, tk.id, csv)).status).toBe(200);
  // رفع اللقطة يرفع النسخة، فنقرأها من جديد. Uploading the snapshot bumps the version, so re-read it.
  const fresh = (await as(managerA.token).get(`/tasks/${tk.id}`)).body.data as Task;
  const st = await as(managerA.token).post(`/tasks/${tk.id}/start`, { version: fresh.version });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return st.body.data;
};
type Row = {
  barcode: string;
  counted: string;
  theoretical: string;
  difference: string;
  differencePct: string | null;
  status: string;
  flaggedForRecount: boolean;
  appliedTolerancePct: string;
  locations?: { locationId: string | null; counted: string }[];
};
const byBarcode = (rows: Row[], b: string): Row => rows.find((r) => r.barcode === b) as Row;

let unitCarton: string;
let locA: string;
let locB: string;

describe('task results (variance)', () => {
  beforeAll(async () => {
    await item(adminAu.token, 'R-A', { tolerancePct: '2' });
    await item(adminAu.token, 'R-B');
    await item(adminAu.token, 'R-C');
    await item(adminAu.token, 'R-BOX', { units: [{ name: 'كرتون', factor: '12' }] });
    unitCarton = await withTenant(
      t.db,
      { companyId: coA },
      async ({ trx }) =>
        (
          await trx
            .selectFrom('item_units')
            .select('id')
            .where('name', '=', 'كرتون')
            .executeTakeFirstOrThrow()
        ).id,
    );
    locA = (
      await as(adminAu.token).post(`/warehouses/${whMain}/locations`, { code: 'R1', name: 'ر1' })
    ).body.data.id;
    locB = (
      await as(adminAu.token).post(`/warehouses/${whMain}/locations`, { code: 'R2', name: 'ر2' })
    ).body.data.id;
  });

  it('computes per-item variance, unit conversion, voids, tolerance and unknown barcodes', async () => {
    const tk = await running('barcode,quantity\nR-A,100\nR-B,50\nR-C,10\nR-BOX,36\n');
    const voided = count('R-B', '99');
    await send(emp1.token, tk.id, [
      count('R-A', '60', { locationId: locA }),
      count('R-A', '39', { locationId: locB }), // 99 of 100 = -1% within item tolerance 2%
      count('R-B', '45'), // -10%
      voided,
      count('R-BOX', '3', { unitId: unitCarton }), // 36 = match
      count('GHOST', '4'),
      count('GHOST', '1'),
    ]);
    await send(emp1.token, tk.id, [
      { id: eid(), kind: 'void', voidsId: voided.id, scannedAt: NOW },
    ]);

    const res = await as(managerA.token).get(`/tasks/${tk.id}/results`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.data as Row[];
    expect(byBarcode(rows, 'R-A')).toMatchObject({
      counted: '99',
      theoretical: '100',
      difference: '-1',
      differencePct: '-1',
      appliedTolerancePct: '2',
      flaggedForRecount: false,
    });
    expect(byBarcode(rows, 'R-B')).toMatchObject({
      counted: '45',
      difference: '-5',
      differencePct: '-10',
      status: 'short',
      flaggedForRecount: true,
    });
    // C لم يُعدّ: نقص كامل. C never counted: a full shortage.
    expect(byBarcode(rows, 'R-C')).toMatchObject({
      counted: '0',
      difference: '-10',
      status: 'short',
    });
    expect(byBarcode(rows, 'R-BOX')).toMatchObject({
      counted: '36',
      status: 'match',
      flaggedForRecount: false,
    });
    expect(rows.find((r) => r.barcode === 'GHOST')).toBeUndefined();
    expect(res.body.meta.summary).toMatchObject({
      items: 4,
      matched: 1,
      short: 3,
      flagged: 2,
      unknownBarcodes: 1,
      unknownQuantity: '5',
    });
    // الأكبر فرقاً أولاً. Largest absolute difference first.
    expect(rows[0]!.barcode).toBe('R-C');
    const unk = await as(managerA.token).get(`/tasks/${tk.id}/results/unknown`);
    expect(unk.body.data).toEqual([{ barcode: 'GHOST', quantity: '5', records: 2 }]);
  });

  it('an item outside the snapshot has theoretical 0 and is flagged', async () => {
    const tk = await running('barcode,quantity\nR-A,10\n');
    await send(emp1.token, tk.id, [count('R-C', '2')]);
    const rows = (await as(managerA.token).get(`/tasks/${tk.id}/results`)).body.data as Row[];
    expect(byBarcode(rows, 'R-C')).toMatchObject({
      theoretical: '0',
      counted: '2',
      differencePct: null,
      status: 'over',
      flaggedForRecount: true,
    });
  });

  it('default tolerance query lifts the flag; invalid values are rejected', async () => {
    const tk = await running('barcode,quantity\nR-B,100\n');
    await send(emp1.token, tk.id, [count('R-B', '97')]);
    const get = (qs: string) => as(managerA.token).get(`/tasks/${tk.id}/results${qs}`);
    expect(byBarcode((await get('')).body.data, 'R-B').flaggedForRecount).toBe(true);
    expect(byBarcode((await get('?tolerancePct=3')).body.data, 'R-B').flaggedForRecount).toBe(
      false,
    );
    expect(byBarcode((await get('?tolerancePct=2.99')).body.data, 'R-B').flaggedForRecount).toBe(
      true,
    );
    for (const bad of ['-1', 'abc', '1e2'])
      expect((await get(`?tolerancePct=${bad}`)).status, bad).toBe(400);
  });

  it('shows a per-location breakdown only when aggregateLocations is off', async () => {
    const off = await running('barcode,quantity\nR-A,10\n', { aggregateLocations: false });
    await send(emp1.token, off.id, [
      count('R-A', '3', { locationId: locA }),
      count('R-A', '4', { locationId: locB }),
      count('R-A', '1'),
    ]);
    const a = byBarcode(
      (await as(managerA.token).get(`/tasks/${off.id}/results`)).body.data,
      'R-A',
    );
    expect(a.counted).toBe('8');
    expect(a.locations).toHaveLength(3);
    const on = await running('barcode,quantity\nR-A,10\n');
    await send(emp1.token, on.id, [count('R-A', '3', { locationId: locA })]);
    expect(
      byBarcode((await as(managerA.token).get(`/tasks/${on.id}/results`)).body.data, 'R-A'),
    ).not.toHaveProperty('locations');
  });

  it('filters, searches, sorts and paginates on the server', async () => {
    const tk = await running('barcode,quantity\nR-A,10\nR-B,10\nR-C,10\n');
    await send(emp1.token, tk.id, [count('R-A', '10'), count('R-B', '12'), count('R-C', '7')]);
    const get = (qs: string) => as(managerA.token).get(`/tasks/${tk.id}/results${qs}`);
    const f = async (qs: string) => ((await get(qs)).body.data as Row[]).map((r) => r.barcode);
    expect(await f('?filter=match')).toEqual(['R-A']);
    expect(await f('?filter=over')).toEqual(['R-B']);
    expect(await f('?filter=short')).toEqual(['R-C']);
    expect(await f('?filter=flagged')).toEqual(['R-C', 'R-B']);
    expect(await f('?sort=barcode')).toEqual(['R-A', 'R-B', 'R-C']);
    expect(await f('?q=R-B')).toEqual(['R-B']);
    const p = await get('?sort=barcode&pageSize=2&page=2');
    expect(p.body.data).toHaveLength(1);
    expect(p.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    // الإجماليات لا تتأثر بالفلتر. Totals ignore the filter.
    expect((await get('?filter=match')).body.meta.summary.items).toBe(3);
  });

  it('is supervisor-only: read_all is required, blind-count or not', async () => {
    const tk = await running('barcode,quantity\nR-A,10\n', { blindCount: true });
    await send(emp1.token, tk.id, [count('R-A', '10')]);
    for (const path of [`/tasks/${tk.id}/results`, `/tasks/${tk.id}/results/unknown`]) {
      expect((await as(emp1.token).get(path)).status, path).toBe(403);
      expect((await as(managerA.token).get(path)).status, path).toBe(200);
      expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
    }
    expect((await as(managerA.token).get('/tasks/not-a-uuid/results')).status).toBe(404);
  });

  it('is empty for a task with nothing counted and no snapshot', async () => {
    const tk = await running('');
    const res = await as(managerA.token).get(`/tasks/${tk.id}/results`);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.summary).toMatchObject({
      items: 0,
      totalCounted: '0',
      unknownBarcodes: 0,
    });
  });

  it('respects warehouse scope and company isolation (404)', async () => {
    const tk = await running('barcode,quantity\nR-A,10\n');
    expect((await as(adminBu.token).get(`/tasks/${tk.id}/results`)).status).toBe(404);
    expect((await as(adminBu.token).get(`/tasks/${tk.id}/results/unknown`)).status).toBe(404);
    const scoped = await makeUser(coA, 'task-a', 'scoped-r', [
      'inventory.task.read',
      'inventory.task.read_all',
    ]);
    await withTenant(t.db, { companyId: coA }, async ({ trx }) => {
      await trx
        .insertInto('user_warehouses')
        .values({ user_id: scoped.id, warehouse_id: whOther, company_id: coA })
        .execute();
    });
    expect((await as(scoped.token).get(`/tasks/${tk.id}/results`)).status).toBe(404);
  });
});
