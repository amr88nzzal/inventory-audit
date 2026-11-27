export interface Warehouse {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: string;
}
export interface Location {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}
export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
// حالة القائمة كلها في الـ URL. The whole list state lives in the URL.
export interface WarehouseSearch {
  page: number;
  q: string;
  active: '' | 'true' | 'false';
  sort: 'code' | 'name' | 'createdAt';
  dir: 'asc' | 'desc';
}
export const parseWarehouseSearch = (raw: Record<string, unknown>): WarehouseSearch => {
  // الراوتر يفكّ قيم الـ URL كـ JSON (false → منطقي، 123 → رقم)، فنعيدها نصوصاً قبل الفحص.
  // The router JSON-decodes URL values (false → boolean, 123 → number), so we stringify before checking.
  const str = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  const page = Number(raw['page']);
  const sort = raw['sort'];
  const active = str(raw['active']);
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    q: str(raw['q']).slice(0, 100),
    active: active === 'true' || active === 'false' ? active : '',
    sort: sort === 'name' || sort === 'createdAt' ? sort : 'code',
    dir: raw['dir'] === 'desc' ? 'desc' : 'asc',
  };
};
