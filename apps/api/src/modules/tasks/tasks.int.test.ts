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
];

let managerA: { token: string; id: string };
let emp1: { token: string; id: string };
let emp2: { token: string; id: string };
let readerOnly: { token: string; id: string };
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
  readerOnly = await makeUser(coA, 'task-a', 'reader', ['inventory.warehouse.read']);
  whMain = await warehouse(adminAu.token, 'MAIN');
  whOther = await warehouse(adminAu.token, 'OTHER');
});
afterAll(async () => {
  await t.cleanup();
});

describe('permissions', () => {
  it('each action needs its own permission', async () => {
    const t1 = await mk(managerA.token, { assigneeIds: [emp1.id] });
    expect((await as(readerOnly.token).get('/tasks')).status).toBe(403);
    expect((await as(readerOnly.token).get(`/tasks/${t1.id}`)).status).toBe(403);
    expect((await as(emp1.token).post('/tasks', { title: 'x', warehouseId: whMain })).status).toBe(
      403,
    );
    expect((await as(emp1.token).patch(`/tasks/${t1.id}`, { version: 1, title: 'y' })).status).toBe(
      403,
    );
    expect((await as(emp1.token).post(`/tasks/${t1.id}/start`, { version: 1 })).status).toBe(403);
    expect((await as(emp1.token).post(`/tasks/${t1.id}/cancel`, { version: 1 })).status).toBe(403);
  });
});

describe('create', () => {
  it('numbers tasks sequentially per company, with defaults and assignees', async () => {
    const a = await mk(managerA.token, { assigneeIds: [emp1.id, emp2.id] });
    const b = await mk(managerA.token, { blindCount: true, aggregateLocations: false });
    expect(b.taskNo).toBe(a.taskNo + 1);
    expect(a).toMatchObject({
      status: 'draft',
      blindCount: false,
      aggregateLocations: true,
      version: 1,
    });
    expect(a.assignees.map((x) => x.userId).sort()).toEqual([emp1.id, emp2.id].sort());
    expect(b).toMatchObject({ blindCount: true, aggregateLocations: false });
  });

  it('numbers are independent between companies', async () => {
    const wh = await warehouse(adminBu.token, 'MAIN');
    const res = await as(adminBu.token).post('/tasks', { title: 'x', warehouseId: wh });
    expect(res.body.data.taskNo).toBe(1);
  });

  it('concurrent creation never repeats a number', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        as(managerA.token).post('/tasks', { title: 'par', warehouseId: whMain }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nos = results.map((r) => r.body.data.taskNo as number);
    expect(new Set(nos).size).toBe(8);
  });

  it('ignores a client companyId (strict body → 400)', async () => {
    const res = await as(managerA.token).post('/tasks', {
      title: 'x',
      warehouseId: whMain,
      companyId: coB,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown warehouse and one from another company with 404', async () => {
    const missing = await as(managerA.token).post('/tasks', { title: 'x', warehouseId: coB });
    expect(missing.status).toBe(404);
    const otherCo = await warehouse(adminBu.token, 'SECOND');
    expect(
      (await as(managerA.token).post('/tasks', { title: 'x', warehouseId: otherCo })).status,
    ).toBe(404);
  });

  it('rejects an inactive warehouse (422)', async () => {
    const wh = await warehouse(adminAu.token, 'OLD');
    const got = await as(adminAu.token).get(`/warehouses/${wh}`);
    await as(adminAu.token).patch(`/warehouses/${wh}`, {
      version: got.body.data.version,
      active: false,
    });
    const res = await as(managerA.token).post('/tasks', { title: 'x', warehouseId: wh });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WAREHOUSE_INACTIVE');
  });

  it('rejects assignees that are unknown, from another company, inactive or out of the warehouse scope', async () => {
    const unknown = await as(managerA.token).post('/tasks', {
      title: 'x',
      warehouseId: whMain,
      assigneeIds: [coB],
    });
    expect(unknown.body.error.code).toBe('INVALID_ASSIGNEE');
    const foreign = await as(managerA.token).post('/tasks', {
      title: 'x',
      warehouseId: whMain,
      assigneeIds: [adminBu.id],
    });
    expect(foreign.body.error.code).toBe('INVALID_ASSIGNEE');

    const scoped = await makeUser(coA, 'task-a', 'scoped', ['inventory.task.read']);
    await scopeTo(coA, scoped.id, whOther);
    const out = await as(managerA.token).post('/tasks', {
      title: 'x',
      warehouseId: whMain,
      assigneeIds: [scoped.id],
    });
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('ASSIGNEE_OUT_OF_SCOPE');
    expect(
      (
        await as(managerA.token).post('/tasks', {
          title: 'x',
          warehouseId: whOther,
          assigneeIds: [scoped.id],
        })
      ).status,
    ).toBe(201);

    await withTenant(t.db, { companyId: coA }, async ({ trx }) => {
      await trx.updateTable('users').set({ active: false }).where('id', '=', emp2.id).execute();
    });
    const inactive = await as(managerA.token).post('/tasks', {
      title: 'x',
      warehouseId: whMain,
      assigneeIds: [emp2.id],
    });
    expect(inactive.body.error.code).toBe('INVALID_ASSIGNEE');
    await withTenant(t.db, { companyId: coA }, async ({ trx }) => {
      await trx.updateTable('users').set({ active: true }).where('id', '=', emp2.id).execute();
    });
  });
});

describe('visibility', () => {
  it('an employee sees only the tasks assigned to them; others are 404', async () => {
    const mine = await mk(managerA.token, { title: 'لـ emp1', assigneeIds: [emp1.id] });
    const notMine = await mk(managerA.token, { title: 'ليست لي', assigneeIds: [emp2.id] });
    const list = await as(emp1.token).get('/tasks?pageSize=100');
    const ids = list.body.data.map((x: Task) => x.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(notMine.id);
    expect((await as(emp1.token).get(`/tasks/${mine.id}`)).status).toBe(200);
    expect((await as(emp1.token).get(`/tasks/${notMine.id}`)).status).toBe(404);
    // read_all يرى الكل. read_all sees everything.
    const all = await as(managerA.token).get('/tasks?pageSize=100');
    expect(all.body.data.map((x: Task) => x.id)).toEqual(
      expect.arrayContaining([mine.id, notMine.id]),
    );
  });

  it('warehouse scope narrows even a read_all user', async () => {
    const scopedMgr = await makeUser(coA, 'task-a', 'scoped-mgr', ALL_TASK);
    await scopeTo(coA, scopedMgr.id, whOther);
    const inMain = await mk(managerA.token, { title: 'main only' });
    const inOther = await mk(managerA.token, { title: 'other only', warehouseId: whOther });
    const list = await as(scopedMgr.token).get('/tasks?pageSize=100');
    const ids = list.body.data.map((x: Task) => x.id);
    expect(ids).toContain(inOther.id);
    expect(ids).not.toContain(inMain.id);
    expect((await as(scopedMgr.token).get(`/tasks/${inMain.id}`)).status).toBe(404);
    expect(
      (await as(scopedMgr.token).patch(`/tasks/${inMain.id}`, { version: 1, title: 'z' })).status,
    ).toBe(404);
    expect(
      (await as(scopedMgr.token).post(`/tasks/${inMain.id}/start`, { version: 1 })).status,
    ).toBe(404);
    expect(
      (await as(scopedMgr.token).post('/tasks', { title: 'x', warehouseId: whMain })).status,
    ).toBe(404);
  });

  it('a malformed id is 404', async () => {
    expect((await as(managerA.token).get('/tasks/not-a-uuid')).status).toBe(404);
  });
});

describe('list filters', () => {
  it('filters by status, warehouse and text, sorts, and paginates', async () => {
    const co = await seedCompany(t.db, 'Task List', 'task-list');
    const adm = await makeUser(co, 'task-list', 'admin', null);
    const w1 = await warehouse(adm.token, 'W1');
    const w2 = await warehouse(adm.token, 'W2');
    const emp = await makeUser(co, 'task-list', 'emp', ['inventory.task.read']);
    const a = await as(adm.token).post('/tasks', {
      title: 'جرد المشروبات',
      warehouseId: w1,
      assigneeIds: [emp.id],
      startsAt: '2026-12-01T08:00:00+03:00',
    });
    await as(adm.token).post('/tasks', { title: 'Cold Room', warehouseId: w2 });
    await as(adm.token).post('/tasks', {
      title: 'جرد نهاية السنة',
      warehouseId: w1,
      startsAt: '2026-12-31T08:00:00+03:00',
    });
    await as(adm.token).post(`/tasks/${a.body.data.id}/start`, { version: 1 });

    const q = async (qs: string) => (await as(adm.token).get(`/tasks${qs}`)).body;
    expect((await q('?status=in_progress')).data).toHaveLength(1);
    expect((await q(`?warehouseId=${w2}`)).data.map((x: Task) => x.title)).toEqual(['Cold Room']);
    expect((await q('?q=cold')).data).toHaveLength(1);
    expect((await q('?q=جرد')).meta.total).toBe(2);
    expect((await q('?q=3')).data.map((x: Task) => x.taskNo)).toEqual([3]);
    expect((await q('?sort=taskNo&dir=asc')).data.map((x: Task) => x.taskNo)).toEqual([1, 2, 3]);
    // بلا موعد بدء تأتي في الآخر في الاتجاهين. Tasks without a start time come last in both directions.
    expect((await q('?sort=startsAt&dir=asc')).data.map((x: Task) => x.taskNo)).toEqual([1, 3, 2]);
    expect((await q('?sort=startsAt&dir=desc')).data.map((x: Task) => x.taskNo)).toEqual([3, 1, 2]);
    const page = await q('?pageSize=2&page=2&sort=taskNo&dir=asc');
    expect(page.data.map((x: Task) => x.taskNo)).toEqual([3]);
    expect(page.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect((await as(adm.token).get('/tasks?pageSize=101')).status).toBe(400);
    expect((await as(adm.token).get('/tasks?sort=password')).status).toBe(400);
  });
});

describe('update (draft only, optimistic lock)', () => {
  it('edits fields and replaces assignees, bumping the version', async () => {
    const task = await mk(managerA.token, { assigneeIds: [emp1.id] });
    const res = await as(managerA.token).patch(`/tasks/${task.id}`, {
      version: task.version,
      title: 'عنوان جديد',
      assigneeIds: [emp2.id],
      blindCount: true,
      startsAt: '2026-12-05T09:00:00Z',
      notes: 'ملاحظة',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      title: 'عنوان جديد',
      blindCount: true,
      notes: 'ملاحظة',
      version: task.version + 1,
    });
    expect(res.body.data.assignees.map((x: { userId: string }) => x.userId)).toEqual([emp2.id]);
    expect((await as(emp1.token).get(`/tasks/${task.id}`)).status).toBe(404);
    const clear = await as(managerA.token).patch(`/tasks/${task.id}`, {
      version: res.body.data.version,
      startsAt: null,
      notes: null,
      assigneeIds: [],
    });
    expect(clear.body.data).toMatchObject({ startsAt: null, notes: null, assignees: [] });
  });

  it('a stale version is 409 VERSION_CONFLICT with the current version; nothing changes', async () => {
    const task = await mk(managerA.token, { title: 'قفل' });
    await as(managerA.token).patch(`/tasks/${task.id}`, { version: 1, title: 'الأول' });
    const stale = await as(managerA.token).patch(`/tasks/${task.id}`, {
      version: 1,
      title: 'الثاني',
      assigneeIds: [emp1.id],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    const now = await as(managerA.token).get(`/tasks/${task.id}`);
    expect(now.body.data).toMatchObject({ title: 'الأول', assignees: [] });
  });

  it('the warehouse cannot be changed and unknown fields are rejected', async () => {
    const task = await mk(managerA.token, {});
    expect(
      (await as(managerA.token).patch(`/tasks/${task.id}`, { version: 1, warehouseId: whOther }))
        .status,
    ).toBe(400);
    expect(
      (await as(managerA.token).patch(`/tasks/${task.id}`, { version: 1, status: 'closed' }))
        .status,
    ).toBe(400);
    expect((await as(managerA.token).patch(`/tasks/${task.id}`, { version: 1 })).status).toBe(400);
  });

  it('a started task cannot be edited', async () => {
    const task = await mk(managerA.token, { assigneeIds: [emp1.id] });
    await as(managerA.token).post(`/tasks/${task.id}/start`, { version: 1 });
    const res = await as(managerA.token).patch(`/tasks/${task.id}`, { version: 2, title: 'متأخر' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_NOT_EDITABLE');
  });
});

describe('start and cancel', () => {
  it('start needs at least one assignee, then moves to in_progress with a timestamp', async () => {
    const task = await mk(managerA.token, {});
    const none = await as(managerA.token).post(`/tasks/${task.id}/start`, { version: 1 });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('NO_ASSIGNEES');
    await as(managerA.token).patch(`/tasks/${task.id}`, { version: 1, assigneeIds: [emp1.id] });
    const ok = await as(managerA.token).post(`/tasks/${task.id}/start`, { version: 2 });
    expect(ok.body.data).toMatchObject({ status: 'in_progress', version: 3 });
    expect(ok.body.data.startedAt).toBeTruthy();
    const again = await as(managerA.token).post(`/tasks/${task.id}/start`, { version: 3 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('cancel works from draft and in_progress, never from a terminal state', async () => {
    const draft = await mk(managerA.token, {});
    const c1 = await as(managerA.token).post(`/tasks/${draft.id}/cancel`, { version: 1 });
    expect(c1.body.data).toMatchObject({ status: 'cancelled' });
    expect(c1.body.data.cancelledAt).toBeTruthy();
    expect(
      (await as(managerA.token).post(`/tasks/${draft.id}/cancel`, { version: 2 })).body.error.code,
    ).toBe('INVALID_TRANSITION');
    expect(
      (await as(managerA.token).post(`/tasks/${draft.id}/start`, { version: 2 })).body.error.code,
    ).toBe('INVALID_TRANSITION');

    const running = await mk(managerA.token, { assigneeIds: [emp1.id] });
    await as(managerA.token).post(`/tasks/${running.id}/start`, { version: 1 });
    expect(
      (await as(managerA.token).post(`/tasks/${running.id}/cancel`, { version: 2 })).body.data
        .status,
    ).toBe('cancelled');
  });

  it('transitions respect the version lock, and only one of two racing starts wins', async () => {
    const task = await mk(managerA.token, { assigneeIds: [emp1.id] });
    expect((await as(managerA.token).post(`/tasks/${task.id}/start`, { version: 9 })).status).toBe(
      409,
    );
    const [a, b] = await Promise.all([
      as(managerA.token).post(`/tasks/${task.id}/start`, { version: 1 }),
      as(managerA.token).post(`/tasks/${task.id}/start`, { version: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('a body without a version is rejected', async () => {
    const task = await mk(managerA.token, { assigneeIds: [emp1.id] });
    expect((await as(managerA.token).post(`/tasks/${task.id}/start`, {})).status).toBe(400);
  });
});

describe('company isolation', () => {
  it('company B never sees, changes or lists company A tasks', async () => {
    const task = await mk(managerA.token, { title: 'سري', assigneeIds: [emp1.id] });
    expect((await as(adminBu.token).get(`/tasks/${task.id}`)).status).toBe(404);
    expect(
      (await as(adminBu.token).patch(`/tasks/${task.id}`, { version: 1, title: 'اختراق' })).status,
    ).toBe(404);
    expect((await as(adminBu.token).post(`/tasks/${task.id}/start`, { version: 1 })).status).toBe(
      404,
    );
    expect((await as(adminBu.token).post(`/tasks/${task.id}/cancel`, { version: 1 })).status).toBe(
      404,
    );
    const list = await as(adminBu.token).get('/tasks?pageSize=100');
    expect(list.body.data.map((x: Task) => x.id)).not.toContain(task.id);
    expect((await as(adminAu.token).get(`/tasks/${task.id}`)).body.data.title).toBe('سري');
  });
});
