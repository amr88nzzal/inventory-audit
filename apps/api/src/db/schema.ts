import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// أنواع الجداول بيد بدل توليدها، فهي قليلة الآن. تُحدَّث مع كل تهجيرة.
// Table types are hand-written (few tables for now) and updated with every migration.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

interface AuditColumns {
  version: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: Date | null;
}

export interface CompaniesTable extends AuditColumns {
  id: string;
  name: string;
}

export interface UsersTable extends AuditColumns {
  id: string;
  company_id: string;
  username: string;
  display_name: string;
  active: Generated<boolean>;
}

export interface Database {
  companies: CompaniesTable;
  users: UsersTable;
}

export type Company = Selectable<CompaniesTable>;
export type NewUser = Insertable<UsersTable>;
export type User = Selectable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
