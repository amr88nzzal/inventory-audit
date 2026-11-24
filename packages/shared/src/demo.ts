import type { Permission } from './permissions';

// الشركة التجريبية: حساباتها وكلمة مرورها معروفة عمداً وتُنشر في الدليل، لذلك لا تحوي إلا بيانات وهمية.
// The demo company: its accounts and password are deliberately public (shown in the guide), so it
// holds fake data only.
export const DEMO_COMPANY_CODE = 'demo';
export const DEMO_COMPANY_NAME = 'شركة النور للتجارة (تجريبية)';
export const DEMO_PASSWORD = 'Demo-Inventory-2026';

export interface DemoAccount {
  username: string;
  displayName: string;
  /** null = دور المدير النظامي. null = the system admin role. */
  role: string | null;
  /** رموز المستودعات المسموحة؛ فارغ = كلها. Allowed warehouse codes; empty = all. */
  warehouses?: readonly string[];
}

export interface DemoWarehouse {
  code: string;
  name: string;
  locations: readonly { code: string; name: string }[];
}

// طبقة المرحلة 2: مستودعات ومواقع وهمية. Phase 2 layer: fake warehouses and locations.
export const DEMO_WAREHOUSES: readonly DemoWarehouse[] = [
  {
    code: 'MAIN',
    name: 'المستودع الرئيسي',
    locations: [
      { code: 'A-01', name: 'الواجهة 1' },
      { code: 'A-02', name: 'الواجهة 2' },
      { code: 'B-01', name: 'صالة 1' },
      { code: 'B-02', name: 'صالة 2' },
    ],
  },
  {
    code: 'BR1',
    name: 'مستودع فرع عمّان',
    locations: [
      { code: 'R-01', name: 'رف 1' },
      { code: 'R-02', name: 'رف 2' },
    ],
  },
  { code: 'COLD', name: 'مخزن التبريد', locations: [{ code: 'C-01', name: 'غرفة التبريد' }] },
];

export interface DemoRole {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const DEMO_ROLES: readonly DemoRole[] = [
  {
    name: 'مشرف جرد',
    description: 'يتابع الجرد ويطّلع على الأدوار',
    permissions: ['identity.role.read', 'inventory.warehouse.read'],
  },
  {
    name: 'موظف جرد',
    description: 'ينفّذ العدّ الميداني',
    permissions: ['inventory.warehouse.read'],
  },
];

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { username: 'demo.admin', displayName: 'أحمد المدير', role: null },
  { username: 'demo.supervisor', displayName: 'سارة المشرفة', role: 'مشرف جرد' },
  {
    username: 'demo.auditor1',
    displayName: 'خالد موظف الجرد',
    role: 'موظف جرد',
    warehouses: ['MAIN'],
  },
  {
    username: 'demo.auditor2',
    displayName: 'ليلى موظفة الجرد',
    role: 'موظف جرد',
    warehouses: ['BR1'],
  },
];
