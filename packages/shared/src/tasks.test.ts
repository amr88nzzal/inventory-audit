import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  canTransition,
  createTaskSchema,
  isEditable,
  taskListQuerySchema,
  updateTaskSchema,
} from './tasks';

const wh = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('task transitions', () => {
  it('allows only the documented moves', () => {
    expect(canTransition('draft', 'in_progress')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'closed')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
    expect(canTransition('draft', 'closed')).toBe(false);
    expect(canTransition('in_progress', 'draft')).toBe(false);
  });

  it('terminal states move nowhere', () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition('closed', to)).toBe(false);
      expect(canTransition('cancelled', to)).toBe(false);
    }
  });

  it('only a draft is editable', () => {
    expect(TASK_STATUSES.filter(isEditable)).toEqual(['draft']);
  });
});

describe('task schemas', () => {
  it('applies defaults and rejects a client companyId (strict)', () => {
    const ok = createTaskSchema.parse({ title: ' جرد الربع ', warehouseId: wh });
    expect(ok).toMatchObject({
      title: 'جرد الربع',
      assigneeIds: [],
      blindCount: false,
      aggregateLocations: true,
    });
    expect(createTaskSchema.safeParse({ title: 'x', warehouseId: wh, companyId: wh }).success).toBe(
      false,
    );
  });

  it('rejects duplicate assignees, a bad date and a blank title', () => {
    expect(
      createTaskSchema.safeParse({ title: 'x', warehouseId: wh, assigneeIds: [wh, wh] }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({ title: 'x', warehouseId: wh, startsAt: 'tomorrow' }).success,
    ).toBe(false);
    expect(createTaskSchema.safeParse({ title: '  ', warehouseId: wh }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({
        title: 'x',
        warehouseId: wh,
        startsAt: '2026-12-01T08:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('update needs the version and at least one field; the warehouse cannot change', () => {
    expect(updateTaskSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ version: 1, warehouseId: wh }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ version: 1, startsAt: null, notes: null }).success).toBe(
      true,
    );
  });

  it('list query defaults to newest first and validates the status', () => {
    expect(taskListQuerySchema.parse({})).toMatchObject({ sort: 'taskNo', dir: 'desc', page: 1 });
    expect(taskListQuerySchema.safeParse({ status: 'weird' }).success).toBe(false);
  });
});
