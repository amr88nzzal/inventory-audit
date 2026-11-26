import { buildVarianceReport, normalizeSearch, offsetOf, pageMeta } from '@inventory/shared';
import type { PageMeta, ReportRow, ReportSummary, TaskResultsQuery } from '@inventory/shared';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { withTenant } from '../../db';
import { loadVisible } from './service';
import type { Actor, TaskDeps, Trx } from './service';

export interface ResultRowView extends ReportRow {
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
  summary: ReportSummary & { unknownBarcodes: number; unknownQuantity: string };
}

// العدّات السارية: سجلات count التي لم يلغها سجل void، مجمّعة حسب الصنف والموقع في قاعدة البيانات.
// Effective counts: count records not voided, grouped by item and location inside the database.
const effectiveCounts = (trx: Trx, taskId: string) =>
  trx
    .selectFrom('audit_records as r')
    .select(['r.item_id', 'r.location_id', sql<string>`sum(r.base_quantity)`.as('quantity')])
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
    .groupBy(['r.item_id', 'r.location_id']);

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

// نتائج الجرد: الفرق لكل صنف مقابل لقطة الرصيد. للمشرفين (read_all) فقط، فلا تكشف الرصيد في العد الأعمى.
// Count results: per-item variance against the balance snapshot. Supervisors (read_all) only, so a blind count never leaks the balance.
export const taskResults = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  query: TaskResultsQuery,
): Promise<{ data: ResultRowView[]; meta: ResultsMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    const task = await loadVisible(trx, actor, taskId, true);
    const counted = (await effectiveCounts(trx, taskId).execute()).map((r) => ({
      itemId: r.item_id as string,
      locationId: r.location_id,
      quantity: r.quantity,
    }));
    const theoretical = (
      await trx
        .selectFrom('audit_task_balances')
        .select(['item_id', 'quantity'])
        .where('task_id', '=', taskId)
        .execute()
    ).map((r) => ({ itemId: r.item_id, quantity: r.quantity }));
    const ids = [
      ...new Set([...counted.map((c) => c.itemId), ...theoretical.map((t) => t.itemId)]),
    ];
    const info = new Map<
      string,
      {
        barcode: string;
        name: string;
        base_unit: string;
        tolerance_pct: string | null;
        search_text: string;
      }
    >();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await trx
        .selectFrom('items')
        .select(['id', 'barcode', 'name', 'base_unit', 'tolerance_pct', 'search_text'])
        .where('id', 'in', ids.slice(i, i + 1000))
        .execute();
      for (const r of rows) info.set(r.id, r);
    }
    const itemTolerances: Record<string, string | null> = {};
    for (const [id, r] of info) itemTolerances[id] = r.tolerance_pct;
    const report = buildVarianceReport({
      counted,
      theoretical,
      itemTolerances,
      defaultTolerancePct: query.tolerancePct,
      aggregateLocations: task.aggregate_locations,
    });
    const unknown = await unknownRows(trx, taskId);

    let rows: ResultRowView[] = report.rows.map((r) => {
      const i = info.get(r.itemId);
      return { ...r, barcode: i?.barcode ?? '', name: i?.name ?? '', baseUnit: i?.base_unit ?? '' };
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
        summary: {
          ...report.summary,
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
    await loadVisible(trx, actor, taskId, true);
    const all = await unknownRows(trx, taskId);
    const start = offsetOf(query.page, query.pageSize);
    return {
      data: all.slice(start, start + query.pageSize),
      meta: pageMeta(query.page, query.pageSize, all.length),
    };
  });
