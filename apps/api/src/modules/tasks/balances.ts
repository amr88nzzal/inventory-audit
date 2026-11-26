import {
  IMPORT_ERRORS_CAP,
  escapeLike,
  normalizeSearch,
  offsetOf,
  pageMeta,
  parseBalancesCsv,
} from '@inventory/shared';
import type { ImportRowError, PageMeta } from '@inventory/shared';
import { sql } from 'kysely';
import { withTenant } from '../../db';
import { AppError } from '../../errors';
import { isEditable } from '@inventory/shared';
import { loadVisible } from './service';
import type { Actor, TaskDeps } from './service';

export interface BalancesReport {
  mode: 'preview' | 'apply';
  totalRows: number;
  // صفوف ستُكتب (أو كُتبت) في اللقطة. Rows that will be (or were) written to the snapshot.
  validRows: number;
  skipped: number;
  errorsTotal: number;
  errors: ImportRowError[];
  errorsTruncated: boolean;
  ignoredColumns: string[];
}

export interface BalanceView {
  itemId: string;
  barcode: string;
  name: string;
  baseUnit: string;
  quantity: string;
}

const CHUNK = 1000;
const chunks = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

// رفع لقطة الرصيد: تستبدل اللقطة السابقة كاملة، والمهمة مسودة فقط (بعد البدء تُجمَّد).
// الباركود المجهول خطأ في سطره، لا يُنشئ صنفاً بصمت.
// Uploading a snapshot replaces the previous one wholesale, draft tasks only (frozen after start).
// An unknown barcode is an error on its line; it never silently creates an item.
export const uploadBalances = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  csv: string,
  opts: { mode: 'preview' | 'apply'; skipInvalid: boolean },
): Promise<BalancesReport> => {
  const parsed = parseBalancesCsv(csv);
  return withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, true);
    if (!isEditable(task.status))
      throw new AppError(
        'TASK_NOT_EDITABLE',
        409,
        'Balances can only be uploaded to a draft task',
        {
          status: task.status,
        },
      );

    const itemOf = new Map<string, string>();
    for (const part of chunks(parsed.rows.map((r) => r.barcode))) {
      const found = await trx
        .selectFrom('items')
        .select(['id', 'barcode'])
        .where('barcode', 'in', part)
        .where('deleted_at', 'is', null)
        .execute();
      for (const f of found) itemOf.set(f.barcode, f.id);
    }
    const dbErrors: ImportRowError[] = [];
    const good: { itemId: string; quantity: string }[] = [];
    for (const r of parsed.rows) {
      const itemId = itemOf.get(r.barcode);
      if (!itemId)
        dbErrors.push({
          line: r.line,
          field: null,
          code: 'ITEM_NOT_FOUND',
          message: 'No item has this barcode',
        });
      else good.push({ itemId, quantity: r.quantity });
    }
    const all = [...parsed.errors, ...dbErrors].sort((a, b) => a.line - b.line);
    const report: BalancesReport = {
      mode: opts.mode,
      totalRows: parsed.totalRows,
      validRows: good.length,
      skipped: opts.skipInvalid ? all.length : 0,
      errorsTotal: all.length,
      errors: all.slice(0, IMPORT_ERRORS_CAP),
      errorsTruncated: all.length > IMPORT_ERRORS_CAP,
      ignoredColumns: parsed.ignoredColumns,
    };
    if (opts.mode === 'preview') return report;
    if (all.length > 0 && !opts.skipInvalid)
      throw new AppError('IMPORT_INVALID', 422, 'The file has invalid rows; nothing was imported', {
        ...report,
        validRows: 0,
      });
    if (good.length === 0)
      throw new AppError('IMPORT_EMPTY', 422, 'No valid rows to import', report);

    await trx.deleteFrom('audit_task_balances').where('task_id', '=', taskId).execute();
    for (const part of chunks(good))
      await trx
        .insertInto('audit_task_balances')
        .values(
          part.map((g) => ({
            task_id: taskId,
            item_id: g.itemId,
            company_id: actor.companyId,
            quantity: g.quantity,
          })),
        )
        .execute();
    await trx
      .updateTable('audit_tasks')
      .set((eb) => ({
        balances_count: good.length,
        balances_uploaded_at: new Date(),
        balances_uploaded_by: actor.userId,
        version: eb('version', '+', 1),
        updated_at: new Date(),
        updated_by: actor.userId,
      }))
      .where('id', '=', taskId)
      .where('status', '=', 'draft')
      .execute();
    return report;
  });
};

const pad = (n: number): number => Math.max(1, n);

// العد الأعمى: من لا يملك read_all لا يرى الرصيد النظري إطلاقاً (403)، حتى لو كانت المهمة له.
// Blind count: without read_all you never see the theoretical balance (403), even for your own task.
export const listBalances = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  seeAll: boolean,
  query: { q?: string | undefined; page: number; pageSize: number },
): Promise<{ data: BalanceView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, seeAll);
    if (task.blind_count && !seeAll)
      throw new AppError('BLIND_COUNT', 403, 'This task hides the system balance');
    let q = trx
      .selectFrom('audit_task_balances as b')
      .innerJoin('items as i', 'i.id', 'b.item_id')
      .where('b.task_id', '=', taskId);
    if (query.q) {
      const like = `%${escapeLike(normalizeSearch(query.q))}%`;
      q = q.where((eb) =>
        eb.or([
          eb('i.search_text', 'like', like),
          eb('i.barcode', 'like', `%${escapeLike(query.q as string)}%`),
        ]),
      );
    }
    const total = Number(
      (await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).n,
    );
    const rows = await q
      .select(['i.id as item_id', 'i.barcode', 'i.name', 'i.base_unit', 'b.quantity'])
      .orderBy('i.barcode')
      .limit(query.pageSize)
      .offset(offsetOf(pad(query.page), query.pageSize))
      .execute();
    return {
      data: rows.map((r) => ({
        itemId: r.item_id,
        barcode: r.barcode,
        name: r.name,
        baseUnit: r.base_unit,
        quantity: r.quantity,
      })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  });
