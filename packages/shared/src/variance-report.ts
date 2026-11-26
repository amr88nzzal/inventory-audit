import Decimal from 'decimal.js';
import { computeVariance } from './variance';

// تجميع فروقات المهمة: يجمع العدّات حسب الصنف ويقارنها بلقطة الرصيد، ثم يستعمل `computeVariance` لكل صنف
// (أولوية التفاوت: الصنف ثم المهمة ثم الافتراضي). دوال نقية بنصوص عشرية، والكميات بالوحدة الأساسية.
// Task variance roll-up: sums counts per item, compares with the balance snapshot, then runs `computeVariance`
// per item (tolerance priority: item, task, default). Pure functions over decimal strings, quantities in the base unit.

export interface CountedLine {
  itemId: string;
  // null = عدّ بلا موقع. null = counted without a location.
  locationId: string | null;
  quantity: string;
}
export interface TheoreticalLine {
  itemId: string;
  quantity: string;
}
export type VarianceStatus = 'match' | 'over' | 'short';

export interface ReportRow {
  itemId: string;
  counted: string;
  theoretical: string;
  difference: string;
  // null حين النظري صفر والمعدود لا. null when theoretical is 0 and counted is not.
  differencePct: string | null;
  status: VarianceStatus;
  appliedTolerancePct: string;
  flaggedForRecount: boolean;
  // تفصيل المواقع عند تعطيل التجميع. Per-location breakdown when aggregation is off.
  locations?: { locationId: string | null; counted: string }[];
}

export interface ReportSummary {
  items: number;
  matched: number;
  over: number;
  short: number;
  flagged: number;
  totalCounted: string;
  totalTheoretical: string;
  totalDifference: string;
}

export interface ReportInput {
  counted: readonly CountedLine[];
  theoretical: readonly TheoreticalLine[];
  // تفاوت الصنف (نص عشري أو null). Per-item tolerance (decimal string or null).
  itemTolerances: Readonly<Record<string, string | null | undefined>>;
  taskTolerancePct?: string | null;
  defaultTolerancePct: string;
  // true = بلا تفصيل مواقع. true = no location breakdown.
  aggregateLocations: boolean;
}

/**
 * الفرق على مستوى الصنف دائماً (الرصيد النظري لا يعرف المواقع). صنف خارج اللقطة نظريه صفر،
 * وصنف في اللقطة لم يُعدّ معدوده صفر (نقص كامل).
 * Variance is always per item (the theoretical balance knows no locations). An item absent from the snapshot
 * has theoretical 0; a snapshot item never counted has counted 0 (a full shortage).
 */
export const buildVarianceReport = (
  input: ReportInput,
): { rows: ReportRow[]; summary: ReportSummary } => {
  const counted = new Map<string, Decimal>();
  const perLocation = new Map<string, Map<string | null, Decimal>>();
  for (const c of input.counted) {
    const q = new Decimal(c.quantity);
    counted.set(c.itemId, (counted.get(c.itemId) ?? new Decimal(0)).plus(q));
    const m = perLocation.get(c.itemId) ?? new Map<string | null, Decimal>();
    m.set(c.locationId, (m.get(c.locationId) ?? new Decimal(0)).plus(q));
    perLocation.set(c.itemId, m);
  }
  const theo = new Map<string, Decimal>();
  for (const t of input.theoretical)
    theo.set(t.itemId, (theo.get(t.itemId) ?? new Decimal(0)).plus(new Decimal(t.quantity)));

  const rows: ReportRow[] = [];
  let totalC = new Decimal(0);
  let totalT = new Decimal(0);
  const summary: ReportSummary = {
    items: 0,
    matched: 0,
    over: 0,
    short: 0,
    flagged: 0,
    totalCounted: '0',
    totalTheoretical: '0',
    totalDifference: '0',
  };
  for (const itemId of [...new Set([...counted.keys(), ...theo.keys()])].sort()) {
    const c = counted.get(itemId) ?? new Decimal(0);
    const t = theo.get(itemId) ?? new Decimal(0);
    const v = computeVariance({
      systemQty: t.toFixed(),
      countedQty: c.toFixed(),
      itemTolerancePct: input.itemTolerances[itemId] ?? null,
      taskTolerancePct: input.taskTolerancePct ?? null,
      defaultTolerancePct: input.defaultTolerancePct,
    });
    const diff = new Decimal(v.varianceQty);
    const status: VarianceStatus = diff.isZero() ? 'match' : diff.gt(0) ? 'over' : 'short';
    const row: ReportRow = {
      itemId,
      counted: c.toFixed(),
      theoretical: t.toFixed(),
      difference: diff.toFixed(),
      differencePct: v.variancePct,
      status,
      appliedTolerancePct: v.appliedTolerancePct,
      flaggedForRecount: v.flaggedForRecount,
    };
    if (!input.aggregateLocations)
      row.locations = [...(perLocation.get(itemId) ?? new Map<string | null, Decimal>())]
        .map(([locationId, q]) => ({ locationId, counted: q.toFixed() }))
        .sort((a, b) => (a.locationId ?? '').localeCompare(b.locationId ?? ''));
    rows.push(row);
    totalC = totalC.plus(c);
    totalT = totalT.plus(t);
    summary.items += 1;
    if (status === 'match') summary.matched += 1;
    else if (status === 'over') summary.over += 1;
    else summary.short += 1;
    if (row.flaggedForRecount) summary.flagged += 1;
  }
  summary.totalCounted = totalC.toFixed();
  summary.totalTheoretical = totalT.toFixed();
  summary.totalDifference = totalC.minus(totalT).toFixed();
  return { rows, summary };
};
