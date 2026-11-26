import type { QueuedOp } from '@inventory/shared';
import { ApiError } from './api';

// أحداث المسح: تحويل عملية الطابور إلى حدث للخادم وإرساله. معرّف العملية هو معرّف الحدث (UUID)،
// فإعادة الإرسال بعد انقطاع أو إغلاق التطبيق لا تُكرّر العدّ.
// Scan events: turn a queue op into a server event and send it. The op id is the event id (a UUID),
// so a resend after a drop or an app restart never double-counts.
export interface ScanPayload {
  taskId: string;
  barcode: string;
  // نص عشري موجب. A positive decimal string.
  quantity: string;
  scannedAt: string;
  locationId?: string;
  unitId?: string;
}
export const SCAN_KIND = 'scan';

export const buildScanOp = (input: {
  id: string;
  taskId: string;
  barcode: string;
  quantity: string;
  now: number;
  locationId?: string;
  unitId?: string;
}): { id: string; kind: string; payload: ScanPayload } => ({
  id: input.id,
  kind: SCAN_KIND,
  payload: {
    taskId: input.taskId,
    barcode: input.barcode,
    quantity: input.quantity,
    scannedAt: new Date(input.now).toISOString(),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.unitId ? { unitId: input.unitId } : {}),
  },
});

// يقبل الأرقام العربية والفاصلة العربية؛ يعيد null لما لا يصلح كمية موجبة (حتى 3 منازل).
// Accepts Arabic digits and the Arabic comma; returns null for anything that is not a positive quantity (up to 3 decimals).
export const parseQuantity = (text: string): string | null => {
  const t = text
    .trim()
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٫,،]/g, '.');
  if (!/^\d{1,12}(\.\d{1,3})?$/.test(t)) return null;
  return Number(t) > 0 ? t : null;
};

interface ScanResultRow {
  id: string;
  status: 'created' | 'duplicate' | 'rejected';
  code?: string;
  message?: string;
}
export interface ScanTransport {
  post: <T>(path: string, body: unknown) => Promise<T>;
}

// المقبول أو المكرر = تم. المرفوض منطقياً يُرمى كخطأ 422 فيُركَن كفاشل ولا يُعاد تلقائياً.
// created/duplicate = done. A logical rejection is thrown as 422 so it is parked as failed, never retried automatically.
export const sendScanOp = async (api: ScanTransport, op: QueuedOp): Promise<void> => {
  const p = op.payload as ScanPayload;
  const rows = await api.post<ScanResultRow[]>(`/tasks/${p.taskId}/scans`, {
    events: [
      {
        id: op.id,
        kind: 'count',
        barcode: p.barcode,
        quantity: p.quantity,
        scannedAt: p.scannedAt,
        ...(p.locationId ? { locationId: p.locationId } : {}),
        ...(p.unitId ? { unitId: p.unitId } : {}),
      },
    ],
  });
  const row = rows.find((r) => r.id === op.id);
  if (!row) throw new ApiError(502, 'BAD_RESPONSE', 'Missing result for the event');
  if (row.status === 'rejected')
    throw new ApiError(422, row.code ?? 'REJECTED', row.message ?? 'Rejected');
};
