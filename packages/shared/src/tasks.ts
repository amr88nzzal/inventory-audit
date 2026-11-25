import { z } from 'zod';
import { paginationSchema } from './pagination';

export const TASK_STATUSES = ['draft', 'in_progress', 'closed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// الانتقالات المسموحة؛ الإغلاق يأتي مع المرحلة 3د. Allowed transitions; closing arrives with phase 3d.
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
