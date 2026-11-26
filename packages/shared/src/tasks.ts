import { z } from 'zod';
import { percentSchema } from './items';
import { paginationSchema } from './pagination';
import { DECIMAL_PATTERN } from './units';

export const TASK_STATUSES = ['draft', 'in_progress', 'closed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// الانتقالات المسموحة. Allowed transitions.
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['in_progress', 'cancelled'],
  in_progress: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};
export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  TRANSITIONS[from].includes(to);

// التعديل (العنوان، المسندون...) ممكن في المسودة فقط؛ بعد البدء تُجمَّد شروط المهمة.
// Editing is draft-only; once started the task terms are frozen.
export const isEditable = (status: TaskStatus): boolean => status === 'draft';

const titleSchema = z.string().trim().min(1).max(160);
const notesSchema = z.string().trim().max(1000);
const assigneesSchema = z
  .array(z.uuid())
  .max(100)
  .refine((l) => new Set(l).size === l.length, { message: 'Duplicate assignees' });
const startsAtSchema = z.iso.datetime({ offset: true });
const versionSchema = z.number().int().positive();

export const createTaskSchema = z
  .object({
    title: titleSchema,
    warehouseId: z.uuid(),
    startsAt: startsAtSchema.optional(),
    assigneeIds: assigneesSchema.default([]),
    blindCount: z.boolean().default(false),
    aggregateLocations: z.boolean().default(true),
    // تفاوت المهمة % (أولوية أدنى من تفاوت الصنف). Task tolerance % (lower priority than the item's).
    tolerancePct: percentSchema.optional(),
    notes: notesSchema.optional(),
  })
  .strict();

// المستودع ثابت بعد الإنشاء (الرصيد النظري واللقطة مبنيان عليه). The warehouse is fixed after creation.
export const updateTaskSchema = z
  .object({
    version: versionSchema,
    title: titleSchema.optional(),
    startsAt: startsAtSchema.nullable().optional(),
    assigneeIds: assigneesSchema.optional(),
    blindCount: z.boolean().optional(),
    aggregateLocations: z.boolean().optional(),
    tolerancePct: percentSchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'Nothing to update' });

export const taskTransitionSchema = z.object({ version: versionSchema }).strict();

export const TASK_SORTS = ['taskNo', 'startsAt', 'createdAt'] as const;
export const taskListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  warehouseId: z.uuid().optional(),
  sort: z.enum(TASK_SORTS).default('taskNo'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const RESULT_SORTS = ['difference', 'name', 'barcode'] as const;
export const RESULT_FILTERS = ['all', 'match', 'over', 'short', 'flagged'] as const;
// tolerancePct: التفاوت الافتراضي حين لا يحدد الصنف تفاوتاً؛ الصفر = أي فرق يُعلَّم. Default tolerance when an item defines none; 0 = flag any difference.
export const taskResultsQuerySchema = paginationSchema.extend({
  filter: z.enum(RESULT_FILTERS).default('all'),
  sort: z.enum(RESULT_SORTS).default('difference'),
  q: z.string().trim().max(100).optional(),
  tolerancePct: z.string().regex(DECIMAL_PATTERN).default('0'),
});
export type TaskResultsQuery = z.infer<typeof taskResultsQuerySchema>;

// الإغلاق: النسخة للقفل المتفائل، وتأكيد صريح إن بقيت أصناف معلَّمة. Close: the version for optimistic locking, and an explicit acknowledgement when flagged items remain.
export const closeTaskSchema = z
  .object({
    version: versionSchema,
    acknowledgeFlagged: z.boolean().default(false),
    note: notesSchema.optional(),
  })
  .strict();
export type CloseTaskInput = z.infer<typeof closeTaskSchema>;

// مفتاح عدم التكرار: ترويسة إلزامية للعمليات الحرجة. The idempotency key: a required header for critical operations.
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,100}$/);

// طلب إعادة العدّ: أصناف محددة أو كل المعلَّم، ومراجع ثانٍ مسند للمهمة. A recount request: chosen items or all flagged ones, and a second reviewer assigned to the task.
export const recountRequestSchema = z
  .object({
    itemIds: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((l) => new Set(l).size === l.length, { message: 'Duplicate items' })
      .optional(),
    flagged: z.literal(true).optional(),
    // التفاوت الافتراضي لتحديد المعلَّم؛ الصفر = أي فرق. Default tolerance deciding what is flagged; 0 = any difference.
    tolerancePct: z.string().regex(DECIMAL_PATTERN).default('0'),
    assigneeId: z.uuid(),
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((v) => (v.itemIds === undefined) !== (v.flagged === undefined), {
    message: 'Provide exactly one of itemIds or flagged',
  });
export type RecountRequestInput = z.infer<typeof recountRequestSchema>;
