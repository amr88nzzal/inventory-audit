export interface Item {
  id: string;
  barcode: string;
  sku: string | null;
  name: string;
  price: string | null;
  supplier: string | null;
  category: string | null;
  accountNo: string | null;
  baseUnit: string;
  tolerancePct: string | null;
  active: boolean;
  version: number;
  units: { name: string; factor: string }[];
  createdAt: string;
}
export interface ItemSearch {
  page: number;
  q: string;
  category: string;
  supplier: string;
  active: '' | 'true' | 'false';
  sort: 'name' | 'barcode' | 'createdAt' | 'price';
  dir: 'asc' | 'desc';
}
// الراوتر يفكّ قيم الـ URL كـ JSON، فنعيدها نصوصاً قبل الفحص (باركود 123 يصير رقماً).
// The router JSON-decodes URL values, so we stringify first (barcode 123 becomes a number).
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
export const parseItemSearch = (raw: Record<string, unknown>): ItemSearch => {
  const page = Number(raw['page']);
  const active = str(raw['active']);
  const sort = str(raw['sort']);
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    q: str(raw['q']).slice(0, 100),
    category: str(raw['category']).slice(0, 120),
    supplier: str(raw['supplier']).slice(0, 120),
    active: active === 'true' || active === 'false' ? active : '',
    sort: sort === 'barcode' || sort === 'createdAt' || sort === 'price' ? sort : 'name',
    dir: raw['dir'] === 'desc' ? 'desc' : 'asc',
  };
};
