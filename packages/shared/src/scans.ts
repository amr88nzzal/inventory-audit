import { z } from 'zod';
import { paginationSchema } from './pagination';
import { DECIMAL_PATTERN } from './units';

// حدّ الدفعة: يكفي لتفريغ طابور دون اتصال على دفعات دون إثقال الطلب الواحد.
// Batch cap: enough to drain an offline queue in chunks without making one request heavy.
export const SCAN_BATCH_MAX = 200;

const eventId = z.uuid();
const scannedAt = z.iso.datetime({ offset: true });
const note = z.string().trim().min(1).max(200);

const countEvent = z
  .object({
    id: eventId,
    kind: z.literal('count'),
    barcode: z.string().regex(/^[^\s\p{Cc}]{1,64}$/u),
    // الكمية موجبة. A positive quantity.
    quantity: z
      .string()
      .regex(DECIMAL_PATTERN)
      .refine((v) => Number(v) > 0, { message: 'Quantity must be positive' }),
    unitId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    scannedAt,
    note: note.optional(),
  })
  .strict();

// الإلغاء سجل جديد يشير إلى سجل عدّ سابق ولا يعدّله. A void is a new record pointing at an earlier count; it never edits it.
const voidEvent = z
  .object({
    id: eventId,
    kind: z.literal('void'),
    voidsId: z.uuid(),
    scannedAt,
    note: note.optional(),
  })
  .strict();

export const scanEventSchema = z.discriminatedUnion('kind', [countEvent, voidEvent]);
export const scanBatchSchema = z
  .object({ events: z.array(scanEventSchema).min(1).max(SCAN_BATCH_MAX) })
  .strict()
  .refine((b) => new Set(b.events.map((e) => e.id)).size === b.events.length, {
    message: 'Duplicate event ids in one batch',
  });

export const scanListQuerySchema = paginationSchema.extend({
  kind: z.enum(['count', 'void']).optional(),
  // فقط للمالك read_all: سجلات مستخدم بعينه. Only for read_all holders: one user's records.
  userId: z.uuid().optional(),
});

export type ScanEvent = z.infer<typeof scanEventSchema>;
export type ScanBatch = z.infer<typeof scanBatchSchema>;
export type ScanListQuery = z.infer<typeof scanListQuerySchema>;
