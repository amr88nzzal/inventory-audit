import { createHash } from 'node:crypto';
import type { CloseTaskInput } from '@inventory/shared';
import { withTenant } from '../../db';
import { AppError } from '../../errors';
import { liveReport } from './results';
import { loadVisible, view } from './service';
import type { Actor, TaskDeps, TaskView } from './service';

export interface CloseOutcome {
  task: TaskView;
  replayed: boolean;
}

const hashOf = (taskId: string, input: CloseTaskInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        taskId,
        version: input.version,
        ack: input.acknowledgeFlagged,
        note: input.note ?? null,
      }),
    )
    .digest('hex');

// إغلاق المهمة: يجمّد النتيجة النهائية في جداول للإضافة فقط ويغلق المسح. ذرّي في معاملة واحدة.
// Close the task: freezes the final result into append-only tables and stops scanning. Atomic in one transaction.
export const closeTask = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  input: CloseTaskInput,
  idempotencyKey: string,
): Promise<CloseOutcome> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const requestHash = hashOf(taskId, input);
    // الإعادة بنفس المفتاح والطلب ترجع النتيجة المخزَّنة؛ نفس المفتاح بطلب مختلف خطأ.
    // Replaying the same key and request returns the stored response; the same key with a different request is an error.
    const prev = await trx
      .selectFrom('idempotency_keys')
      .select(['request_hash', 'response'])
      .where('user_id', '=', actor.userId)
      .where('key', '=', idempotencyKey)
      .executeTakeFirst();
    if (prev) {
      if (prev.request_hash !== requestHash)
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          422,
          'This idempotency key was used for a different request',
        );
      return { task: prev.response as TaskView, replayed: true };
    }

    const task = await loadVisible(trx, actor, taskId, true);
    if (task.version !== input.version)
      throw new AppError('VERSION_CONFLICT', 409, 'The task was changed by someone else', {
        currentVersion: task.version,
      });
    if (task.status !== 'in_progress')
      throw new AppError('INVALID_TRANSITION', 409, `A ${task.status} task cannot be closed`, {
        from: task.status,
        to: 'closed',
      });

    const report = await liveReport(trx, task, '0');
    if (report.summary.flagged > 0 && !input.acknowledgeFlagged)
      throw new AppError(
        'UNRESOLVED_VARIANCES',
        409,
        'Some items are outside tolerance; acknowledge them to close',
        { flagged: report.summary.flagged },
      );

    if (report.rows.length > 0)
      for (let i = 0; i < report.rows.length; i += 500)
        await trx
          .insertInto('audit_task_results')
          .values(
            report.rows.slice(i, i + 500).map((r) => ({
              task_id: taskId,
              item_id: r.itemId,
              company_id: actor.companyId,
              counted: r.counted,
              theoretical: r.theoretical,
              difference: r.difference,
              difference_pct: r.differencePct,
              status: r.status,
              applied_tolerance_pct: r.appliedTolerancePct,
              flagged_for_recount: r.flaggedForRecount,
              locations: r.locations ? JSON.stringify(r.locations) : null,
            })),
          )
          .execute();
    if (report.unknown.length > 0)
      await trx
        .insertInto('audit_task_unknown')
        .values(
          report.unknown.map((u) => ({
            task_id: taskId,
            barcode: u.barcode,
            company_id: actor.companyId,
            quantity: u.quantity,
            records: u.records,
          })),
        )
        .execute();

    const now = new Date();
    const updated = await trx
      .updateTable('audit_tasks')
      .set((eb) => ({
        status: 'closed' as const,
        closed_at: now,
        closed_by: actor.userId,
        closing_note: input.note ?? null,
        version: eb('version', '+', 1),
        updated_at: now,
        updated_by: actor.userId,
      }))
      .where('id', '=', taskId)
      .where('version', '=', input.version)
      .where('status', '=', 'in_progress')
      .returning('id')
      .executeTakeFirst();
    if (!updated)
      throw new AppError('VERSION_CONFLICT', 409, 'The task was changed by someone else', {
        currentVersion: task.version + 1,
      });

    const closed = await view(trx, await loadVisible(trx, actor, taskId, true));
    await trx
      .insertInto('idempotency_keys')
      .values({
        company_id: actor.companyId,
        user_id: actor.userId,
        key: idempotencyKey,
        request_hash: requestHash,
        response: JSON.stringify(closed),
      })
      .execute();
    return { task: closed, replayed: false };
  });
