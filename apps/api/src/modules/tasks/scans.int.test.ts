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
let noScan: { token: string; id: string };
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
  noScan = await makeUser(coA, 'task-a', 'noscan', ['inventory.task.read']);

  whMain = await warehouse(adminAu.token, 'MAIN');
  whOther = await warehouse(adminAu.token, 'OTHER');
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = '2026-11-27T10:00:00+03:00';
let seq = 0;
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
const running = async (assignees: string[], extra: Record<string, unknown> = {}): Promise<Task> => {
  const tk = await mk(managerA.token, { assigneeIds: assignees, ...extra });
  const st = await as(managerA.token).post(`/tasks/${tk.id}/start`, { version: tk.version });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return st.body.data;
};
const rowCount = (taskId: string): Promise<number> =>
  withTenant(t.db, { companyId: coA }, async ({ trx }) =>
    Number(
      (
        await trx
          .selectFrom('audit_records')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('task_id', '=', taskId)
          .executeTakeFirstOrThrow()
      ).n,
    ),
  );

let unitCarton: string;
let locMain: string;
let locOther: string;

describe('scan events', () => {
  beforeAll(async () => {
    await item(adminAu.token, 'S-PLAIN');
    await item(adminAu.token, 'S-BOX', { units: [{ name: 'كرتون', factor: '12' }] });
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
    const l1 = await as(adminAu.token).post(`/warehouses/${whMain}/locations`, {
      code: 'A1',
      name: 'ممر 1',
    });
    const l2 = await as(adminAu.token).post(`/warehouses/${whOther}/locations`, {
      code: 'Z9',
      name: 'ممر 9',
    });
    locMain = l1.body.data.id;
    locOther = l2.body.data.id;
  });

  it('requires inventory.task.scan (403) and a token (401)', async () => {
    const tk = await running([emp1.id, noScan.id]);
    expect((await send(noScan.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(403);
    expect((await request(app).post(`/api/v1/tasks/${tk.id}/scans`).send({})).status).toBe(401);
  });

  it('records a count, computes the base quantity from the unit factor, and keeps unknown barcodes', async () => {
    const tk = await running([emp1.id]);
    const res = await send(emp1.token, tk.id, [
      count('S-PLAIN', '5'),
      count('S-BOX', '3', { unitId: unitCarton, locationId: locMain }),
      count('NOPE-1', '2'),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.map((r: { status: string }) => r.status)).toEqual([
      'created',
      'created',
      'created',
    ]);
    expect(res.body.data[2].unknownItem).toBe(true);
    const list = await as(emp1.token).get(`/tasks/${tk.id}/scans`);
    expect(list.status).toBe(200);
    const box = list.body.data.find((r: { barcode: string }) => r.barcode === 'S-BOX');
    expect(box).toMatchObject({
      quantity: '3.000000',
      baseQuantity: '36.000000',
      unitName: 'كرتون',
      locationCode: 'A1',
      voided: false,
    });
    const unk = list.body.data.find((r: { barcode: string }) => r.barcode === 'NOPE-1');
    expect(unk).toMatchObject({ itemId: null, itemName: null });
    expect(list.body.meta.total).toBe(3);
  });

  it('is idempotent: replaying the same event is a duplicate and never double counts', async () => {
    const tk = await running([emp1.id]);
    const ev = count('S-PLAIN', '4');
    expect((await send(emp1.token, tk.id, [ev])).body.data[0].status).toBe('created');
    const again = await send(emp1.token, tk.id, [ev]);
    expect(again.status).toBe(200);
    expect(again.body.data[0].status).toBe('duplicate');
    expect(await rowCount(tk.id)).toBe(1);
  });

  it('rejects an event id reused for a different payload (and keeps the original)', async () => {
    const tk = await running([emp1.id]);
    const ev = count('S-PLAIN', '4');
    await send(emp1.token, tk.id, [ev]);
    const r = await send(emp1.token, tk.id, [{ ...ev, quantity: '9' }]);
    expect(r.body.data[0]).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
    const list = await as(emp1.token).get(`/tasks/${tk.id}/scans`);
    expect(list.body.data[0].quantity).toBe('4.000000');
  });

  it('a rejected event does not fail the rest of the batch', async () => {
    const tk = await running([emp1.id]);
    const res = await send(emp1.token, tk.id, [
      count('S-PLAIN', '1', { locationId: locOther }),
      count('S-PLAIN', '2'),
    ]);
    expect(res.body.data[0]).toMatchObject({ status: 'rejected', code: 'INVALID_LOCATION' });
    expect(res.body.data[1].status).toBe('created');
    expect(await rowCount(tk.id)).toBe(1);
  });

  it('validates units and quantities', async () => {
    const tk = await running([emp1.id]);
    const wrongUnit = await send(emp1.token, tk.id, [
      count('S-PLAIN', '1', { unitId: unitCarton }),
    ]);
    expect(wrongUnit.body.data[0]).toMatchObject({ status: 'rejected', code: 'INVALID_UNIT' });
    const unknownWithUnit = await send(emp1.token, tk.id, [
      count('NOPE-2', '1', { unitId: unitCarton }),
    ]);
    expect(unknownWithUnit.body.data[0].code).toBe('UNIT_NOT_ALLOWED');
    for (const q of ['0', '-1', '1.2345678', 'abc', '']) {
      expect((await send(emp1.token, tk.id, [count('S-PLAIN', q)])).status, q).toBe(400);
    }
    expect((await send(emp1.token, tk.id, [])).status).toBe(400);
    const dup = count('S-PLAIN', '1');
    expect((await send(emp1.token, tk.id, [dup, dup])).status).toBe(400);
    const big = Array.from({ length: 201 }, () => count('S-PLAIN', '1'));
    expect((await send(emp1.token, tk.id, big)).status).toBe(400);
    expect(await rowCount(tk.id)).toBe(0);
  });

  it('rejects mass assignment of companyId/userId/taskId', async () => {
    const tk = await running([emp1.id]);
    for (const extra of [{ companyId: coB }, { userId: emp2.id }, { taskId: tk.id }]) {
      expect((await send(emp1.token, tk.id, [count('S-PLAIN', '1', extra)])).status).toBe(400);
    }
  });

  it('accepts a large batch in one request', async () => {
    const tk = await running([emp1.id]);
    const events = Array.from({ length: 200 }, (_, i) => count(i % 2 ? 'S-PLAIN' : 'S-BOX', '1'));
    const res = await send(emp1.token, tk.id, events);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: { status: string }) => r.status === 'created')).toBe(true);
    expect(await rowCount(tk.id)).toBe(200);
  });

  describe('task state and assignment', () => {
    it('only for a running task (409), not draft/cancelled', async () => {
      const draft = await mk(managerA.token, { assigneeIds: [emp1.id] });
      const r = await send(emp1.token, draft.id, [count('S-PLAIN', '1')]);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('TASK_NOT_RUNNING');
      const tk = await running([emp1.id]);
      await as(managerA.token).post(`/tasks/${tk.id}/cancel`, { version: tk.version });
      expect((await send(emp1.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(409);
    });

    it('a non-assignee gets 404, even with read_all or admin', async () => {
      const tk = await running([emp1.id]);
      expect((await send(emp2.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(404);
      expect((await send(managerA.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(404);
      expect((await send(adminAu.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(404);
      expect((await as(emp1.token).post('/tasks/not-a-uuid/scans', { events: [] })).status).toBe(
        404,
      );
    });
  });

  describe('void', () => {
    it('voids own count once; the original stays and is flagged voided', async () => {
      const tk = await running([emp1.id]);
      const c = count('S-PLAIN', '7');
      await send(emp1.token, tk.id, [c]);
      const v = { id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW };
      const r = await send(emp1.token, tk.id, [v]);
      expect(r.body.data[0].status).toBe('created');
      const second = await send(emp1.token, tk.id, [{ ...v, id: eid() }]);
      expect(second.body.data[0]).toMatchObject({ status: 'rejected', code: 'ALREADY_VOIDED' });
      // إعادة إرسال نفس الإلغاء مكرر لا رفض. Replaying the same void is a duplicate, not a rejection.
      expect((await send(emp1.token, tk.id, [v])).body.data[0].status).toBe('duplicate');
      const list = await as(emp1.token).get(`/tasks/${tk.id}/scans`);
      const orig = list.body.data.find((x: { id: string }) => x.id === c.id);
      expect(orig.voided).toBe(true);
      expect(orig.quantity).toBe('7.000000');
      expect(await rowCount(tk.id)).toBe(2);
    });

    it("cannot void another user's count, a void, or a record of another task", async () => {
      const tk = await running([emp1.id, emp2.id]);
      const other = await running([emp1.id]);
      const c = count('S-PLAIN', '1');
      await send(emp1.token, tk.id, [c]);
      const r1 = await send(emp2.token, tk.id, [
        { id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW },
      ]);
      expect(r1.body.data[0]).toMatchObject({ status: 'rejected', code: 'VOID_TARGET_NOT_FOUND' });
      const r2 = await send(emp1.token, other.id, [
        { id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW },
      ]);
      expect(r2.body.data[0].code).toBe('VOID_TARGET_NOT_FOUND');
      const v = { id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW };
      await send(emp1.token, tk.id, [v]);
      const r3 = await send(emp1.token, tk.id, [
        { id: eid(), kind: 'void', voidsId: v.id, scannedAt: NOW },
      ]);
      expect(r3.body.data[0].code).toBe('VOID_TARGET_INVALID');
    });

    it('a void inside the same batch sees the count before it', async () => {
      const tk = await running([emp1.id]);
      const c = count('S-PLAIN', '2');
      const res = await send(emp1.token, tk.id, [
        c,
        { id: eid(), kind: 'void', voidsId: c.id, scannedAt: NOW },
      ]);
      expect(res.body.data.map((r: { status: string }) => r.status)).toEqual([
        'created',
        'created',
      ]);
    });
  });

  describe('listing', () => {
    it('an employee sees only their own records; read_all sees all and can filter', async () => {
      const tk = await running([emp1.id, emp2.id]);
      await send(emp1.token, tk.id, [count('S-PLAIN', '1'), count('S-PLAIN', '2')]);
      await send(emp2.token, tk.id, [count('S-PLAIN', '3')]);
      expect((await as(emp1.token).get(`/tasks/${tk.id}/scans`)).body.meta.total).toBe(2);
      // يتجاهل userId لغير المخوَّل. userId is ignored for the unprivileged.
      expect(
        (await as(emp1.token).get(`/tasks/${tk.id}/scans?userId=${emp2.id}`)).body.meta.total,
      ).toBe(2);
      expect((await as(managerA.token).get(`/tasks/${tk.id}/scans`)).body.meta.total).toBe(3);
      const one = await as(managerA.token).get(`/tasks/${tk.id}/scans?userId=${emp2.id}`);
      expect(one.body.meta.total).toBe(1);
      expect(
        (await as(managerA.token).get(`/tasks/${tk.id}/scans?pageSize=2&page=2`)).body.data,
      ).toHaveLength(1);
      expect((await as(noScan.token).get(`/tasks/${tk.id}/scans`)).status).toBe(404);
    });
  });

  describe('append-only', () => {
    it('UPDATE and DELETE are blocked at the database, even for the table owner', async () => {
      const tk = await running([emp1.id]);
      const c = count('S-PLAIN', '1');
      await send(emp1.token, tk.id, [c]);
      await expect(
        sql`UPDATE audit_records SET quantity = 99 WHERE id = ${c.id}`.execute(t.db),
      ).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM audit_records WHERE id = ${c.id}`.execute(t.db)).rejects.toThrow(
        /append-only/,
      );
      await expect(sql`TRUNCATE audit_records`.execute(t.db)).rejects.toThrow(/append-only/);
      await expect(
        withTenant(t.db, { companyId: coA }, ({ trx }) =>
          sql`DELETE FROM audit_records WHERE id = ${c.id}`.execute(trx),
        ),
      ).rejects.toThrow();
      expect(await rowCount(tk.id)).toBe(1);
    });
  });

  describe('company isolation', () => {
    it('company B cannot see, scan into, or collide with company A records', async () => {
      const tk = await running([emp1.id]);
      const c = count('S-PLAIN', '1');
      await send(emp1.token, tk.id, [c]);
      expect((await as(adminBu.token).get(`/tasks/${tk.id}/scans`)).status).toBe(404);
      expect((await send(adminBu.token, tk.id, [count('S-PLAIN', '1')])).status).toBe(404);
      // نفس المعرّف في شركة أخرى لا يكشف ولا يكتب. The same id in another company neither leaks nor writes.
      const whB = await warehouse(adminBu.token, 'B-MAIN');
      const itB = await item(adminBu.token, 'B-ITEM');
      expect(itB).toBeTruthy();
      const empB = await makeUser(coB, 'task-b', 'empb', [
        'inventory.task.read',
        'inventory.task.scan',
        'inventory.task.create',
        'inventory.task.start',
      ]);
      const tb = await as(adminBu.token).post('/tasks', {
        title: 'B',
        warehouseId: whB,
        assigneeIds: [empB.id],
      });
      await as(adminBu.token).post(`/tasks/${tb.body.data.id}/start`, { version: 1 });
      const clash = await send(empB.token, tb.body.data.id, [{ ...c }]);
      expect(clash.body.data[0]).toMatchObject({
        status: 'rejected',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await rowCount(tk.id)).toBe(1);
    });
  });
});
