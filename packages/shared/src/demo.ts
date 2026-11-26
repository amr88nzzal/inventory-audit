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
export interface DemoItem {
  barcode: string;
  name: string;
  price: string;
  category: string;
  supplier: string;
  baseUnit?: string;
  units?: readonly { name: string; factor: string }[];
}

// طبقة المرحلة 2ب: أصناف وهمية بباركودات تجريبية (ليست لمنتجات حقيقية).
// Phase 2b layer: fake items with made-up barcodes (not real products).
export const DEMO_ITEMS: readonly DemoItem[] = [
  {
    barcode: '9900000000011',
    name: 'عصير برتقال 1 لتر',
    price: '1.250',
    category: 'مشروبات',
    supplier: 'مصنع الواحة',
    units: [{ name: 'كرتونة', factor: '12' }],
  },
  {
    barcode: '9900000000028',
    name: 'مياه معدنية 500 مل',
    price: '0.250',
    category: 'مشروبات',
    supplier: 'مصنع الواحة',
    units: [
      { name: 'كرتونة', factor: '24' },
      { name: 'باليت', factor: '960' },
    ],
  },
  {
    barcode: '9900000000035',
    name: 'أرز بسمتي 5 كغ',
    price: '7.900',
    category: 'مواد غذائية',
    supplier: 'شركة الحبوب',
    units: [{ name: 'كرتونة', factor: '4' }],
  },
  {
    barcode: '9900000000042',
    name: 'سكر ناعم 1 كغ',
    price: '0.850',
    category: 'مواد غذائية',
    supplier: 'شركة الحبوب',
    units: [{ name: 'كرتونة', factor: '10' }],
  },
  {
    barcode: '9900000000059',
    name: 'زيت ذرة 1.8 لتر',
    price: '4.500',
    category: 'مواد غذائية',
    supplier: 'شركة النخيل',
    units: [{ name: 'كرتونة', factor: '6' }],
  },
  {
    barcode: '9900000000066',
    name: 'منظف أرضيات 2 لتر',
    price: '2.750',
    category: 'منظفات',
    supplier: 'شركة الصفاء',
    units: [{ name: 'كرتونة', factor: '8' }],
  },
  {
    barcode: '9900000000073',
    name: 'مناديل ورقية',
    price: '0.600',
    category: 'منظفات',
    supplier: 'شركة الصفاء',
    units: [{ name: 'صندوق', factor: '40' }],
  },
  {
    barcode: '9900000000080',
    name: 'مفك براغي صغير',
    price: '1.900',
    category: 'أدوات',
    supplier: 'مؤسسة الأدوات',
  },
  {
    barcode: '9900000000097',
    name: 'مطرقة 500 غرام',
    price: '5.250',
    category: 'أدوات',
    supplier: 'مؤسسة الأدوات',
  },
  {
    barcode: '9900000000103',
    name: 'بطارية AA (حبة)',
    price: '0.400',
    category: 'أدوات',
    supplier: 'مؤسسة الأدوات',
    units: [
      { name: 'علبة', factor: '4' },
      { name: 'كرتونة', factor: '48' },
    ],
  },
  {
    barcode: '9900000000110',
    name: 'جبنة مثلثات (علبة)',
    price: '1.100',
    category: 'مبردات',
    supplier: 'شركة الألبان',
    units: [{ name: 'كرتونة', factor: '12' }],
  },
  {
    barcode: '9900000000127',
    name: 'لبن 1 لتر',
    price: '0.950',
    category: 'مبردات',
    supplier: 'شركة الألبان',
    units: [{ name: 'كرتونة', factor: '12' }],
  },
];

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
    permissions: [
      'identity.role.read',
      'inventory.warehouse.read',
      'inventory.item.read',
      'inventory.task.read',
      'inventory.task.read_all',
      'inventory.task.create',
      'inventory.task.update',
      'inventory.task.start',
      'inventory.task.cancel',
      'inventory.task.balances',
    ],
  },
  {
    name: 'موظف جرد',
    description: 'ينفّذ العدّ الميداني',
    permissions: [
      'inventory.warehouse.read',
      'inventory.item.read',
      'inventory.task.read',
      'inventory.task.scan',
    ],
  },
];

// مهمة جرد تجريبية بصيغة مسودة تُسند لموظف المستودع الرئيسي. A demo draft task assigned to the main-warehouse auditor.
export const DEMO_TASK = {
  title: 'جرد المستودع الرئيسي (تجريبي)',
  warehouse: 'MAIN',
  assignee: 'demo.auditor1',
  // لقطة الرصيد النظري التجريبية: أول 5 أصناف بكميات ثابتة. The demo balance snapshot: the first 5 items, fixed quantities.
  balances: ['120', '36', '48', '200', '15.5'],
} as const;

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
