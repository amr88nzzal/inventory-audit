import { sql } from 'kysely';
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
];

let managerA: { token: string; id: string };
let emp1: { token: string; id: string };
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

  whMain = await warehouse(adminAu.token, 'MAIN');
});
afterAll(async () => {
  await t.cleanup();
});

const NOW = '2026-11-27T10:00:00+03:00';
let seq = 9000;
const eid = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
let keySeq = 0;
const ikey = (): string => `close-key-${Date.now()}-${++keySeq}`;
const count = (barcode: string, quantity: string) => ({
  id: eid(),
  kind: 'count',
  barcode,
  quantity,
  scannedAt: NOW,
});
const send = (token: string, taskId: string, events: object[]) =>
  as(token).post(`/tasks/${taskId}/scans`, { events });
const item = async (token: string, barcode: string, body: object = {}): Promise<string> => {
  const res = await as(token).post('/items', { barcode, name: `صنف ${barcode}`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const running = async (csv: string, extra: Record<string, unknown> = {}): Promise<Task> => {
  const tk = await mk(managerA.token, { assigneeIds: [emp1.id], ...extra });
  if (csv)
    expect(
      (
        await request(app)
          .post(`/api/v1/tasks/${tk.id}/balances?mode=apply`)
          .set('Authorization', `Bearer ${managerA.token}`)
          .set('Content-Type', 'text/csv')
          .send(csv)
      ).status,
    ).toBe(200);
  const fresh = (await as(managerA.token).get(`/tasks/${tk.id}`)).body.data as Task;
  const st = await as(managerA.token).post(`/tasks/${tk.id}/start`, { version: fresh.version });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  return st.body.data;
};
const close = (token: string, id: string, body: object, key: string | null = ikey()) => {
  let r = request(app).post(`/api/v1/tasks/${id}/close`).set('Authorization', `Bearer ${token}`);
  if (key !== null) r = r.set('Idempotency-Key', key);
  return r.send(body);
};
const frozenCount = (taskId: string): Promise<number> =>
  withTenant(t.db, { companyId: coA }, async ({ trx }) =>
    Number(
      (
        await trx
          .selectFrom('audit_task_results')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('task_id', '=', taskId)
          .executeTakeFirstOrThrow()
      ).n,
    ),
  );

describe('closing a task', () => {
  let itemA: string;
  beforeAll(async () => {
    itemA = await item(adminAu.token, 'C-A');
    await item(adminAu.token, 'C-B');
  });

  it('requires inventory.task.close (403), a token (401) and the Idempotency-Key header (400)', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    expect((await close(emp1.token, tk.id, { version: tk.version })).status).toBe(403);
    expect((await request(app).post(`/api/v1/tasks/${tk.id}/close`).send({})).status).toBe(401);
    for (const bad of [null, 'short', 'has spaces here', 'x'.repeat(101)]) {
      const r = await close(
        managerA.token,
        tk.id,
        { version: tk.version, acknowledgeFlagged: true },
        bad,
      );
      expect(r.status, String(bad)).toBe(400);
    }
    expect(
      (await close(managerA.token, tk.id, { version: tk.version, acknowledgeFlagged: true }, null))
        .body.error.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await as(managerA.token).get(`/tasks/${tk.id}`)).body.data.status).toBe('in_progress');
  });

  it('refuses to close with flagged items unless acknowledged, then freezes the result', async () => {
    const tk = await running('barcode,quantity\nC-A,10\nC-B,10\n');
    await send(emp1.token, tk.id, [count('C-A', '10'), count('C-B', '7'), count('GHOST', '2')]);
    const refused = await close(managerA.token, tk.id, { version: tk.version });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'UNRESOLVED_VARIANCES',
      details: { flagged: 1 },
    });
    expect(await frozenCount(tk.id)).toBe(0);

    const live = (await as(managerA.token).get(`/tasks/${tk.id}/results`)).body;
    expect(live.meta.frozen).toBe(false);
    const ok = await close(managerA.token, tk.id, {
      version: tk.version,
      acknowledgeFlagged: true,
      note: 'تم الجرد',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'closed', closingNote: 'تم الجرد' });
    expect(ok.body.data.closedAt).toBeTruthy();
    expect(await frozenCount(tk.id)).toBe(2);

    // المجمَّد يطابق الحيّ لحظة الإغلاق ويتجاهل أي تغيير لاحق. The frozen result equals the live one at close and ignores later edits.
    const strip = (r: { data: object[]; meta: { summary: object } }) => ({
      rows: r.data,
      summary: r.meta.summary,
    });
    const frozen = (await as(managerA.token).get(`/tasks/${tk.id}/results`)).body;
    expect(frozen.meta.frozen).toBe(true);
    expect(strip(frozen)).toEqual(strip(live));
    await as(adminAu.token).patch(`/items/${itemA}`, {
      version: 1,
      name: 'اسم جديد',
      tolerancePct: '50',
    });
    const after = (await as(managerA.token).get(`/tasks/${tk.id}/results?tolerancePct=90`)).body;
    expect(after.meta.summary).toEqual(frozen.meta.summary);
    expect((await as(managerA.token).get(`/tasks/${tk.id}/results/unknown`)).body.data).toEqual([
      { barcode: 'GHOST', quantity: '2', records: 1 },
    ]);
  });

  it('closes a clean task without acknowledgement', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    await send(emp1.token, tk.id, [count('C-A', '10')]);
    const ok = await close(managerA.token, tk.id, { version: tk.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('closed');
  });

  it('stops scanning after close', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    await close(managerA.token, tk.id, { version: tk.version, acknowledgeFlagged: true });
    const r = await send(emp1.token, tk.id, [count('C-A', '1')]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TASK_NOT_RUNNING');
  });

  it('is idempotent: same key replays the response, a different request with the key is rejected', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    const key = ikey();
    const body = { version: tk.version, acknowledgeFlagged: true };
    const first = await close(managerA.token, tk.id, body, key);
    expect(first.status).toBe(200);
    const again = await close(managerA.token, tk.id, body, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.data).toEqual(first.body.data);
    expect(await frozenCount(tk.id)).toBe(1);
    const other = await close(managerA.token, tk.id, { ...body, note: 'مختلف' }, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // مفتاح جديد على مهمة مغلقة: انتقال غير صالح. A new key on a closed task: invalid transition.
    const fresh = await close(managerA.token, tk.id, { ...body, version: first.body.data.version });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects a stale version and a draft/cancelled task', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    const stale = await close(managerA.token, tk.id, {
      version: tk.version - 1,
      acknowledgeFlagged: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const draft = await mk(managerA.token, { assigneeIds: [emp1.id] });
    const d = await close(managerA.token, draft.id, {
      version: draft.version,
      acknowledgeFlagged: true,
    });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('applies the task tolerance (editable in draft only)', async () => {
    const tk = await running('barcode,quantity\nC-B,100\n', { tolerancePct: '5' });
    expect(tk.tolerancePct).toBe('5');
    await send(emp1.token, tk.id, [count('C-B', '96')]); // -4%
    const rows = (await as(managerA.token).get(`/tasks/${tk.id}/results`)).body.data;
    expect(rows[0]).toMatchObject({ appliedTolerancePct: '5', flaggedForRecount: false });
    const ok = await close(managerA.token, tk.id, { version: tk.version });
    expect(ok.status).toBe(200);
    const draft = await mk(managerA.token, { assigneeIds: [emp1.id], tolerancePct: '1' });
    const upd = await as(managerA.token).patch(`/tasks/${draft.id}`, {
      version: draft.version,
      tolerancePct: '2.5',
    });
    expect(upd.body.data.tolerancePct).toBe('2.5');
    const started = await as(managerA.token).patch(`/tasks/${tk.id}`, {
      version: ok.body.data.version,
      tolerancePct: '9',
    });
    expect(started.status).toBe(409);
    expect(
      (
        await as(managerA.token).post('/tasks', {
          title: 'x',
          warehouseId: whMain,
          tolerancePct: '101',
        })
      ).status,
    ).toBe(400);
  });

  it('frozen tables and idempotency keys are append-only at the database', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    await send(emp1.token, tk.id, [count('GHOST', '1')]);
    await close(managerA.token, tk.id, { version: tk.version, acknowledgeFlagged: true });
    await expect(
      sql`UPDATE audit_task_results SET counted = 1 WHERE task_id = ${tk.id}`.execute(t.db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM audit_task_results WHERE task_id = ${tk.id}`.execute(t.db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM audit_task_unknown WHERE task_id = ${tk.id}`.execute(t.db),
    ).rejects.toThrow(/append-only/);
  });

  it('company isolation: another company gets 404 and its keys do not collide', async () => {
    const tk = await running('barcode,quantity\nC-A,10\n');
    const key = ikey();
    expect(
      (await close(adminBu.token, tk.id, { version: tk.version, acknowledgeFlagged: true }, key))
        .status,
    ).toBe(404);
    expect(
      (await close(managerA.token, tk.id, { version: tk.version, acknowledgeFlagged: true }, key))
        .status,
    ).toBe(200);
    expect((await as(adminBu.token).get(`/tasks/${tk.id}/results`)).status).toBe(404);
  });
});
