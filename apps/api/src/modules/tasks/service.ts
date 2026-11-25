import { canTransition, escapeLike, isEditable, offsetOf, pageMeta } from '@inventory/shared';
import type {
  CreateTaskInput,
  PageMeta,
  TaskListQuery,
  TaskStatus,
  UpdateTaskInput,
} from '@inventory/shared';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { newId, withTenant } from '../../db';
import type { Database } from '../../db';
import { AppError } from '../../errors';
import { scopeOf } from '../warehouses';

export interface Actor {
  companyId: string;
  userId: string;
}
export interface TaskDeps {
  db: Kysely<Database>;
}

export interface TaskView {
  id: string;
  taskNo: number;
  title: string;
  warehouseId: string;
  warehouseName: string;
  status: TaskStatus;
  startsAt: string | null;
  blindCount: boolean;
  aggregateLocations: boolean;
  notes: string | null;
  startedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  assignees: { userId: string; displayName: string }[];
  version: number;
  createdAt: string;
}

type Trx = Transaction<Database>;
const notFound = (): AppError => new AppError('NOT_FOUND', 404, 'Task not found');
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

interface Row {
  id: string;
  task_no: number;
  title: string;
  warehouse_id: string;
  warehouse_name: string;
  status: TaskStatus;
  starts_at: Date | null;
  blind_count: boolean;
  aggregate_locations: boolean;
  notes: string | null;
  started_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  version: number;
  created_at: Date;
}

const baseSelect = (trx: Trx) =>
  trx
    .selectFrom('audit_tasks as t')
    .innerJoin('warehouses as w', 'w.id', 't.warehouse_id')
    .select([
      't.id',
      't.task_no',
      't.title',
      't.warehouse_id',
      'w.name as warehouse_name',
      't.status',
      't.starts_at',
      't.blind_count',
      't.aggregate_locations',
      't.notes',
      't.started_at',
      't.closed_at',
      't.cancelled_at',
      't.version',
      't.created_at',
    ])
    .where('t.deleted_at', 'is', null);

const assigneesOf = async (
  trx: Trx,
  taskIds: string[],
): Promise<Map<string, TaskView['assignees']>> => {
  const out = new Map<string, TaskView['assignees']>();
  if (taskIds.length === 0) return out;
  const rows = await trx
    .selectFrom('audit_task_assignees as a')
    .innerJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.task_id', 'a.user_id', 'u.display_name'])
    .where('a.task_id', 'in', taskIds)
    .orderBy('u.display_name')
    .orderBy('a.user_id')
    .execute();
  for (const r of rows)
    out.set(r.task_id, [
      ...(out.get(r.task_id) ?? []),
      { userId: r.user_id, displayName: r.display_name },
    ]);
  return out;
};

const toView = (r: Row, assignees: TaskView['assignees']): TaskView => ({
  id: r.id,
  taskNo: r.task_no,
  title: r.title,
  warehouseId: r.warehouse_id,
  warehouseName: r.warehouse_name,
  status: r.status,
  startsAt: iso(r.starts_at),
  blindCount: r.blind_count,
  aggregateLocations: r.aggregate_locations,
  notes: r.notes,
  startedAt: iso(r.started_at),
  closedAt: iso(r.closed_at),
  cancelledAt: iso(r.cancelled_at),
  assignees,
  version: r.version,
  createdAt: iso(r.created_at) as string,
});

// الرؤية: نطاق المستودعات للجميع، ومن لا يملك read_all لا يرى إلا ما أُسند إليه. غير المرئي = 404 (لا نكشف وجوده).
// Visibility: warehouse scope for everyone; without read_all you see only what is assigned to you. Invisible = 404 (existence is not revealed).
const loadVisible = async (trx: Trx, actor: Actor, id: string, seeAll: boolean): Promise<Row> => {
  const scope = await scopeOf(trx, actor.userId);
  let q = baseSelect(trx).where('t.id', '=', id);
  if (scope) q = q.where('t.warehouse_id', 'in', scope);
  if (!seeAll)
    q = q.where(
      't.id',
      'in',
      trx.selectFrom('audit_task_assignees').select('task_id').where('user_id', '=', actor.userId),
    );
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row as Row;
};

// المسندون: مستخدمون نشطون من الشركة، ونطاقهم يشمل مستودع المهمة (وإلا لن يروها أبداً).
// Assignees: active users of the company whose scope includes the task's warehouse (otherwise they could never see it).
const validateAssignees = async (
  trx: Trx,
  warehouseId: string,
  userIds: string[],
): Promise<void> => {
  if (userIds.length === 0) return;
  const users = await trx
    .selectFrom('users')
    .select('id')
    .where('id', 'in', userIds)
    .where('active', '=', true)
    .where('deleted_at', 'is', null)
    .execute();
  const found = new Set(users.map((u) => u.id));
  const missing = userIds.filter((u) => !found.has(u));
  if (missing.length > 0)
    throw new AppError('INVALID_ASSIGNEE', 422, 'Some assignees are unknown or inactive', {
      userIds: missing,
    });
  const scoped = await trx
    .selectFrom('user_warehouses')
    .select(['user_id', 'warehouse_id'])
    .where('user_id', 'in', userIds)
    .execute();
  const outside = userIds.filter((u) => {
    const mine = scoped.filter((s) => s.user_id === u);
    return mine.length > 0 && !mine.some((s) => s.warehouse_id === warehouseId);
  });
  if (outside.length > 0)
    throw new AppError(
      'ASSIGNEE_OUT_OF_SCOPE',
      422,
      'Some assignees cannot access this warehouse',
      { userIds: outside },
    );
};

const replaceAssignees = async (
  trx: Trx,
  actor: Actor,
  taskId: string,
  userIds: string[],
): Promise<void> => {
  await trx.deleteFrom('audit_task_assignees').where('task_id', '=', taskId).execute();
  if (userIds.length > 0)
    await trx
      .insertInto('audit_task_assignees')
      .values(
        userIds.map((user_id) => ({
          task_id: taskId,
          user_id,
          company_id: actor.companyId,
          created_by: actor.userId,
        })),
      )
      .execute();
};

const view = async (trx: Trx, row: Row): Promise<TaskView> =>
  toView(row, (await assigneesOf(trx, [row.id])).get(row.id) ?? []);

export const createTask = (
  deps: TaskDeps,
  actor: Actor,
  input: CreateTaskInput,
): Promise<TaskView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const scope = await scopeOf(trx, actor.userId);
    const warehouse = await trx
      .selectFrom('warehouses')
      .select(['id', 'active'])
      .where('id', '=', input.warehouseId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    // مستودع خارج النطاق أو غير موجود: 404 كما في بقية المسارات. Outside scope or missing: 404, like everywhere else.
    if (!warehouse || (scope && !scope.includes(warehouse.id)))
      throw new AppError('NOT_FOUND', 404, 'Warehouse not found');
    if (!warehouse.active)
      throw new AppError('WAREHOUSE_INACTIVE', 422, 'The warehouse is inactive');
    await validateAssignees(trx, warehouse.id, input.assigneeIds);

    // عدّاد ذرّي لكل شركة: لا يتكرر الرقم تحت التزامن. An atomic per-company counter: the number never repeats under concurrency.
    const counter = await trx
      .insertInto('audit_task_counters')
      .values({ company_id: actor.companyId, last_no: 1 })
      .onConflict((oc) =>
        oc
          .column('company_id')
          .doUpdateSet({ last_no: sql<number>`audit_task_counters.last_no + 1` }),
      )
      .returning('last_no')
      .executeTakeFirstOrThrow();

    const id = newId();
    await trx
      .insertInto('audit_tasks')
      .values({
        id,
        company_id: actor.companyId,
        task_no: counter.last_no,
        title: input.title,
        warehouse_id: warehouse.id,
        starts_at: input.startsAt ? new Date(input.startsAt) : null,
        blind_count: input.blindCount,
        aggregate_locations: input.aggregateLocations,
        notes: input.notes ?? null,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .execute();
    await replaceAssignees(trx, actor, id, input.assigneeIds);
    return view(trx, await loadVisible(trx, actor, id, true));
  });

export const listTasks = (
  deps: TaskDeps,
  actor: Actor,
  query: TaskListQuery,
  seeAll: boolean,
): Promise<{ data: TaskView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const scope = await scopeOf(trx, actor.userId);
    let q = baseSelect(trx);
    if (scope) q = q.where('t.warehouse_id', 'in', scope);
    if (!seeAll)
      q = q.where(
        't.id',
        'in',
        trx
          .selectFrom('audit_task_assignees')
          .select('task_id')
          .where('user_id', '=', actor.userId),
      );
    if (query.status) q = q.where('t.status', '=', query.status);
    if (query.warehouseId) q = q.where('t.warehouse_id', '=', query.warehouseId);
    if (query.q) {
      const like = `%${escapeLike(query.q.toLowerCase())}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`lower(t.title)`, 'like', like),
          eb(sql<string>`t.task_no::text`, '=', query.q as string),
        ]),
      );
    }
    const total = Number(
      (
        await q
          .clearSelect()
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
    const col = { taskNo: 't.task_no', startsAt: 't.starts_at', createdAt: 't.created_at' }[
      query.sort
    ] as 't.task_no' | 't.starts_at' | 't.created_at';
    const rows = await q
      .orderBy(col, (ob) => (query.dir === 'asc' ? ob.asc().nullsLast() : ob.desc().nullsLast()))
      .orderBy('t.id')
      .limit(query.pageSize)
      .offset(offsetOf(query.page, query.pageSize))
      .execute();
    const assignees = await assigneesOf(
      trx,
      rows.map((r) => r.id),
    );
    return {
      data: rows.map((r) => toView(r as Row, assignees.get(r.id) ?? [])),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  });

export const getTask = (
  deps: TaskDeps,
  actor: Actor,
  id: string,
  seeAll: boolean,
): Promise<TaskView> =>
  withTenant(deps.db, actor, async ({ trx }) =>
    view(trx, await loadVisible(trx, actor, id, seeAll)),
  );

const versionConflict = (currentVersion: number): AppError =>
  new AppError('VERSION_CONFLICT', 409, 'The task was changed by someone else', { currentVersion });

export const updateTask = (
  deps: TaskDeps,
  actor: Actor,
  id: string,
  input: UpdateTaskInput,
): Promise<TaskView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const current = await loadVisible(trx, actor, id, true);
    if (current.version !== input.version) throw versionConflict(current.version);
    if (!isEditable(current.status))
      throw new AppError('TASK_NOT_EDITABLE', 409, 'Only a draft task can be edited', {
        status: current.status,
      });
    if (input.assigneeIds) await validateAssignees(trx, current.warehouse_id, input.assigneeIds);

    const updated = await trx
      .updateTable('audit_tasks')
      .set((eb) => ({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.startsAt !== undefined
          ? { starts_at: input.startsAt ? new Date(input.startsAt) : null }
          : {}),
        ...(input.blindCount !== undefined ? { blind_count: input.blindCount } : {}),
        ...(input.aggregateLocations !== undefined
          ? { aggregate_locations: input.aggregateLocations }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        version: eb('version', '+', 1),
        updated_at: new Date(),
        updated_by: actor.userId,
      }))
      .where('id', '=', id)
      .where('version', '=', input.version)
      // نفس الشرط في الكتابة: لا تعديل لمهمة بدأت بين القراءة والكتابة. Same guard on write: no edit of a task that started in between.
      .where('status', '=', 'draft')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw versionConflict(current.version);
    if (input.assigneeIds) await replaceAssignees(trx, actor, id, input.assigneeIds);
    return view(trx, await loadVisible(trx, actor, id, true));
  });

const transition = (
  deps: TaskDeps,
  actor: Actor,
  id: string,
  to: Extract<TaskStatus, 'in_progress' | 'cancelled'>,
  version: number,
): Promise<TaskView> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const current = await loadVisible(trx, actor, id, true);
    if (current.version !== version) throw versionConflict(current.version);
    if (!canTransition(current.status, to))
      throw new AppError(
        'INVALID_TRANSITION',
        409,
        `A ${current.status} task cannot become ${to}`,
        {
          from: current.status,
          to,
        },
      );
    if (to === 'in_progress') {
      const n = Number(
        (
          await trx
            .selectFrom('audit_task_assignees')
            .select(sql<string>`count(*)`.as('n'))
            .where('task_id', '=', id)
            .executeTakeFirstOrThrow()
        ).n,
      );
      if (n === 0)
        throw new AppError('NO_ASSIGNEES', 422, 'Assign at least one employee before starting');
    }
    const now = new Date();
    const updated = await trx
      .updateTable('audit_tasks')
      .set((eb) => ({
        status: to,
        ...(to === 'in_progress' ? { started_at: now } : { cancelled_at: now }),
        version: eb('version', '+', 1),
        updated_at: now,
        updated_by: actor.userId,
      }))
      .where('id', '=', id)
      .where('version', '=', version)
      .where('status', '=', current.status)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw versionConflict(current.version);
    return view(trx, await loadVisible(trx, actor, id, true));
  });

export const startTask = (deps: TaskDeps, actor: Actor, id: string, version: number) =>
  transition(deps, actor, id, 'in_progress', version);
export const cancelTask = (deps: TaskDeps, actor: Actor, id: string, version: number) =>
  transition(deps, actor, id, 'cancelled', version);
