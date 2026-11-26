import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// أنواع الجداول بيد بدل توليدها، فهي قليلة الآن. تُحدَّث مع كل تهجيرة.
// Table types are hand-written (few tables for now) and updated with every migration.

// عمود وقت له قيمة افتراضية: يُقرأ Date، ويُدخَل اختيارياً، ويُحدَّث بقيمة.
// A timestamp column with a database default: read as Date, optional on insert, set on update.
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

interface AuditColumns {
  version: Generated<number>;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
}

export interface CompaniesTable extends AuditColumns {
  id: string;
  name: string;
  /** رمز الدخول (إلزامي). Login code (mandatory). */
  code: string;
  /** شركة تجريبية ببيانات وهمية. A demo company with fake data. */
  is_demo: Generated<boolean>;
}

export interface UsersTable extends AuditColumns {
  id: string;
  company_id: string;
  username: string;
  display_name: string;
  active: Generated<boolean>;
  password_hash: string | null;
  must_change_password: Generated<boolean>;
  password_changed_at: Date | null;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
}

export interface SessionsTable {
  id: string;
  company_id: string;
  user_id: string;
  user_agent: string | null;
  created_at: DefaultedTimestamp;
  last_used_at: DefaultedTimestamp;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: 'logout' | 'logout_all' | 'reuse' | 'password_changed' | null;
}

export interface RefreshTokensTable {
  id: string;
  company_id: string;
  session_id: string;
  token_hash: string;
  created_at: DefaultedTimestamp;
  expires_at: Date;
  used_at: Date | null;
}

export interface RolesTable extends AuditColumns {
  id: string;
  company_id: string;
  code: string | null;
  name: string;
  description: string | null;
  is_system: Generated<boolean>;
}

export interface RolePermissionsTable {
  role_id: string;
  company_id: string;
  permission: string;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
  company_id: string;
  created_at: DefaultedTimestamp;
  created_by: string | null;
}

export interface WarehousesTable extends AuditColumns {
  id: string;
  company_id: string;
  code: string;
  name: string;
  search_text: string;
  active: Generated<boolean>;
}

export interface LocationsTable extends AuditColumns {
  id: string;
  company_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  active: Generated<boolean>;
}

export interface AuditTaskCountersTable {
  company_id: string;
  last_no: Generated<number>;
}

export interface AuditTasksTable extends AuditColumns {
  id: string;
  company_id: string;
  task_no: number;
  title: string;
  warehouse_id: string;
  status: Generated<'draft' | 'in_progress' | 'closed' | 'cancelled'>;
  starts_at: Date | null;
  blind_count: Generated<boolean>;
  aggregate_locations: Generated<boolean>;
  notes: string | null;
  started_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  balances_uploaded_at: Date | null;
  balances_uploaded_by: string | null;
  balances_count: Generated<number>;
  tolerance_pct: string | null;
  closed_by: string | null;
  closing_note: string | null;
}

export interface AuditTaskResultsTable {
  task_id: string;
  item_id: string;
  company_id: string;
  counted: string;
  theoretical: string;
  difference: string;
  difference_pct: string | null;
  status: 'match' | 'over' | 'short';
  applied_tolerance_pct: string;
  flagged_for_recount: boolean;
  locations: ColumnType<
    { locationId: string | null; counted: string }[] | null,
    string | null,
    never
  >;
}

export interface AuditTaskUnknownTable {
  task_id: string;
  barcode: string;
  company_id: string;
  quantity: string;
  records: number;
}

export interface IdempotencyKeysTable {
  company_id: string;
  user_id: string;
  key: string;
  request_hash: string;
  response: unknown;
  created_at: DefaultedTimestamp;
}

export interface AuditRecordsTable {
  id: string;
  company_id: string;
  task_id: string;
  user_id: string;
  kind: 'count' | 'void';
  location_id: string | null;
  item_id: string | null;
  barcode: string | null;
  quantity: string | null;
  unit_id: string | null;
  base_quantity: string | null;
  voids_id: string | null;
  note: string | null;
  scanned_at: Date;
  received_at: DefaultedTimestamp;
}

export interface AuditTaskBalancesTable {
  task_id: string;
  item_id: string;
  company_id: string;
  quantity: string;
}

export interface AuditTaskAssigneesTable {
  task_id: string;
  user_id: string;
  company_id: string;
  created_at: DefaultedTimestamp;
  created_by: string | null;
}

export interface UserWarehousesTable {
  user_id: string;
  warehouse_id: string;
  company_id: string;
  created_at: DefaultedTimestamp;
  created_by: string | null;
}

export interface ItemsTable extends AuditColumns {
  id: string;
  company_id: string;
  barcode: string;
  sku: string | null;
  name: string;
  search_text: string;
  /** numeric يعود نصاً من pg (لا number). numeric comes back from pg as a string (never number). */
  price: string | null;
  supplier: string | null;
  category: string | null;
  account_no: string | null;
  base_unit: Generated<string>;
  tolerance_pct: string | null;
  active: Generated<boolean>;
}

export interface ItemUnitsTable {
  id: string;
  company_id: string;
  item_id: string;
  name: string;
  factor: string;
  created_at: DefaultedTimestamp;
  created_by: string | null;
}

export interface PlatformAdminsTable {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  must_change_password: Generated<boolean>;
  active: Generated<boolean>;
  token_version: Generated<number>;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  totp_secret_enc: string | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | null;
  last_login_at: Date | null;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
}

export interface Database {
  companies: CompaniesTable;
  users: UsersTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  warehouses: WarehousesTable;
  locations: LocationsTable;
  user_warehouses: UserWarehousesTable;
  items: ItemsTable;
  item_units: ItemUnitsTable;
  audit_task_counters: AuditTaskCountersTable;
  audit_tasks: AuditTasksTable;
  audit_task_assignees: AuditTaskAssigneesTable;
  audit_task_balances: AuditTaskBalancesTable;
  audit_records: AuditRecordsTable;
  audit_task_results: AuditTaskResultsTable;
  audit_task_unknown: AuditTaskUnknownTable;
  idempotency_keys: IdempotencyKeysTable;
  platform_admins: PlatformAdminsTable;
}

export type Company = Selectable<CompaniesTable>;
export type NewUser = Insertable<UsersTable>;
export type User = Selectable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
