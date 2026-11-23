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
}

export interface DemoRole {
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const DEMO_ROLES: readonly DemoRole[] = [
  {
    name: 'مشرف جرد',
    description: 'يتابع الجرد ويطّلع على الأدوار',
    permissions: ['identity.role.read'],
  },
  { name: 'موظف جرد', description: 'ينفّذ العدّ الميداني', permissions: [] },
];

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { username: 'demo.admin', displayName: 'أحمد المدير', role: null },
  { username: 'demo.supervisor', displayName: 'سارة المشرفة', role: 'مشرف جرد' },
  { username: 'demo.auditor1', displayName: 'خالد موظف الجرد', role: 'موظف جرد' },
  { username: 'demo.auditor2', displayName: 'ليلى موظفة الجرد', role: 'موظف جرد' },
];
