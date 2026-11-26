import { buildVarianceReport, normalizeSearch, offsetOf, pageMeta } from '@inventory/shared';
import type { PageMeta, ReportRow, ReportSummary, TaskResultsQuery } from '@inventory/shared';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { withTenant } from '../../db';
import { loadVisible } from './service';
import type { Actor, TaskDeps, Trx } from './service';

export interface ResultRowView extends ReportRow {
  round: number;
  recountPending: boolean;
  barcode: string;
  name: string;
  baseUnit: string;
}
export interface UnknownView {
  barcode: string;
  quantity: string;
  records: number;
}
export interface ResultsMeta extends PageMeta {
  frozen: boolean;
  summary: ReportSummary & {
    unknownBarcodes: number;
    unknownQuantity: string;
    recountPending: number;
  };
}

// العدّات السارية: سجلات count التي لم يلغها سجل void، مجمّعة حسب الصنف والموقع في قاعدة البيانات.
// Effective counts: count records not voided, grouped by item and location inside the database.
const effectiveCounts = (trx: Trx, taskId: string) =>
  trx
    .selectFrom('audit_records as r')
    .select([
      'r.item_id',
      'r.location_id',
      sql<string>`sum(r.base_quantity)`.as('quantity'),
      sql<number>`max(r.round)`.as('round'),
    ])
    .where('r.task_id', '=', taskId)
    .where('r.kind', '=', 'count')
    .where('r.item_id', 'is not', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('audit_records as v').select('v.id').whereRef('v.voids_id', '=', 'r.id'),
        ),
      ),
    )
    // الجولة السارية للصنف = أعلى جولة فيها عدّ غير ملغى؛ ما قبلها يبقى محفوظاً ولا يُحسب.
    // The effective round of an item is the highest round holding a non-voided count; earlier rounds stay stored but are not counted.
    .where(
      sql<boolean>`r.round = (
        select max(r2.round) from audit_records r2
        where r2.task_id = r.task_id and r2.item_id = r.item_id and r2.kind = 'count'
          and not exists (select 1 from audit_records v2 where v2.voids_id = r2.id)
      )`,
    )
    .groupBy(['r.item_id', 'r.location_id']);

// أصناف طُلبت إعادة عدّها ولم يصل عدّ الجولة الجديدة بعد. Items with a recount requested whose new-round count has not arrived yet.
export const pendingRecounts = async (trx: Trx, taskId: string): Promise<Set<string>> => {
  const rows = await sql<{ item_id: string }>`
    select distinct rc.item_id from audit_recounts rc
    where rc.task_id = ${taskId}
      and rc.round = (select max(x.round) from audit_recounts x where x.task_id = rc.task_id and x.item_id = rc.item_id)
      and not exists (
        select 1 from audit_records r
        where r.task_id = rc.task_id and r.item_id = rc.item_id and r.kind = 'count' and r.round = rc.round
          and not exists (select 1 from audit_records v where v.voids_id = r.id)
      )`.execute(trx);
  return new Set(rows.rows.map((r) => r.item_id));
};

const unknownRows = async (trx: Trx, taskId: string): Promise<UnknownView[]> => {
  const rows = await trx
    .selectFrom('audit_records as r')
    .select([
      'r.barcode',
      sql<string>`sum(r.quantity)`.as('quantity'),
      sql<string>`count(*)`.as('records'),
    ])
    .where('r.task_id', '=', taskId)
    .where('r.kind', '=', 'count')
    .where('r.item_id', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('audit_records as v').select('v.id').whereRef('v.voids_id', '=', 'r.id'),
        ),
      ),
    )
    .groupBy('r.barcode')
    .orderBy('r.barcode')
    .execute();
  return rows.map((r) => ({
    barcode: r.barcode as string,
    quantity: new Decimal(r.quantity).toFixed(),
    records: Number(r.records),
  }));
};

export interface Report {
  rows: ReportRow[];
  summary: ReportSummary;
  unknown: UnknownView[];
  info: Map<string, ItemInfo>;
  rounds: Map<string, number>;
  pending: Set<string>;
  // true = نتيجة مجمَّدة عند الإغلاق. true = the result frozen at close.
  frozen: boolean;
}
interface ItemInfo {
  barcode: string;
  name: string;
  base_unit: string;
  tolerance_pct: string | null;
  search_text: string;
}

const loadInfo = async (
  trx: Trx,
  ids: string[],
): Promise<Map<string, ItemInfo & { id: string }>> => {
  const info = new Map<string, ItemInfo & { id: string }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await trx
      .selectFrom('items')
      .select(['id', 'barcode', 'name', 'base_unit', 'tolerance_pct', 'search_text'])
      .where('id', 'in', ids.slice(i, i + 1000))
      .execute();
    for (const r of rows) info.set(r.id, r);
  }
  return info;
};

// الحساب الحيّ من السجلات ولقطة الرصيد. Live calculation from the records and the balance snapshot.
export const liveReport = async (
  trx: Trx,
  task: { id: string; aggregate_locations: boolean; tolerance_pct: string | null },
  defaultTolerancePct: string,
): Promise<Report> => {
  const countedRows = await effectiveCounts(trx, task.id).execute();
  const rounds = new Map<string, number>();
  for (const r of countedRows) rounds.set(r.item_id as string, Number(r.round));
  const counted = countedRows.map((r) => ({
    itemId: r.item_id as string,
    locationId: r.location_id,
    quantity: r.quantity,
  }));
  const theoretical = (
    await trx
      .selectFrom('audit_task_balances')
      .select(['item_id', 'quantity'])
      .where('task_id', '=', task.id)
      .execute()
  ).map((r) => ({ itemId: r.item_id, quantity: r.quantity }));
  const ids = [...new Set([...counted.map((c) => c.itemId), ...theoretical.map((t) => t.itemId)])];
  const info = await loadInfo(trx, ids);
  const itemTolerances: Record<string, string | null> = {};
  for (const [id, r] of info) itemTolerances[id] = r.tolerance_pct;
  const report = buildVarianceReport({
    counted,
    theoretical,
    itemTolerances,
    taskTolerancePct: task.tolerance_pct,
    defaultTolerancePct,
    aggregateLocations: task.aggregate_locations,
  });
  return {
    ...report,
    unknown: await unknownRows(trx, task.id),
    info,
    rounds,
    pending: await pendingRecounts(trx, task.id),
    frozen: false,
  };
};

// النتيجة المجمَّدة بعد الإغلاق: لا تتأثر بأي تعديل لاحق. The frozen result after close: unaffected by any later edit.
export const frozenReport = async (trx: Trx, taskId: string): Promise<Report> => {
  const stored = await trx
    .selectFrom('audit_task_results')
    .selectAll()
    .where('task_id', '=', taskId)
    .execute();
  const rows: ReportRow[] = stored.map((r) => ({
    itemId: r.item_id,
    counted: new Decimal(r.counted).toFixed(),
    theoretical: new Decimal(r.theoretical).toFixed(),
    difference: new Decimal(r.difference).toFixed(),
    differencePct: r.difference_pct === null ? null : new Decimal(r.difference_pct).toFixed(),
    status: r.status,
    appliedTolerancePct: new Decimal(r.applied_tolerance_pct).toFixed(),
    flaggedForRecount: r.flagged_for_recount,
    ...(r.locations ? { locations: r.locations } : {}),
  }));
  const summary: ReportSummary = {
    items: rows.length,
    matched: rows.filter((r) => r.status === 'match').length,
    over: rows.filter((r) => r.status === 'over').length,
    short: rows.filter((r) => r.status === 'short').length,
    flagged: rows.filter((r) => r.flaggedForRecount).length,
    totalCounted: rows.reduce((a, r) => a.plus(r.counted), new Decimal(0)).toFixed(),
    totalTheoretical: rows.reduce((a, r) => a.plus(r.theoretical), new Decimal(0)).toFixed(),
    totalDifference: rows.reduce((a, r) => a.plus(r.difference), new Decimal(0)).toFixed(),
  };
  const unknown = (
    await trx
      .selectFrom('audit_task_unknown')
      .select(['barcode', 'quantity', 'records'])
      .where('task_id', '=', taskId)
      .orderBy('barcode')
      .execute()
  ).map((u) => ({
    barcode: u.barcode,
    quantity: new Decimal(u.quantity).toFixed(),
    records: u.records,
  }));
  return {
    rows,
    summary,
    unknown,
    info: await loadInfo(
      trx,
      rows.map((r) => r.itemId),
    ),
    rounds: new Map(stored.map((r) => [r.item_id, r.round])),
    pending: new Set<string>(),
    frozen: true,
  };
};

// نتائج الجرد: الفرق لكل صنف مقابل لقطة الرصيد. للمشرفين (read_all) فقط، فلا تكشف الرصيد في العد الأعمى.
// بعد الإغلاق تُقرأ النتيجة المجمَّدة. Count results: per-item variance against the balance snapshot. Supervisors (read_all) only,
// so a blind count never leaks the balance. After close the frozen result is read.
export const taskResults = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  query: TaskResultsQuery,
): Promise<{ data: ResultRowView[]; meta: ResultsMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, true);
    const report =
      task.status === 'closed'
        ? await frozenReport(trx, taskId)
        : await liveReport(trx, task, query.tolerancePct);
    const { info, unknown } = report;

    let rows: ResultRowView[] = report.rows.map((r) => {
      const i = info.get(r.itemId);
      return {
        ...r,
        round: report.rounds.get(r.itemId) ?? 1,
        recountPending: report.pending.has(r.itemId),
        barcode: i?.barcode ?? '',
        name: i?.name ?? '',
        baseUnit: i?.base_unit ?? '',
      };
    });
    if (query.filter === 'flagged') rows = rows.filter((r) => r.flaggedForRecount);
    else if (query.filter !== 'all') rows = rows.filter((r) => r.status === query.filter);
    if (query.q) {
      const needle = normalizeSearch(query.q);
      rows = rows.filter(
        (r) =>
          (info.get(r.itemId)?.search_text ?? '').includes(needle) ||
          r.barcode.includes(query.q as string),
      );
    }
    if (query.sort === 'difference')
      rows.sort(
        (a, b) =>
          new Decimal(b.difference).abs().comparedTo(new Decimal(a.difference).abs()) ||
          a.name.localeCompare(b.name) ||
          a.itemId.localeCompare(b.itemId),
      );
    else if (query.sort === 'name')
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
    else
      rows.sort((a, b) => a.barcode.localeCompare(b.barcode) || a.itemId.localeCompare(b.itemId));

    const start = offsetOf(query.page, query.pageSize);
    const unknownQty = unknown.reduce((s, u) => s.plus(u.quantity), new Decimal(0));
    return {
      data: rows.slice(start, start + query.pageSize),
      meta: {
        ...pageMeta(query.page, query.pageSize, rows.length),
        frozen: report.frozen,
        summary: {
          ...report.summary,
          recountPending: report.pending.size,
          unknownBarcodes: unknown.length,
          unknownQuantity: unknownQty.toFixed(),
        },
      },
    };
  });

export const unknownBarcodes = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  query: { page: number; pageSize: number },
): Promise<{ data: UnknownView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, true);
    const all =
      task.status === 'closed'
        ? (await frozenReport(trx, taskId)).unknown
        : await unknownRows(trx, taskId);
    const start = offsetOf(query.page, query.pageSize);
    return {
      data: all.slice(start, start + query.pageSize),
      meta: pageMeta(query.page, query.pageSize, all.length),
    };
  });
