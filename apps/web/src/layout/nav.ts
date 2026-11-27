import type { Permission } from '@inventory/shared';

// عناصر القائمة: تُضاف هنا مع كل شاشة جديدة، وتظهر حسب الصلاحية فقط.
// Menu items: added here with each new screen, shown by permission only.
export interface NavItem {
  to: string;
  labelKey: string;
  permission?: Permission;
}
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home' },
  { to: '/warehouses', labelKey: 'nav.warehouses', permission: 'inventory.warehouse.read' },
  { to: '/items', labelKey: 'nav.items', permission: 'inventory.item.read' },
];
