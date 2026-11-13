// واجهة وحدة قاعدة البيانات الوحيدة: لا يستورد غيرها من ملفاتها الداخلية.
// The database module's only public surface: nothing imports its internal files directly.
export { createDb, newId } from './client';
export { runMigrations } from './migrate';
export type { MigrationResult } from './migrate';
export { lookupCompanyId, withTenant } from './tenant';
export type { TenantContext } from './tenant';
export type { Company, Database, NewUser, User, UserUpdate } from './schema';
