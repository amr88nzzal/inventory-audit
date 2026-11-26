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
  'inventory.task.close',
  'inventory.task.recount',
];

let managerA: { token: string; id: string };
let emp1: { token: string; id: string };
let emp2: { token: string; id: string };
let outsider: { token: string; id: string };
let adminAu: { token: string; id: string };
let adminBu: { token: string; id: string };
let whMain: string;

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
  emp2 = await makeUser(coA, 'task-a', 'emp2', ['inventory.task.read', 'inventory.task.scan']);
  outsider = await makeUser(coA, 'task-a', 'outsider', [
    'inventory.task.read',
    'inventory.task.scan',
  ]);

  whMain = await warehouse(adminAu.token, 'MAIN');
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = '2026-11-27T10:00:00+03:00';
let seq = 20000;
const eid = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
let keySeq = 0;
const ikey = (): string => `recount-key-${Date.now()}-${++keySeq}`;
const count = (barcode: string, quantity: string) => ({
  id: eid(),
  kind: 'count',
  barcode,
  quantity,
  scannedAt: NOW,
});
const send = (token: string, taskId: string, events: object[]) =>
  as(token).post(`/tasks/${taskId}/scans`, { events });
const item = async (token: string, barcode: string): Promise<string> => {
  const res = await as(token).post('/items', { barcode, name: `صنف ${barcode}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const running = async (csv: string): Promise<Task> => {
  const tk = await mk(managerA.token, { assigneeIds: [emp1.id, emp2.id] });
  await request(app)
    .post(`/api/v1/tasks/${tk.id}/balances?mode=apply`)
    .set('Authorization', `Bearer ${managerA.token}`)
    .set('Content-Type', 'text/csv')
    .send(csv);
  const fresh = (await as(managerA.token).get(`/tasks/${tk.id}`)).body.data as Task;
  const st = await as(managerA.token).post(`/tasks/${tk.id}/start`, { version: fresh.version });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return st.body.data;
};
const recount = (token: string, id: string, body: object) =>
  as(token).post(`/tasks/${id}/recounts`, body);
type Row = {
  barcode: string;
  counted: string;
  difference: string;
  flaggedForRecount: boolean;
  round: number;
  recountPending: boolean;
};
const results = async (id: string): Promise<{ rows: Row[]; summary: Record<string, unknown> }> => {
  const r = await as(managerA.token).get(`/tasks/${id}/results`);
  return { rows: r.body.data, summary: r.body.meta.summary };
};
const row = (rows: Row[], b: string): Row => rows.find((r) => r.barcode === b) as Row;

let itA: string;
let itB: string;

describe('recounts by a second reviewer', () => {
  beforeAll(async () => {
    itA = await item(adminAu.token, 'RC-A');
    itB = await item(adminAu.token, 'RC-B');
    await item(adminAu.token, 'RC-C');
  });

  it('requires inventory.task.recount (403), 401 and a valid body (400)', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    expect((await recount(emp1.token, tk.id, { itemIds: [itA], assigneeId: emp2.id })).status).toBe(
      403,
    );
    expect((await request(app).post(`/api/v1/tasks/${tk.id}/recounts`).send({})).status).toBe(401);
    for (const bad of [
      {},
      { assigneeId: emp2.id },
      { itemIds: [itA], flagged: true, assigneeId: emp2.id },
      { itemIds: [], assigneeId: emp2.id },
      { itemIds: [itA, itA], assigneeId: emp2.id },
      { itemIds: [itA], assigneeId: emp2.id, companyId: coB },
    ])
      expect((await recount(managerA.token, tk.id, bad)).status, JSON.stringify(bad)).toBe(400);
  });

  it('full cycle: count, flag, recount by a second reviewer, the new count replaces the old', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\nRC-B,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '7'), count('RC-B', '10')]);
    let r = await results(tk.id);
    expect(row(r.rows, 'RC-A')).toMatchObject({ counted: '7', flaggedForRecount: true, round: 1 });

    const req = await recount(managerA.token, tk.id, {
      flagged: true,
      assigneeId: emp2.id,
      reason: 'فرق كبير',
    });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.data).toEqual([{ itemId: itA, status: 'created', round: 2 }]);

    // قبل وصول العدّ الجديد: يبقى القديم ويُعلَّم معلَّقاً. Before the new count arrives: the old stays and is marked pending.
    r = await results(tk.id);
    expect(row(r.rows, 'RC-A')).toMatchObject({ counted: '7', recountPending: true, round: 1 });
    expect(r.summary.recountPending).toBe(1);

    // المراجع يرى ما عليه بلا أي رصيد أو عدّ سابق. The reviewer sees the work with no balance or earlier count.
    const mine = await as(emp2.token).get(`/tasks/${tk.id}/my-recounts`);
    expect(mine.body.data).toEqual([{ itemId: itA, barcode: 'RC-A', name: 'صنف RC-A', round: 2 }]);
    expect((await as(emp1.token).get(`/tasks/${tk.id}/my-recounts`)).body.data).toEqual([]);

    expect((await send(emp2.token, tk.id, [count('RC-A', '10')])).body.data[0].status).toBe(
      'created',
    );
    r = await results(tk.id);
    expect(row(r.rows, 'RC-A')).toMatchObject({
      counted: '10',
      difference: '0',
      flaggedForRecount: false,
      round: 2,
      recountPending: false,
    });
    expect(r.summary.recountPending).toBe(0);
    // العدّ الأول محفوظ في السجل. The first count is kept in the log.
    const log = await as(managerA.token).get(`/tasks/${tk.id}/scans`);
    expect(log.body.meta.total).toBe(3);
    expect((await as(emp2.token).get(`/tasks/${tk.id}/my-recounts`)).body.data).toEqual([]);

    const list = await as(managerA.token).get(`/tasks/${tk.id}/recounts`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      round: 2,
      assigneeName: expect.any(String),
      pending: false,
      reason: 'فرق كبير',
    });
  });

  it('only the assigned reviewer may count an item under recount; replays of old events still pass', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    const first = count('RC-A', '5');
    await send(emp1.token, tk.id, [first]);
    await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    // الأول لم يعد يستطيع عدّه. The first counter can no longer count it.
    const blocked = await send(emp1.token, tk.id, [count('RC-A', '9')]);
    expect(blocked.body.data[0]).toMatchObject({ status: 'rejected', code: 'RECOUNT_RESTRICTED' });
    // إعادة إرسال حدثه القديم المحفوظ ليست مخالفة. Replaying his stored event is not a violation.
    expect((await send(emp1.token, tk.id, [first])).body.data[0].status).toBe('duplicate');
    // أصناف أخرى لا تتأثر. Other items are unaffected.
    expect((await send(emp1.token, tk.id, [count('RC-B', '1')])).body.data[0].status).toBe(
      'created',
    );
    // المراجع يستطيع، وهو الوحيد. The reviewer can, and is the only one.
    expect((await send(emp2.token, tk.id, [count('RC-A', '10')])).body.data[0].status).toBe(
      'created',
    );
  });

  it('rejects: not assigned reviewer, earlier counter as reviewer, unknown item, closed/draft task', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '5')]);
    const out = await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: outsider.id });
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('INVALID_ASSIGNEE');
    // الذي عدّ الصنف لا يراجعه. The one who counted it cannot review it.
    const same = await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp1.id });
    expect(same.body.data).toEqual([
      { itemId: itA, status: 'rejected', code: 'REVIEWER_COUNTED_BEFORE' },
    ]);
    const ghost = await recount(managerA.token, tk.id, { itemIds: [itB], assigneeId: emp2.id });
    expect(ghost.body.data[0]).toMatchObject({ status: 'rejected', code: 'ITEM_NOT_IN_TASK' });
    const draft = await mk(managerA.token, { assigneeIds: [emp1.id, emp2.id] });
    const d = await recount(managerA.token, draft.id, { itemIds: [itA], assigneeId: emp2.id });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('TASK_NOT_RUNNING');
  });

  it('a second request for a pending item is a no-op; after it is counted a third round is possible', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '5')]);
    await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    const again = await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    expect(again.body.data).toEqual([{ itemId: itA, status: 'already_pending' }]);
    await send(emp2.token, tk.id, [count('RC-A', '6')]);
    // الثالثة تحتاج مراجعاً لم يعدّ: لا أحد متاح هنا غير المسندَين. A third round needs a fresh reviewer: none left here but the two assignees.
    const third = await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    expect(third.body.data[0].code).toBe('REVIEWER_COUNTED_BEFORE');
  });

  it('a voided recount count leaves the item pending again', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '5')]);
    await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    const c = count('RC-A', '10');
    await send(emp2.token, tk.id, [c]);
    await send(emp2.token, tk.id, [{ id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW }]);
    const r = await results(tk.id);
    expect(row(r.rows, 'RC-A')).toMatchObject({ counted: '5', recountPending: true, round: 1 });
  });

  it('closing is blocked while a recount is pending (even acknowledged), then works and freezes the round', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '5')]);
    await recount(managerA.token, tk.id, { itemIds: [itA], assigneeId: emp2.id });
    const close = (version: number) =>
      request(app)
        .post(`/api/v1/tasks/${tk.id}/close`)
        .set('Authorization', `Bearer ${managerA.token}`)
        .set('Idempotency-Key', ikey())
        .send({ version, acknowledgeFlagged: true });
    const blocked = await close(tk.version);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'RECOUNT_PENDING', details: { pending: 1 } });
    await send(emp2.token, tk.id, [count('RC-A', '10')]);
    const ok = await close(tk.version);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const frozen = await results(tk.id);
    expect(row(frozen.rows, 'RC-A')).toMatchObject({
      counted: '10',
      round: 2,
      flaggedForRecount: false,
    });
  });

  it('company isolation (404) and the recount list is supervisor-only', async () => {
    const tk = await running('barcode,quantity\nRC-A,10\n');
    await send(emp1.token, tk.id, [count('RC-A', '5')]);
    expect(
      (await recount(adminBu.token, tk.id, { itemIds: [itA], assigneeId: emp2.id })).status,
    ).toBe(404);
    expect((await as(adminBu.token).get(`/tasks/${tk.id}/recounts`)).status).toBe(404);
    expect((await as(emp1.token).get(`/tasks/${tk.id}/recounts`)).status).toBe(403);
    expect((await as(outsider.token).get(`/tasks/${tk.id}/my-recounts`)).status).toBe(404);
  });
});
