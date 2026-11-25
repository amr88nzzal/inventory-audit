import { IMPORT_ERRORS_CAP, parseItemsCsv } from '@inventory/shared';
import type { ImportRow, ImportRowError } from '@inventory/shared';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { newId, withTenant } from '../../db';
import { AppError } from '../../errors';
import { searchTextOf } from './service';
import type { Actor, ItemDeps } from './service';

export interface ImportReport {
  mode: 'preview' | 'apply';
  totalRows: number;
  // صفوف صالحة ستُكتب (أو كُتبت). Valid rows that will be (or were) written.
  validRows: number;
  created: number;
  updated: number;
  // صفوف مطابقة تماماً لما هو مخزَّن فلم تُكتب. Rows identical to what is stored, so not written.
  unchanged: number;
  // صفوف أخطاؤها استُبعدت بـ skipInvalid. Rows with errors left out because of skipInvalid.
  skipped: number;
  errorsTotal: number;
  errors: ImportRowError[];
  errorsTruncated: boolean;
  ignoredColumns: string[];
}

const CHUNK = 1000;
const chunks = <T>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? null) === (b ?? null);
const sameNum = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a == null || b == null ? (a ?? null) === (b ?? null) : new Decimal(a).eq(new Decimal(b));

interface Existing {
  id: string;
  barcode: string;
  sku: string | null;
  name: string;
  price: string | null;
  supplier: string | null;
  category: string | null;
  account_no: string | null;
  base_unit: string;
  tolerance_pct: string | null;
}

// الاستيراد يُنشئ الصنف أو يحدّثه بحسب الباركود، فتكراره بالملف نفسه آمن (لا يضاعف شيئاً).
// الخلية الفارغة تُبقي القيمة الحالية. معاملة واحدة: إما كل الصفوف الصالحة أو لا شيء.
// Import creates or updates an item by barcode, so re-running the same file is safe (nothing doubles).
// A blank cell keeps the current value. One transaction: all valid rows or nothing.
export const importItems = async (
  deps: ItemDeps,
  actor: Actor,
  csv: string,
  opts: { mode: 'preview' | 'apply'; skipInvalid: boolean },
): Promise<ImportReport> => {
  const parsed = parseItemsCsv(csv);

  return withTenant(deps.db, actor, async ({ trx }) => {
    const existing = new Map<string, Existing>();
    for (const part of chunks(parsed.rows.map((r) => r.barcode))) {
      const found = await trx
        .selectFrom('items')
        .select([
          'id',
          'barcode',
          'sku',
          'name',
          'price',
          'supplier',
          'category',
          'account_no',
          'base_unit',
          'tolerance_pct',
        ])
        .where('barcode', 'in', part)
        .where('deleted_at', 'is', null)
        .execute();
      for (const f of found) existing.set(f.barcode, f);
    }

    // الرمز يجب ألا يخص صنفاً آخر. A code must not belong to a different item.
    const skuOwner = new Map<string, string>();
    for (const part of chunks(parsed.rows.flatMap((r) => (r.sku ? [r.sku.toLowerCase()] : [])))) {
      const found = await trx
        .selectFrom('items')
        .select(['barcode', 'sku'])
        .where(sql<string>`lower(sku)`, 'in', part)
        .where('deleted_at', 'is', null)
        .execute();
      for (const f of found) skuOwner.set(f.sku!.toLowerCase(), f.barcode);
    }

    // الوحدة الأساسية الجديدة ألا تطابق اسم وحدة إضافية للصنف. The new base unit must not equal one of the item's extra units.
    const unitsByItem = new Map<string, string[]>();
    const existingIds = [...existing.values()].map((e) => e.id);
    for (const part of chunks(existingIds)) {
      const us = await trx
        .selectFrom('item_units')
        .select(['item_id', 'name'])
        .where('item_id', 'in', part)
        .execute();
      for (const u of us)
        unitsByItem.set(u.item_id, [...(unitsByItem.get(u.item_id) ?? []), u.name.toLowerCase()]);
    }

    const dbErrors: ImportRowError[] = [];
    const toWrite: { row: ImportRow; existing: Existing | undefined }[] = [];
    let unchanged = 0;
    for (const row of parsed.rows) {
      const cur = existing.get(row.barcode);
      const owner = row.sku ? skuOwner.get(row.sku.toLowerCase()) : undefined;
      if (owner !== undefined && owner !== row.barcode) {
        dbErrors.push({
          line: row.line,
          field: 'sku',
          code: 'SKU_TAKEN',
          message: 'This code belongs to another item',
        });
        continue;
      }
      if (cur && row.baseUnit && unitsByItem.get(cur.id)?.includes(row.baseUnit.toLowerCase())) {
        dbErrors.push({
          line: row.line,
          field: 'baseUnit',
          code: 'BASE_UNIT_CONFLICT',
          message: 'The base unit repeats one of the item units',
        });
        continue;
      }
      if (
        cur &&
        row.name === cur.name &&
        (row.sku === undefined || same(row.sku, cur.sku)) &&
        (row.price === undefined || sameNum(row.price, cur.price)) &&
        (row.supplier === undefined || same(row.supplier, cur.supplier)) &&
        (row.category === undefined || same(row.category, cur.category)) &&
        (row.accountNo === undefined || same(row.accountNo, cur.account_no)) &&
        (row.baseUnit === undefined || row.baseUnit === cur.base_unit) &&
        (row.tolerancePct === undefined || sameNum(row.tolerancePct, cur.tolerance_pct))
      ) {
        unchanged += 1;
        continue;
      }
      toWrite.push({ row, existing: cur });
    }

    const allErrors = [...parsed.errors, ...dbErrors].sort((a, b) => a.line - b.line);
    const report = (counts: Pick<ImportReport, 'created' | 'updated'>): ImportReport => ({
      mode: opts.mode,
      totalRows: parsed.totalRows,
      validRows: toWrite.length + unchanged,
      ...counts,
      unchanged,
      skipped: opts.skipInvalid ? allErrors.length : 0,
      errorsTotal: allErrors.length,
      errors: allErrors.slice(0, IMPORT_ERRORS_CAP),
      errorsTruncated: allErrors.length > IMPORT_ERRORS_CAP,
      ignoredColumns: parsed.ignoredColumns,
    });

    const created = toWrite.filter((w) => !w.existing).length;
    const updated = toWrite.length - created;

    if (opts.mode === 'preview') return report({ created, updated });

    if (allErrors.length > 0 && !opts.skipInvalid)
      throw new AppError(
        'IMPORT_INVALID',
        422,
        'The file has invalid rows; nothing was imported',
        report({ created: 0, updated: 0 }),
      );

    for (const part of chunks(toWrite)) {
      const values = part.map(({ row, existing: cur }) => {
        // دمج القيمة الجديدة مع الحالية في التطبيق كي يُحسب نص البحث من القيم النهائية.
        // Merge new with current in the app so search text is computed from the final values.
        const m = {
          barcode: row.barcode,
          name: row.name,
          sku: row.sku ?? cur?.sku ?? null,
          price: row.price ?? cur?.price ?? null,
          supplier: row.supplier ?? cur?.supplier ?? null,
          category: row.category ?? cur?.category ?? null,
          account_no: row.accountNo ?? cur?.account_no ?? null,
          base_unit: row.baseUnit ?? cur?.base_unit ?? 'قطعة',
          tolerance_pct: row.tolerancePct ?? cur?.tolerance_pct ?? null,
        };
        return {
          id: cur?.id ?? newId(),
          company_id: actor.companyId,
          ...m,
          search_text: searchTextOf({ ...m }),
          created_by: actor.userId,
          updated_by: actor.userId,
          deleted_at: null,
        };
      });
      try {
        await trx
          .insertInto('items')
          .values(values)
          .onConflict((oc) =>
            oc
              .columns(['company_id', 'barcode'])
              .where('deleted_at', 'is', null)
              .doUpdateSet((eb) => ({
                name: eb.ref('excluded.name'),
                sku: eb.ref('excluded.sku'),
                search_text: eb.ref('excluded.search_text'),
                price: eb.ref('excluded.price'),
                supplier: eb.ref('excluded.supplier'),
                category: eb.ref('excluded.category'),
                account_no: eb.ref('excluded.account_no'),
                base_unit: eb.ref('excluded.base_unit'),
                tolerance_pct: eb.ref('excluded.tolerance_pct'),
                version: sql`items.version + 1`,
                updated_at: sql`now()`,
                updated_by: eb.ref('excluded.updated_by'),
              })),
          )
          .execute();
      } catch (err) {
        // سباق نادر: رمز أُخذ بعد الفحص. A rare race: a code taken after the check.
        if ((err as { code?: string }).code === '23505')
          throw new AppError('IMPORT_CONFLICT', 409, 'A concurrent change conflicts; retry');
        throw err;
      }
    }
    return report({ created, updated });
  });
};
