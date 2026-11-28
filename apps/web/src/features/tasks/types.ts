export const TASK_STATUSES = ['draft', 'in_progress', 'closed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  taskNo: number;
  title: string;
  warehouseId: string;
  warehouseName: string;
  status: TaskStatus;
  startsAt: string | null;
  blindCount: boolean;
  aggregateLocations: boolean;
  tolerancePct: string | null;
  notes: string | null;
  closingNote: string | null;
  startedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  balancesCount: number;
  balancesUploadedAt: string | null;
  assignees: { userId: string; displayName: string }[];
  version: number;
  createdAt: string;
}

export interface TaskSearch {
  page: number;
  q: string;
  status: '' | TaskStatus;
  warehouseId: string;
  sort: 'taskNo' | 'startsAt' | 'createdAt';
  dir: 'asc' | 'desc';
}

// الراوتر يفكّ قيم الـ URL كـ JSON (رقم المهمة 12 يصير رقماً)، فنعيدها نصوصاً قبل الفحص.
// The router JSON-decodes URL values (task no. 12 becomes a number), so we stringify first.
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseTaskSearch = (raw: Record<string, unknown>): TaskSearch => {
  const page = Number(raw['page']);
  const status = str(raw['status']);
  const sort = str(raw['sort']);
  const wh = str(raw['warehouseId']);
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    q: str(raw['q']).slice(0, 100),
    status: (TASK_STATUSES as readonly string[]).includes(status) ? (status as TaskStatus) : '',
    warehouseId: UUID.test(wh) ? wh : '',
    sort: sort === 'startsAt' || sort === 'createdAt' ? sort : 'taskNo',
    dir: raw['dir'] === 'asc' ? 'asc' : 'desc',
  };
};
