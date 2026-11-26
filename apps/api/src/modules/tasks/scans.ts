import { offsetOf, pageMeta, toBaseQuantity } from '@inventory/shared';
import type { PageMeta, ScanBatch, ScanEvent, ScanListQuery } from '@inventory/shared';
import { withTenant } from '../../db';
import { AppError } from '../../errors';
import { loadVisible } from './service';
import type { Actor, TaskDeps, Trx } from './service';

export type ScanStatus = 'created' | 'duplicate' | 'rejected';
export interface ScanResult {
  id: string;
  status: ScanStatus;
  code?: string;
  message?: string;
  // يُعاد للعدّ المقبول: هل الباركود مجهول (يحتاج مراجعة). For an accepted count: is the barcode unknown (needs review).
  unknownItem?: boolean;
}

export interface ScanView {
  id: string;
  kind: 'count' | 'void';
  userId: string;
  userName: string;
  barcode: string | null;
  itemId: string | null;
  itemName: string | null;
  quantity: string | null;
  unitName: string | null;
  baseQuantity: string | null;
  locationCode: string | null;
  voidsId: string | null;
  voided: boolean;
  note: string | null;
  scannedAt: string;
  receivedAt: string;
}

const reject = (id: string, code: string, message: string): ScanResult => ({
  id,
  status: 'rejected',
  code,
  message,
});

// مقارنة الحمولة لتمييز إعادة الإرسال الحقيقية من إعادة استعمال المعرّف لحدث مختلف.
// Payload comparison tells a genuine replay apart from the same id reused for a different event.
const sameInstant = (a: Date, b: string): boolean => a.getTime() === new Date(b).getTime();

// يعالج حدثاً واحداً داخل معاملة الدفعة. لا يرمي للرفض المنطقي كي لا تفشل بقية الدفعة.
// Handles one event inside the batch transaction. Logical rejections are returned, not thrown, so the rest of the batch survives.
const handleEvent = async (
  trx: Trx,
  actor: Actor,
  task: { id: string; warehouse_id: string },
  e: ScanEvent,
): Promise<ScanResult> => {
  let itemId: string | null = null;
  let quantity: string | null = null;
  let unitId: string | null = null;
  let baseQuantity: string | null = null;
  let locationId: string | null = null;
  let barcode: string | null = null;
  let voidsId: string | null = null;
  let unknownItem = false;
  let round = 1;

  if (e.kind === 'void') {
    const target = await trx
      .selectFrom('audit_records')
      .select(['id', 'kind', 'user_id'])
      .where('id', '=', e.voidsId)
      .where('task_id', '=', task.id)
      .executeTakeFirst();
    // يُلغى العدّ الخاص بالمستخدم نفسه فقط؛ غيره كأنه غير موجود. Only your own counts can be voided; others look absent.
    if (!target || target.user_id !== actor.userId)
      return reject(e.id, 'VOID_TARGET_NOT_FOUND', 'Record to void not found');
    if (target.kind !== 'count')
      return reject(e.id, 'VOID_TARGET_INVALID', 'Only a count can be voided');
    const already = await trx
      .selectFrom('audit_records')
      .select('id')
      .where('voids_id', '=', e.voidsId)
      .executeTakeFirst();
    if (already && already.id !== e.id)
      return reject(e.id, 'ALREADY_VOIDED', 'This record is already voided');
    voidsId = e.voidsId;
  } else {
    barcode = e.barcode;
    const item = await trx
      .selectFrom('items')
      .select('id')
      .where('barcode', '=', e.barcode)
      .where('deleted_at', 'is', null)
      .where('active', '=', true)
      .executeTakeFirst();
    itemId = item?.id ?? null;
    unknownItem = itemId === null;
    // صنف عليه إعادة عدّ: لا يعدّه إلا المراجع المسند، وتُسجَّل في جولته. An item under recount: only the assigned reviewer counts it, in its round.
    if (itemId) {
      const rc = await trx
        .selectFrom('audit_recounts')
        .select(['round', 'assignee_id'])
        .where('task_id', '=', task.id)
        .where('item_id', '=', itemId)
        .orderBy('round', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (rc) {
        // إعادة إرسال حدث محفوظ سابقاً ليست مخالفة، فتمرّ لمسار التكرار. Replaying an already stored event is not a violation; it falls through to the duplicate path.
        const stored = await trx
          .selectFrom('audit_records')
          .select('id')
          .where('id', '=', e.id)
          .executeTakeFirst();
        if (!stored) {
          if (rc.assignee_id !== actor.userId)
            return reject(
              e.id,
              'RECOUNT_RESTRICTED',
              'This item is under recount by another reviewer',
            );
          round = rc.round;
        }
      }
    }
    let factor = '1';
    if (e.unitId) {
      if (!itemId)
        return reject(e.id, 'UNIT_NOT_ALLOWED', 'A unit cannot be used with an unknown barcode');
      const unit = await trx
        .selectFrom('item_units')
        .select(['id', 'factor'])
        .where('id', '=', e.unitId)
        .where('item_id', '=', itemId)
        .executeTakeFirst();
      if (!unit) return reject(e.id, 'INVALID_UNIT', 'The unit does not belong to this item');
      unitId = unit.id;
      factor = unit.factor;
    }
    if (e.locationId) {
      const loc = await trx
        .selectFrom('locations')
        .select('id')
        .where('id', '=', e.locationId)
        .where('warehouse_id', '=', task.warehouse_id)
        .where('active', '=', true)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!loc)
        return reject(
          e.id,
          'INVALID_LOCATION',
          'The location does not belong to the task warehouse',
        );
      locationId = loc.id;
    }
    quantity = e.quantity;
    baseQuantity = toBaseQuantity(e.quantity, factor);
  }

  const inserted = await trx
    .insertInto('audit_records')
    .values({
      id: e.id,
      company_id: actor.companyId,
      task_id: task.id,
      user_id: actor.userId,
      kind: e.kind,
      location_id: locationId,
      item_id: itemId,
      barcode,
      quantity,
      unit_id: unitId,
      base_quantity: baseQuantity,
      voids_id: voidsId,
      round,
      note: e.note ?? null,
      scanned_at: new Date(e.scannedAt),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted)
    return { id: e.id, status: 'created', ...(e.kind === 'count' ? { unknownItem } : {}) };

  // المعرّف موجود: إعادة إرسال مطابقة = مكرر ناجح، وإلا المعرّف مُعاد استعماله.
  // The id exists: an identical payload is a successful duplicate; otherwise the id was reused.
  const prev = await trx
    .selectFrom('audit_records')
    .selectAll()
    .where('id', '=', e.id)
    .executeTakeFirst();
  const same =
    prev &&
    prev.task_id === task.id &&
    prev.user_id === actor.userId &&
    prev.kind === e.kind &&
    prev.barcode === barcode &&
    prev.item_id === itemId &&
    prev.unit_id === unitId &&
    prev.location_id === locationId &&
    prev.voids_id === voidsId &&
    (prev.quantity === null
      ? quantity === null
      : quantity !== null && Number(prev.quantity) === Number(quantity)) &&
    sameInstant(prev.scanned_at, e.scannedAt);
  if (same) return { id: e.id, status: 'duplicate' };
  return reject(
    e.id,
    'IDEMPOTENCY_KEY_REUSED',
    'This event id was already used for a different event',
  );
};

// استقبال دفعة أحداث مسح. المهمة قيد التنفيذ والمستخدم من مسندَيها، وإلا 409/404.
// Ingest a batch of scan events. The task must be running and the user an assignee, else 409/404.
export const submitScans = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  batch: ScanBatch,
): Promise<ScanResult[]> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    // seeAll=false: التسجيل للمسندين فقط حتى لو كان للمستخدم read_all. Scanning is for assignees even if the user has read_all.
    const task = await loadVisible(trx, actor, taskId, false);
    if (task.status !== 'in_progress')
      throw new AppError('TASK_NOT_RUNNING', 409, 'The task is not in progress', {
        status: task.status,
      });
    const results: ScanResult[] = [];
    // بالتسلسل: إلغاء داخل الدفعة يرى العدّ الذي قبله. Sequential: a void in the batch sees the count before it.
    for (const e of batch.events) results.push(await handleEvent(trx, actor, task, e));
    return results;
  });

export const listScans = (
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  seeAll: boolean,
  query: ScanListQuery,
): Promise<{ data: ScanView[]; meta: PageMeta }> =>
  withTenant(deps.db, actor, async ({ trx }) => {
    await loadVisible(trx, actor, taskId, seeAll);
    // الموظف يرى سجلاته فقط ولو طلب مستخدماً آخر. A non-privileged user sees only their own records, whatever userId they ask for.
    const userId = seeAll ? query.userId : actor.userId;
    let base = trx.selectFrom('audit_records as r').where('r.task_id', '=', taskId);
    if (userId) base = base.where('r.user_id', '=', userId);
    if (query.kind) base = base.where('r.kind', '=', query.kind);
    const total = Number(
      (await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n,
    );
    const rows = await base
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .leftJoin('items as i', 'i.id', 'r.item_id')
      .leftJoin('item_units as un', 'un.id', 'r.unit_id')
      .leftJoin('locations as l', 'l.id', 'r.location_id')
      .select((eb) => [
        'r.id',
        'r.kind',
        'r.user_id',
        'u.display_name as user_name',
        'r.barcode',
        'r.item_id',
        'i.name as item_name',
        'r.quantity',
        'un.name as unit_name',
        'r.base_quantity',
        'l.code as location_code',
        'r.voids_id',
        'r.note',
        'r.scanned_at',
        'r.received_at',
        eb
          .exists(
            eb.selectFrom('audit_records as v').select('v.id').whereRef('v.voids_id', '=', 'r.id'),
          )
          .as('voided'),
      ])
      .orderBy('r.received_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(query.pageSize)
      .offset(offsetOf(query.page, query.pageSize))
      .execute();
    const data: ScanView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      userId: r.user_id,
      userName: r.user_name,
      barcode: r.barcode,
      itemId: r.item_id,
      itemName: r.item_name,
      quantity: r.quantity,
      unitName: r.unit_name,
      baseQuantity: r.base_quantity,
      locationCode: r.location_code,
      voidsId: r.voids_id,
      voided: Boolean(r.voided),
      note: r.note,
      scannedAt: new Date(r.scanned_at).toISOString(),
      receivedAt: new Date(r.received_at).toISOString(),
    }));
    return { data, meta: pageMeta(query.page, query.pageSize, total) };
  });
