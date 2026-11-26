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
];

let managerA: { token: string; id: string };
let emp1: { token: string; id: string };
let emp2: { token: string; id: string };
let adminAu: { token: string; id: string };
let adminBu: { token: string; id: string };
let whMain: string;
let whOther: string;

const warehouse = async (token: string, code: string): Promise<string> => {
  const res = await as(token).post('/warehouses', { code, name: `WH ${code}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const scopeTo = async (companyId: string, userId: string, warehouseId: string): Promise<void> => {
  await withTenant(t.db, { companyId }, async ({ trx }) => {
    await trx
      .insertInto('user_warehouses')
      .values({ user_id: userId, warehouse_id: warehouseId, company_id: companyId })
      .execute();
  });
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
  emp1 = await makeUser(coA, 'task-a', 'emp1', ['inventory.task.read']);
  emp2 = await makeUser(coA, 'task-a', 'emp2', ['inventory.task.read']);

  whMain = await warehouse(adminAu.token, 'MAIN');
  whOther = await warehouse(adminAu.token, 'OTHER');
});
afterAll(async () => {
  await t.cleanup();
});

const csvPost = (token: string, id: string, qs: string, csv: string, type = 'text/csv') =>
  request(app)
    .post(`/api/v1/tasks/${id}/balances${qs}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', type)
    .send(csv);

const item = async (token: string, barcode: string, name = `صنف ${barcode}`): Promise<string> => {
  const res = await as(token).post('/items', { barcode, name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};

let task: Task;
let blind: Task;

describe('balances snapshot', () => {
  beforeAll(async () => {
    for (const b of ['B1', 'B2', 'B3']) await item(adminAu.token, b);
    await item(adminBu.token, 'ONLY-B');
    task = await mk(managerA.token, { assigneeIds: [emp1.id] });
    blind = await mk(managerA.token, { assigneeIds: [emp1.id], blindCount: true });
  });

  it('requires inventory.task.balances to upload; read alone is not enough', async () => {
    const csv = 'barcode,quantity\nB1,5';
    expect((await csvPost(emp1.token, task.id, '', csv)).status).toBe(403);
    expect((await as(emp1.token).get('/tasks/balances/template')).status).toBe(403);
    expect((await csvPost(managerA.token, task.id, '', csv)).status).toBe(200);
    expect((await as(managerA.token).get('/tasks/balances/template')).status).toBe(200);
  });

  it('serves a template that uploads cleanly in preview', async () => {
    const tpl = await as(managerA.token).get('/tasks/balances/template');
    expect(tpl.headers['content-type']).toMatch(/text\/csv/);
    const res = await csvPost(managerA.token, task.id, '?mode=preview', tpl.text);
    // الباركودات النموذجية غير موجودة في هذه الشركة، فتظهر كأخطاء لا كتعطّل. The sample barcodes do not exist here: row errors, not a crash.
    expect(res.status).toBe(200);
    expect(res.body.data.errors.every((e: { code: string }) => e.code === 'ITEM_NOT_FOUND')).toBe(
      true,
    );
  });

  it('preview writes nothing; apply stores the snapshot and records who/when/how many', async () => {
    const csv = 'barcode,quantity\nB1,10\nB2,2.5';
    const pre = await csvPost(managerA.token, task.id, '?mode=preview', csv);
    expect(pre.body.data).toMatchObject({ mode: 'preview', validRows: 2, errorsTotal: 0 });
    expect((await as(managerA.token).get(`/tasks/${task.id}`)).body.data.balancesCount).toBe(0);

    const ap = await csvPost(managerA.token, task.id, '?mode=apply', csv);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const got = (await as(managerA.token).get(`/tasks/${task.id}`)).body.data;
    expect(got.balancesCount).toBe(2);
    expect(got.balancesUploadedAt).toBeTruthy();
    const list = await as(managerA.token).get(`/tasks/${task.id}/balances`);
    expect(
      list.body.data.map((b: { barcode: string; quantity: string }) => [b.barcode, b.quantity]),
    ).toEqual([
      ['B1', '10.000'],
      ['B2', '2.500'],
    ]);
    expect(list.body.meta.total).toBe(2);
  });

  it('a second upload replaces the whole snapshot', async () => {
    await csvPost(managerA.token, task.id, '?mode=apply', 'barcode,quantity\nB3,7');
    const list = await as(managerA.token).get(`/tasks/${task.id}/balances`);
    expect(list.body.data.map((b: { barcode: string }) => b.barcode)).toEqual(['B3']);
    expect((await as(managerA.token).get(`/tasks/${task.id}`)).body.data.balancesCount).toBe(1);
  });

  it('unknown barcodes, bad quantities and duplicates are line errors; nothing is written without skipInvalid', async () => {
    const csv = 'barcode,quantity\nB1,1\nNOPE,2\nB2,-3\nB1,4';
    const before = (await as(managerA.token).get(`/tasks/${task.id}/balances`)).body.meta.total;
    const res = await csvPost(managerA.token, task.id, '?mode=apply', csv);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_INVALID');
    expect(
      res.body.error.details.errors.map((e: { line: number; code: string }) => [e.line, e.code]),
    ).toEqual([
      [3, 'ITEM_NOT_FOUND'],
      [4, 'INVALID_VALUE'],
      [5, 'DUPLICATE_IN_FILE'],
    ]);
    expect((await as(managerA.token).get(`/tasks/${task.id}/balances`)).body.meta.total).toBe(
      before,
    );
  });

  it('skipInvalid keeps the good rows; a file with no good rows is rejected', async () => {
    const ok = await csvPost(
      managerA.token,
      task.id,
      '?mode=apply&skipInvalid=true',
      'barcode,quantity\nB1,1\nNOPE,2',
    );
    expect(ok.body.data).toMatchObject({ validRows: 1, skipped: 1 });
    const none = await csvPost(
      managerA.token,
      task.id,
      '?mode=apply&skipInvalid=true',
      'barcode,quantity\nNOPE,2',
    );
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('IMPORT_EMPTY');
    // اللقطة السابقة سليمة. The previous snapshot is intact.
    expect((await as(managerA.token).get(`/tasks/${task.id}/balances`)).body.data[0].barcode).toBe(
      'B1',
    );
  });

  it('file-level errors, JSON bodies and bad query values', async () => {
    expect((await csvPost(managerA.token, task.id, '', 'barcode\nB1')).body.error.code).toBe(
      'IMPORT_MISSING_COLUMNS',
    );
    expect((await csvPost(managerA.token, task.id, '', 'barcode,quantity\n')).body.error.code).toBe(
      'IMPORT_EMPTY_FILE',
    );
    const json = await request(app)
      .post(`/api/v1/tasks/${task.id}/balances`)
      .set('Authorization', `Bearer ${managerA.token}`)
      .send({ a: 1 });
    expect(json.status).toBe(415);
    expect(
      (await csvPost(managerA.token, task.id, '?mode=x', 'barcode,quantity\nB1,1')).status,
    ).toBe(400);
  });

  it('only a draft accepts a snapshot; after start it is frozen', async () => {
    const t2 = await mk(managerA.token, { assigneeIds: [emp1.id] });
    await csvPost(managerA.token, t2.id, '?mode=apply', 'barcode,quantity\nB1,9');
    const started = await as(managerA.token).post(`/tasks/${t2.id}/start`, { version: 2 });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const res = await csvPost(managerA.token, t2.id, '?mode=apply', 'barcode,quantity\nB1,1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_NOT_EDITABLE');
    const pre = await csvPost(managerA.token, t2.id, '?mode=preview', 'barcode,quantity\nB1,1');
    expect(pre.status).toBe(409);
    expect((await as(managerA.token).get(`/tasks/${t2.id}/balances`)).body.data[0].quantity).toBe(
      '9.000',
    );
  });

  it('the list is searchable and paginated', async () => {
    const t3 = await mk(managerA.token, {});
    const codes = Array.from({ length: 5 }, (_, i) => `PG${i}`);
    for (const c of codes) await item(adminAu.token, c, `منتج ${c}`);
    await csvPost(
      managerA.token,
      t3.id,
      '?mode=apply',
      `barcode,quantity\n${codes.map((c, i) => `${c},${i}`).join('\n')}`,
    );
    const page = await as(managerA.token).get(`/tasks/${t3.id}/balances?pageSize=2&page=3`);
    expect(page.body.data.map((b: { barcode: string }) => b.barcode)).toEqual(['PG4']);
    expect(page.body.meta).toMatchObject({ total: 5, totalPages: 3 });
    const found = await as(managerA.token).get(`/tasks/${t3.id}/balances?q=PG2`);
    expect(found.body.data).toHaveLength(1);
  });
});

describe('blind count and visibility', () => {
  it('an employee on a blind task is refused the balances (403); on a normal task they can read them', async () => {
    await csvPost(managerA.token, blind.id, '?mode=apply', 'barcode,quantity\nB1,5');
    await csvPost(managerA.token, task.id, '?mode=apply', 'barcode,quantity\nB1,5');
    const hidden = await as(emp1.token).get(`/tasks/${blind.id}/balances`);
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.code).toBe('BLIND_COUNT');
    expect((await as(emp1.token).get(`/tasks/${task.id}/balances`)).status).toBe(200);
    // المدير يراها دائماً. The manager always sees them.
    expect((await as(managerA.token).get(`/tasks/${blind.id}/balances`)).status).toBe(200);
  });

  it('a task that is not yours is 404, not 403', async () => {
    expect((await as(emp2.token).get(`/tasks/${task.id}/balances`)).status).toBe(404);
  });

  it('a manager outside the task warehouse cannot upload or read (404)', async () => {
    const scopedMgr = await makeUser(coA, 'task-a', 'scoped-b', ALL_TASK);
    await scopeTo(coA, scopedMgr.id, whOther);
    expect(
      (await csvPost(scopedMgr.token, task.id, '?mode=preview', 'barcode,quantity\nB1,1')).status,
    ).toBe(404);
    expect((await as(scopedMgr.token).get(`/tasks/${task.id}/balances`)).status).toBe(404);
  });
});

describe('company isolation of balances', () => {
  it('another company cannot read or upload, and cannot reference this company items', async () => {
    expect((await as(adminBu.token).get(`/tasks/${task.id}/balances`)).status).toBe(404);
    expect(
      (await csvPost(adminBu.token, task.id, '?mode=apply', 'barcode,quantity\nONLY-B,1')).status,
    ).toBe(404);
    // وفي شركتي لا أستطيع الإشارة لصنف شركة أخرى. And in my own company I cannot reference another company's item.
    const mine = await mk(managerA.token, {});
    const res = await csvPost(
      managerA.token,
      mine.id,
      '?mode=preview',
      'barcode,quantity\nONLY-B,1',
    );
    expect(res.body.data.errors[0]).toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });
});

describe('scale', () => {
  it('uploads 10,000 balances in one request', async () => {
    const co = await seedCompany(t.db, 'Bal Scale', 'bal-scale');
    const adm = await makeUser(co, 'bal-scale', 'admin', null);
    const wh = await warehouse(adm.token, 'W');
    const csvItems = `barcode,name\n${Array.from({ length: 10_000 }, (_, i) => `S${i},صنف ${i}`).join('\n')}`;
    const imp = await request(app)
      .post('/api/v1/items/import?mode=apply')
      .set('Authorization', `Bearer ${adm.token}`)
      .set('Content-Type', 'text/csv')
      .send(csvItems);
    expect(imp.status).toBe(200);
    const tk = await as(adm.token).post('/tasks', { title: 'big', warehouseId: wh });
    const csv = `barcode,quantity\n${Array.from({ length: 10_000 }, (_, i) => `S${i},${i % 50}.5`).join('\n')}`;
    const t0 = Date.now();
    const res = await csvPost(adm.token, tk.body.data.id, '?mode=apply', csv);
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect((await as(adm.token).get(`/tasks/${tk.body.data.id}`)).body.data.balancesCount).toBe(
      10_000,
    );
  }, 120_000);
});
