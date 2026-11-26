import { offsetOf, pageMeta } from '@inventory/shared';
import type { PageMeta, RecountRequestInput } from '@inventory/shared';
import { sql } from 'kysely';
import { newId, withTenant } from '../../db';
import { AppError } from '../../errors';
import { liveReport, pendingRecounts } from './results';
import { loadVisible } from './service';
import type { Actor, TaskDeps } from './service';

export interface RecountResult {
  itemId: string;
  status: 'created' | 'already_pending' | 'rejected';
  round?: number;
  code?: string;
}
export interface RecountView {
  id: string;
  itemId: string;
  barcode: string;
  name: string;
  round: number;
  assigneeId: string;
  assigneeName: string;
  requestedBy: string;
  reason: string | null;
  requestedAt: string;
  pending: boolean;
}
export interface MyRecountView {
  itemId: string;
  barcode: string;
  name: string;
  round: number;
}

// طلب إعادة عدّ: المراجع مسند للمهمة ولم يعدّ الصنف من قبل (مراجع ثانٍ فعلاً)، والمهمة جارية.
// Request a recount: the reviewer is assigned to the task and never counted the item before (a genuine second reviewer), and the task is running.
export const requestRecounts = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  input: RecountRequestInput,
): Promise<RecountResult[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, true);
    if (task.status !== 'in_progress')
      throw new AppError('TASK_NOT_RUNNING', 409, 'The task is not in progress', {
        status: task.status,
      });
    const assigned = await trx
      .selectFrom('audit_task_assignees')
      .select('user_id')
      .where('task_id', '=', taskId)
      .where('user_id', '=', input.assigneeId)
      .executeTakeFirst();
    if (!assigned)
      throw new AppError('INVALID_ASSIGNEE', 422, 'The reviewer must be assigned to the task');

    const report = await liveReport(trx, task, input.tolerancePct);
    const known = new Set(report.rows.map((r) => r.itemId));
    const wanted = input.flagged
      ? report.rows.filter((r) => r.flaggedForRecount).map((r) => r.itemId)
      : (input.itemIds as string[]);
    const pending = await pendingRecounts(trx, taskId);
    const results: RecountResult[] = [];
    for (const itemId of wanted) {
      if (!known.has(itemId)) {
        results.push({ itemId, status: 'rejected', code: 'ITEM_NOT_IN_TASK' });
        continue;
      }
      if (pending.has(itemId)) {
        results.push({ itemId, status: 'already_pending' });
        continue;
      }
      // من عدّ الصنف في أي جولة سابقة لا يكون مراجعه الثاني. Whoever counted the item in any earlier round cannot be its second reviewer.
      const counted = await trx
        .selectFrom('audit_records')
        .select('id')
        .where('task_id', '=', taskId)
        .where('item_id', '=', itemId)
        .where('user_id', '=', input.assigneeId)
        .where('kind', '=', 'count')
        .limit(1)
        .executeTakeFirst();
      if (counted) {
        results.push({ itemId, status: 'rejected', code: 'REVIEWER_COUNTED_BEFORE' });
        continue;
      }
      const last = await trx
        .selectFrom('audit_recounts')
        .select(sql<number>`max(round)`.as('round'))
        .where('task_id', '=', taskId)
        .where('item_id', '=', itemId)
        .executeTakeFirst();
      const round = (last?.round ? Number(last.round) : 1) + 1;
      await trx
        .insertInto('audit_recounts')
        .values({
          id: newId(),
          company_id: actor.companyId,
          task_id: taskId,
          item_id: itemId,
          round,
          assignee_id: input.assigneeId,
          requested_by: actor.userId,
          reason: input.reason ?? null,
        })
        .execute();
      results.push({ itemId, status: 'created', round });
    }
    return results;
  });

// سجل طلبات إعادة العدّ للمشرف. The recount request log for supervisors.
export const listRecounts = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  query: { page: number; pageSize: number },
): Promise<{ data: RecountView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadVisible(trx, actor, taskId, true);
    const pending = await pendingRecounts(trx, taskId);
    // أعلى جولة لكل صنف على مستوى المهمة كلها لا الصفحة فقط. The highest round per item across the whole task, not just this page.
    const latest = new Map(
      (
        await trx
          .selectFrom('audit_recounts')
          .select(['item_id', sql<number>`max(round)`.as('round')])
          .where('task_id', '=', taskId)
          .groupBy('item_id')
          .execute()
      ).map((r) => [r.item_id, Number(r.round)]),
    );
    const base = trx.selectFrom('audit_recounts as rc').where('rc.task_id', '=', taskId);
    const total = Number(
      (await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n,
    );
    const rows = await base
      .innerJoin('items as i', 'i.id', 'rc.item_id')
      .innerJoin('users as u', 'u.id', 'rc.assignee_id')
      .select([
        'rc.id',
        'rc.item_id',
        'i.barcode',
        'i.name',
        'rc.round',
        'rc.assignee_id',
        'u.display_name as assignee_name',
        'rc.requested_by',
        'rc.reason',
        'rc.requested_at',
      ])
      .orderBy('rc.requested_at', 'desc')
      .orderBy('rc.id', 'desc')
      .limit(query.pageSize)
      .offset(offsetOf(query.page, query.pageSize))
      .execute();
    return {
      data: rows.map((r) => ({
        id: r.id,
        itemId: r.item_id,
        barcode: r.barcode,
        name: r.name,
        round: r.round,
        assigneeId: r.assignee_id,
        assigneeName: r.assignee_name,
        requestedBy: r.requested_by,
        reason: r.reason,
        requestedAt: new Date(r.requested_at).toISOString(),
        // معلَّقة = أحدث جولة للصنف ولم يصلها عدّ. Pending = the item's latest round that has no count yet.
        pending: pending.has(r.item_id) && r.round === latest.get(r.item_id),
      })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  });

// ما يُطلب من هذا المراجع إعادة عدّه: بلا أي رصيد نظري أو عدّ سابق (آمن للعد الأعمى).
// What this reviewer is asked to recount: no theoretical balance and no earlier count (safe for blind counts).
export const myRecounts = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
): Promise<MyRecountView[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadVisible(trx, actor, taskId, false);
    const pending = await pendingRecounts(trx, taskId);
    const rows = await trx
      .selectFrom('audit_recounts as rc')
      .innerJoin('items as i', 'i.id', 'rc.item_id')
      .select(['rc.item_id', 'i.barcode', 'i.name', 'rc.round'])
      .where('rc.task_id', '=', taskId)
      .where('rc.assignee_id', '=', actor.userId)
      .orderBy('i.name')
      .execute();
    const latest = new Map<string, number>();
    for (const r of rows) latest.set(r.item_id, Math.max(latest.get(r.item_id) ?? 0, r.round));
    return rows
      .filter((r) => pending.has(r.item_id) && latest.get(r.item_id) === r.round)
      .map((r) => ({ itemId: r.item_id, barcode: r.barcode, name: r.name, round: r.round }));
  });
